"""Celery app for async pipeline execution.

Windows note: prefork pool doesn't work on Windows. We auto-select 'solo'
on Windows. On Linux/macOS, prefork is used (default).
"""
import asyncio
import logging
import sys
import tempfile
from pathlib import Path

from celery import Celery
from sqlalchemy import select, func

from app.core.config import get_settings
from app.core.db import async_session_factory
from app.models.spend import Session as SessionModel, Artifact, User, SpendRecord
from app.services.cost_guard import (
    CostGuard, PostgresSpendStore, BudgetExceeded,
    estimate_full_pipeline_cost,
)
from app.services.gemini_service import GeminiPerceptionService
from app.services.stt_service import STTService
from app.services.synthesis_service import SynthesisService
from app.services.storage import StorageService
from app.services.video_probe import extract_audio_track

logger = logging.getLogger(__name__)
settings = get_settings()


class TransientPipelineError(Exception):
    """Wraps a transient provider error (5xx, 429, timeouts) so Celery's
    autoretry_for can pick it up. The original exception is the cause.
    """


_TRANSIENT_HTTP_CODES = frozenset({408, 429, 500, 502, 503, 504})

_TRANSIENT_CLASS_KEYWORDS = (
    "ratelimit", "timeout", "connection", "servererror",
    "unavailable", "deadlineexceeded", "resourceexhausted",
)

_TRANSIENT_MESSAGE_KEYWORDS = (
    "503", "504", "429",
    "unavailable", "rate limit", "rate-limit",
    "timeout", "timed out", "temporarily",
)


def _is_transient(exc: BaseException) -> bool:
    """Detect transient provider errors across Anthropic / OpenAI / google-genai
    without depending on each SDK's specific exception classes.
    """
    code = (
        getattr(exc, "status_code", None)
        or getattr(exc, "code", None)
        or getattr(getattr(exc, "response", None), "status_code", None)
    )
    if isinstance(code, int) and code in _TRANSIENT_HTTP_CODES:
        return True
    cls = exc.__class__.__name__.lower()
    if any(k in cls for k in _TRANSIENT_CLASS_KEYWORDS):
        return True
    msg = str(exc).lower()
    if any(k in msg for k in _TRANSIENT_MESSAGE_KEYWORDS):
        return True
    return False


celery_app = Celery("qascribe", broker=settings.REDIS_URL, backend=settings.REDIS_URL)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=1800,
    # Windows: prefork pool is broken; use solo. Override at runtime
    # on Linux/macOS with --pool=prefork if you want concurrency.
    worker_pool="solo" if sys.platform == "win32" else "prefork",
)


@celery_app.task(
    name="process_session",
    bind=True,
    autoretry_for=(TransientPipelineError,),
    retry_backoff=2,
    retry_backoff_max=60,
    retry_jitter=True,
    max_retries=2,
)
def process_session_task(self, session_id: str) -> dict:
    return asyncio.run(_process_session_async(
        session_id,
        is_final_attempt=(self.request.retries >= self.max_retries),
    ))


async def _process_session_async(session_id: str, *, is_final_attempt: bool = True) -> dict:
    storage = StorageService()
    gemini = GeminiPerceptionService()
    stt = STTService()
    synth = SynthesisService()

    async with async_session_factory() as db:
        result = await db.execute(
            select(SessionModel).where(SessionModel.id == session_id)
        )
        session = result.scalar_one()
        spend_store = PostgresSpendStore(db)

        user = await db.get(User, session.user_id)
        cost_guard = CostGuard(
            spend_store=spend_store,
            user_id=session.user_id,
            job_id=session.id,
            user_monthly_budget_usd=user.monthly_budget_usd if user else None,
        )

        # Pre-flight budget check
        estimate = estimate_full_pipeline_cost(
            video_duration_seconds=session.video_duration_seconds,
            has_voice_track=session.has_voice_track,
        )
        try:
            await cost_guard.check_pipeline_budget(estimate)
        except BudgetExceeded as e:
            session.status = "rejected_budget"
            session.error_message = str(e)
            await db.commit()
            return {"status": "rejected", "reason": str(e)}

        session.status = "processing"
        session.estimated_cost_usd = estimate["total_estimated_usd"]
        await db.commit()

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            video_local = tmp_path / "video.mp4"
            storage.download_file(session.video_s3_key, video_local)

            try:
                # 1. Gemini perception
                action_log = await gemini.analyze_video(
                    video_path=str(video_local),
                    duration_seconds=session.video_duration_seconds,
                    cost_guard=cost_guard,
                    media_resolution="low",
                )

                # 2. STT if voice track present
                transcript = []
                if session.has_voice_track:
                    audio_local = tmp_path / "audio.mp3"
                    extract_audio_track(video_local, audio_local)
                    transcript = await stt.transcribe(
                        str(audio_local), session.video_duration_seconds, cost_guard,
                    )

                # 3. Build evidence bundle and PERSIST it for workflow view
                evidence = {
                    "session_title": session.title,
                    "duration_seconds": session.video_duration_seconds,
                    "action_log": action_log,
                    "voice_transcript": transcript,
                }
                session.evidence_bundle = evidence
                await db.commit()

                # 4. Synthesis
                artifacts = await synth.generate_artifacts(evidence, cost_guard)

                # 5. Persist artifacts
                for atype, items in artifacts.items():
                    for item in items:
                        # "test_cases" -> "test_case", etc.
                        normalized_type = atype.rstrip("s")
                        if normalized_type == "coverage_gap":
                            normalized_type = "coverage_gap"
                        elif atype == "test_cases":
                            normalized_type = "test_case"
                        elif atype == "bug_reports":
                            normalized_type = "bug_report"
                        elif atype == "coverage_gaps":
                            normalized_type = "coverage_gap"
                        db.add(Artifact(
                            session_id=session.id,
                            artifact_type=normalized_type,
                            content=item,
                        ))

                # 6. Sum actual cost
                cost_result = await db.execute(
                    select(func.sum(SpendRecord.cost_usd)).where(
                        SpendRecord.job_id == session.id
                    )
                )
                session.actual_cost_usd = float(cost_result.scalar() or 0)
                session.status = "completed"
                await db.commit()

                return {
                    "status": "completed",
                    "artifacts_count": sum(len(v) for v in artifacts.values()),
                    "actual_cost_usd": session.actual_cost_usd,
                }

            except Exception as e:
                logger.exception("Session processing failed")
                if _is_transient(e) and not is_final_attempt:
                    # Leave status as "processing" so the user keeps seeing the
                    # progress panel. Celery will autoretry on TransientPipelineError.
                    raise TransientPipelineError(str(e)[:500]) from e
                session.status = "failed"
                session.error_message = str(e)[:1000]
                await db.commit()
                raise
