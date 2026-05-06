"""Sessions API: upload, estimate, status, retrieve artifacts, workflow, dashboard."""
import logging
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import (
    ArtifactResponse, ArtifactUpdateRequest, BudgetStatusResponse,
    CostBreakdown, CostEstimateResponse,
    DashboardStatsResponse, SessionCreateResponse, SessionListItem,
    SessionStatusResponse, VideoUrlResponse, WorkflowResponse, WorkflowStep,
)
from app.core.config import get_settings
from app.core.db import get_db
from app.models.spend import Artifact, Session as SessionModel, User
from app.services.cost_guard import (
    PostgresSpendStore, enforce_hard_caps, estimate_full_pipeline_cost,
    HardCapExceeded,
)
from app.services.storage import StorageService
from app.services.video_probe import probe_video
from app.workers.celery_app import process_session_task

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/api/sessions", tags=["sessions"])


# Stub auth — auto-creates default dev user
async def get_current_user(db: AsyncSession = Depends(get_db)) -> User:
    result = await db.execute(select(User).where(User.email == "dev@qascribe.local"))
    user = result.scalar_one_or_none()
    if not user:
        user = User(email="dev@qascribe.local", hashed_password="stub")
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


# Helper for artifact counts
async def _count_artifacts(db: AsyncSession, session_id: str) -> dict:
    stmt = (
        select(Artifact.artifact_type, func.count(Artifact.id))
        .where(Artifact.session_id == session_id)
        .group_by(Artifact.artifact_type)
    )
    result = await db.execute(stmt)
    counts = {"test_case": 0, "bug_report": 0, "coverage_gap": 0}
    for atype, count in result.all():
        counts[atype] = count
    return counts


# =====================================================================
#  Estimate (pre-flight)
# =====================================================================

@router.post("/estimate", response_model=CostEstimateResponse)
async def estimate_session_cost(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Pre-flight cost estimate. Saves nothing — probes and calculates."""
    suffix = Path(file.filename or "v.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = Path(tmp.name)

    try:
        info = probe_video(tmp_path)
        try:
            enforce_hard_caps(info.duration_seconds, info.size_bytes)
        except HardCapExceeded as e:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(e))

        estimate = estimate_full_pipeline_cost(
            video_duration_seconds=info.duration_seconds,
            has_voice_track=info.has_audio,
        )

        spend_store = PostgresSpendStore(db)
        user_spend = await spend_store.get_user_month_spend(user.id)

        return CostEstimateResponse(
            duration_seconds=info.duration_seconds,
            has_voice_track=info.has_audio,
            estimated_cost_usd=estimate["total_estimated_usd"],
            estimated_cost_with_safety_margin_usd=estimate["total_with_safety_margin_usd"],
            breakdown=CostBreakdown(
                gemini_usd=estimate["gemini"].estimated_cost_usd,
                stt_usd=estimate["stt"].estimated_cost_usd if estimate["stt"] else 0.0,
                claude_usd=estimate["claude"].estimated_cost_usd,
            ),
            would_exceed_per_job_cap=(
                estimate["total_with_safety_margin_usd"] > settings.PER_JOB_MAX_USD
            ),
            user_monthly_budget_remaining_usd=user.monthly_budget_usd - user_spend,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


# =====================================================================
#  Create / list / get session
# =====================================================================

@router.post("", response_model=SessionCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    title: str = Form(...),
    test_focus: str = Form("exploratory"),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload video, gate on budget, queue processing."""
    suffix = Path(file.filename or "v.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = Path(tmp.name)

    try:
        info = probe_video(tmp_path)
        try:
            enforce_hard_caps(info.duration_seconds, info.size_bytes)
        except HardCapExceeded as e:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(e))

        estimate = estimate_full_pipeline_cost(
            video_duration_seconds=info.duration_seconds,
            has_voice_track=info.has_audio,
        )
        if estimate["total_with_safety_margin_usd"] > settings.PER_JOB_MAX_USD:
            raise HTTPException(
                status.HTTP_402_PAYMENT_REQUIRED,
                f"Estimated cost ${estimate['total_with_safety_margin_usd']:.2f} "
                f"exceeds per-job cap ${settings.PER_JOB_MAX_USD:.2f}",
            )

        spend_store = PostgresSpendStore(db)
        user_spend = await spend_store.get_user_month_spend(user.id)
        if user_spend + estimate["total_with_safety_margin_usd"] > user.monthly_budget_usd:
            raise HTTPException(
                status.HTTP_402_PAYMENT_REQUIRED,
                f"Would exceed monthly budget. Current: ${user_spend:.2f}, "
                f"estimated: ${estimate['total_with_safety_margin_usd']:.2f}, "
                f"budget: ${user.monthly_budget_usd:.2f}",
            )

        global_today = await spend_store.get_global_day_spend()
        if global_today + estimate["total_with_safety_margin_usd"] > settings.GLOBAL_DAILY_BUDGET_USD:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Platform daily budget reached. Try again tomorrow.",
            )

        storage = StorageService()
        s3_key = f"uploads/{user.id}/{uuid.uuid4()}{suffix}"
        storage.upload_file(tmp_path, s3_key)

        session = SessionModel(
            user_id=user.id,
            title=title,
            test_focus=test_focus,
            video_s3_key=s3_key,
            video_duration_seconds=info.duration_seconds,
            video_size_bytes=info.size_bytes,
            has_voice_track=info.has_audio,
            status="queued",
            estimated_cost_usd=estimate["total_estimated_usd"],
        )
        db.add(session)
        await db.commit()
        await db.refresh(session)

        process_session_task.delay(session.id)

        return SessionCreateResponse(
            session_id=session.id,
            status=session.status,
            estimated_cost_usd=session.estimated_cost_usd or 0,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


@router.get("", response_model=list[SessionListItem])
async def list_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
):
    """List sessions for the current user, newest first."""
    stmt = (
        select(SessionModel)
        .where(SessionModel.user_id == user.id)
        .order_by(desc(SessionModel.created_at))
        .limit(limit)
    )
    sessions = (await db.execute(stmt)).scalars().all()

    items = []
    for s in sessions:
        count_stmt = select(func.count(Artifact.id)).where(Artifact.session_id == s.id)
        count = (await db.execute(count_stmt)).scalar() or 0
        items.append(SessionListItem(
            session_id=s.id,
            title=s.title,
            test_focus=s.test_focus,
            status=s.status,
            duration_seconds=s.video_duration_seconds,
            estimated_cost_usd=s.estimated_cost_usd,
            actual_cost_usd=s.actual_cost_usd,
            artifact_count=count,
            created_at=s.created_at,
        ))
    return items


