"""OpenAI Speech-to-Text service for voice annotations.

Default model is whisper-1 because it returns segment-level timestamps,
which Claude needs to align voice annotations to UI actions.

Branches on model:
  - whisper-1 -> verbose_json with timestamp_granularities (timestamps preserved)
  - gpt-4o-*-transcribe -> plain json (text only, no timestamps)
"""
import logging
from openai import AsyncOpenAI

from app.core.config import get_settings
from app.services.cost_guard import (
    ActualCost, CostGuard, Provider, estimate_openai_stt_cost,
)

logger = logging.getLogger(__name__)
settings = get_settings()


class STTService:
    def __init__(self):
        self.client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

    async def transcribe(
        self,
        audio_path: str,
        duration_seconds: float,
        cost_guard: CostGuard,
    ) -> list[dict]:
        """Transcribe an audio file. Returns list of timestamped segments."""
        estimate = estimate_openai_stt_cost(duration_seconds)
        logger.info(
            "STT call: duration=%.0fs estimate=$%.4f model=%s",
            duration_seconds, estimate.estimated_cost_usd, settings.OPENAI_STT_MODEL,
        )

        with open(audio_path, "rb") as f:
            if settings.OPENAI_STT_MODEL == "whisper-1":
                # whisper-1 supports verbose_json with segment timestamps
                response = await self.client.audio.transcriptions.create(
                    model=settings.OPENAI_STT_MODEL,
                    file=f,
                    response_format="verbose_json",
                    timestamp_granularities=["segment"],
                )
            else:
                # gpt-4o-*-transcribe models only support plain json/text
                response = await self.client.audio.transcriptions.create(
                    model=settings.OPENAI_STT_MODEL,
                    file=f,
                    response_format="json",
                )

        # OpenAI STT pricing is per-minute, not per-token. Use estimate as actual.
        await cost_guard.record_actual(ActualCost(
            provider=Provider.OPENAI_STT,
            input_tokens=0,
            output_tokens=0,
            cost_usd=estimate.estimated_cost_usd,
        ))

        # Normalize both response shapes into the same segment list
        segments = getattr(response, "segments", None)
        if segments:
            return [
                {
                    "start": seg.get("start", 0) if isinstance(seg, dict) else seg.start,
                    "end": seg.get("end", 0) if isinstance(seg, dict) else seg.end,
                    "text": seg.get("text", "") if isinstance(seg, dict) else seg.text,
                }
                for seg in segments
            ]
        # Fallback for models without timestamps
        text = getattr(response, "text", "") or ""
        return [{"start": 0.0, "end": 0.0, "text": text}] if text else []