@router.get("/dashboard/stats", response_model=DashboardStatsResponse)
async def dashboard_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Top-level dashboard metrics for the current user."""
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    sess_count_stmt = select(func.count(SessionModel.id)).where(
        SessionModel.user_id == user.id,
        SessionModel.created_at >= month_start,
    )
    sess_count = (await db.execute(sess_count_stmt)).scalar() or 0

    tc_stmt = (
        select(func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "test_case",
        )
    )
    tc_count = (await db.execute(tc_stmt)).scalar() or 0

    bug_stmt = (
        select(func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "bug_report",
        )
    )
    bug_count = (await db.execute(bug_stmt)).scalar() or 0

    hours_saved = (tc_count * settings.MINUTES_SAVED_PER_TESTCASE) // 60

    return DashboardStatsResponse(
        sessions_this_month=sess_count,
        test_cases_generated=tc_count,
        bugs_surfaced=bug_count,
        estimated_hours_saved=hours_saved,
    )


@router.get("/budget/status", response_model=BudgetStatusResponse)
async def get_budget_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    spend_store = PostgresSpendStore(db)
    user_spend = await spend_store.get_user_month_spend(user.id)
    global_today = await spend_store.get_global_day_spend()
    return BudgetStatusResponse(
        user_id=user.id,
        monthly_budget_usd=user.monthly_budget_usd,
        month_to_date_spend_usd=user_spend,
        remaining_usd=user.monthly_budget_usd - user_spend,
        global_today_spend_usd=global_today,
        global_daily_cap_usd=settings.GLOBAL_DAILY_BUDGET_USD,
    )


@router.get("/{session_id}", response_model=SessionStatusResponse)
async def get_session_status(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    counts = await _count_artifacts(db, session_id)

    return SessionStatusResponse(
        session_id=session.id,
        title=session.title,
        test_focus=session.test_focus,
        status=session.status,
        duration_seconds=session.video_duration_seconds,
        estimated_cost_usd=session.estimated_cost_usd,
        actual_cost_usd=session.actual_cost_usd,
        error_message=session.error_message,
        has_voice_track=session.has_voice_track,
        created_at=session.created_at,
        artifact_counts=counts,
    )


@router.post("/{session_id}/retry", response_model=SessionCreateResponse)
async def retry_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-run the pipeline on a session whose previous processing failed.

    Clears any partial artifacts from the prior run, resets session state to
    'queued', and re-enqueues the Celery task. The original video stays in
    storage and is reused — no re-upload required.

    Budget is re-checked inside the worker, so a user who has since exhausted
    their monthly budget will land in 'rejected_budget' as usual.
    """
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    if session.status not in ("failed", "rejected_budget"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot retry a session in '{session.status}' state",
        )

    existing = (await db.execute(
        select(Artifact).where(Artifact.session_id == session_id)
    )).scalars().all()
    for a in existing:
        await db.delete(a)

    session.status = "queued"
    session.error_message = None
    session.actual_cost_usd = None
    await db.commit()

    process_session_task.delay(session.id)

    return SessionCreateResponse(
        session_id=session.id,
        status=session.status,
        estimated_cost_usd=session.estimated_cost_usd or 0,
    )


@router.get("/{session_id}/video", response_model=VideoUrlResponse)
async def get_session_video_url(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    storage = StorageService()
    url = storage.get_presigned_url(session.video_s3_key, expires_in=3600)
    return VideoUrlResponse(url=url, expires_in_seconds=3600)


@router.get("/{session_id}/artifacts", response_model=list[ArtifactResponse])
async def get_session_artifacts(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    result = await db.execute(
        select(Artifact).where(Artifact.session_id == session_id)
    )
    return [
        ArtifactResponse(
            id=a.id, artifact_type=a.artifact_type, content=a.content,
            user_edited=a.user_edited, created_at=a.created_at,
            review_status=a.review_status, reviewed_at=a.reviewed_at,
            reviewed_by_user_id=a.reviewed_by_user_id, review_notes=a.review_notes,
        )
        for a in result.scalars()
    ]


@router.put("/{session_id}/artifacts/{artifact_id}", response_model=ArtifactResponse)
async def update_artifact(
    session_id: str,
    artifact_id: str,
    payload: ArtifactUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Inline edit an artifact. PURE DB UPDATE — does NOT call any AI service."""
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    artifact = await db.get(Artifact, artifact_id)
    if not artifact or artifact.session_id != session_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    artifact.content = payload.content
    artifact.user_edited = True
    await db.commit()
    await db.refresh(artifact)
    return ArtifactResponse(
        id=artifact.id, artifact_type=artifact.artifact_type,
        content=artifact.content, user_edited=artifact.user_edited,
        created_at=artifact.created_at,
        review_status=artifact.review_status, reviewed_at=artifact.reviewed_at,
        reviewed_by_user_id=artifact.reviewed_by_user_id,
        review_notes=artifact.review_notes,
    )


@router.delete("/{session_id}/artifacts/{artifact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_artifact(
    session_id: str,
    artifact_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    artifact = await db.get(Artifact, artifact_id)
    if not artifact or artifact.session_id != session_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    await db.delete(artifact)
    await db.commit()
    return None


@router.get("/{session_id}/workflow", response_model=WorkflowResponse)
async def get_workflow(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Merged time-ordered step-by-step view: actions + voice annotations + anomalies."""
    session = await db.get(SessionModel, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")

    if not session.evidence_bundle:
        return WorkflowResponse(
            session_id=session.id,
            duration_seconds=session.video_duration_seconds,
            steps=[],
        )

    bundle = session.evidence_bundle
    action_log = bundle.get("action_log", {}) or {}
    transcript = bundle.get("voice_transcript", []) or []

    actions = action_log.get("actions", []) if isinstance(action_log, dict) else []
    anomalies = action_log.get("errors_or_anomalies", []) if isinstance(action_log, dict) else []

    # Get bug report artifacts to link anomalies
    bug_stmt = select(Artifact).where(
        Artifact.session_id == session_id,
        Artifact.artifact_type == "bug_report",
    )
    bug_artifacts = (await db.execute(bug_stmt)).scalars().all()

    def parse_timestamp(ts: str) -> float:
        """Parse 'MM:SS' or 'HH:MM:SS' into seconds."""
        if not ts:
            return 0.0
        parts = ts.split(":")
        try:
            if len(parts) == 2:
                return int(parts[0]) * 60 + int(parts[1])
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        except (ValueError, IndexError):
            pass
        return 0.0

    def find_linked_bugs(timestamp_str: str) -> list[str]:
        """Find bug reports whose evidence_timestamps include this ts."""
        linked = []
        for bug in bug_artifacts:
            ev_ts = bug.content.get("evidence_timestamps", []) or []
            if timestamp_str in ev_ts:
                linked.append(bug.id)
        return linked

    # Build merged event list
    events = []
    for a in actions:
        ts_str = a.get("timestamp", "")
        events.append({
            "ts": parse_timestamp(ts_str),
            "ts_str": ts_str,
            "kind": "action",
            "summary": f"{a.get('action_type', 'action').title()} {a.get('target', '')}".strip(),
            "details": a.get("observation", "") or a.get("screen_context", ""),
            "linked_artifact_ids": [],
        })

    for v in transcript:
        if not v.get("text"):
            continue
        events.append({
            "ts": float(v.get("start", 0)),
            "ts_str": "",
            "kind": "voice_annotation",
            "summary": v["text"][:200],
            "details": "Tester narration",
            "linked_artifact_ids": [],
        })

    for an in anomalies:
        ts_str = an.get("timestamp", "")
        events.append({
            "ts": parse_timestamp(ts_str),
            "ts_str": ts_str,
            "kind": "anomaly",
            "summary": "Anomaly: " + an.get("description", "")[:150],
            "details": an.get("description", ""),
            "linked_artifact_ids": find_linked_bugs(ts_str),
        })

    # Sort by timestamp; tie-break: actions first, then anomalies, then voice
    kind_order = {"action": 0, "anomaly": 1, "voice_annotation": 2}
    events.sort(key=lambda e: (e["ts"], kind_order.get(e["kind"], 3)))

    steps = [
        WorkflowStep(
            step_number=i + 1,
            timestamp_seconds=e["ts"],
            kind=e["kind"],
            summary=e["summary"] or "(no summary)",
            details=e["details"] or "",
            linked_artifact_ids=e["linked_artifact_ids"],
        )
        for i, e in enumerate(events)
    ]

    return WorkflowResponse(
        session_id=session.id,
        duration_seconds=session.video_duration_seconds,
        steps=steps,
    )
