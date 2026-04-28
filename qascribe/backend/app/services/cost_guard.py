"""Cost control system. ALL AI API calls must go through CostGuard.

Implements 3 of 4 defense layers (the 4th is provider-side, configured in
vendor consoles):

  Layer 1: pre-flight estimation — calculate predicted cost before any API
           call, reject if it would exceed per-job or per-user budget
  Layer 2: hard caps — reject videos longer or larger than configured limits
  Layer 3: spend tracking — record every actual call's cost, enforce monthly
           per-user budgets and daily global budgets

Estimates use upper-bound assumptions and a safety multiplier so we never
under-estimate and over-spend.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Protocol

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.spend import SpendRecord

logger = logging.getLogger(__name__)
settings = get_settings()


class Provider(str, Enum):
    GEMINI = "gemini"
    OPENAI_STT = "openai_stt"
    CLAUDE = "claude"


class BudgetExceeded(Exception):
    def __init__(self, reason: str, estimated_cost_usd: float, limit_usd: float):
        self.reason = reason
        self.estimated_cost_usd = estimated_cost_usd
        self.limit_usd = limit_usd
        super().__init__(
            f"{reason}: estimated ${estimated_cost_usd:.4f} exceeds limit ${limit_usd:.2f}"
        )


class HardCapExceeded(Exception):
    """Layer 2 — upload exceeds size or duration cap."""


@dataclass(frozen=True)
class CostEstimate:
    provider: Provider
    estimated_input_tokens: int
    estimated_output_tokens: int
    estimated_cost_usd: float
    breakdown: dict[str, float]

    @property
    def with_safety_margin(self) -> float:
        return self.estimated_cost_usd * settings.BUDGET_SAFETY_MULTIPLIER


@dataclass(frozen=True)
class ActualCost:
    provider: Provider
    input_tokens: int
    output_tokens: int
    cost_usd: float


class SpendStore(Protocol):
    async def get_user_month_spend(self, user_id: str) -> float: ...
    async def get_global_day_spend(self) -> float: ...
    async def record(self, user_id: str, job_id: str, cost: ActualCost) -> None: ...


# =====================================================================
#  Estimation functions — Layer 1
# =====================================================================

def estimate_gemini_video_cost(
    duration_seconds: float,
    media_resolution: str = "low",
    expected_output_tokens: int = 4000,
) -> CostEstimate:
    if media_resolution == "low":
        video_tokens_per_sec = settings.GEMINI_TOKENS_PER_VIDEO_SECOND_LOW
    else:
        video_tokens_per_sec = settings.GEMINI_TOKENS_PER_VIDEO_SECOND_DEFAULT

    video_tokens = int(duration_seconds * video_tokens_per_sec)
    audio_tokens = int(duration_seconds * settings.GEMINI_AUDIO_TOKENS_PER_SECOND)
    prompt_overhead_tokens = 1000

    input_tokens = video_tokens + audio_tokens + prompt_overhead_tokens

    input_cost = (input_tokens / 1_000_000) * settings.GEMINI_INPUT_PRICE_PER_M
    output_cost = (expected_output_tokens / 1_000_000) * settings.GEMINI_OUTPUT_PRICE_PER_M

    return CostEstimate(
        provider=Provider.GEMINI,
        estimated_input_tokens=input_tokens,
        estimated_output_tokens=expected_output_tokens,
        estimated_cost_usd=input_cost + output_cost,
        breakdown={
            "video_tokens": float(video_tokens),
            "audio_tokens": float(audio_tokens),
            "input_cost_usd": input_cost,
            "output_cost_usd": output_cost,
        },
    )


def estimate_openai_stt_cost(duration_seconds: float) -> CostEstimate:
    minutes = duration_seconds / 60.0
    cost = minutes * settings.OPENAI_STT_PRICE_PER_MINUTE
    return CostEstimate(
        provider=Provider.OPENAI_STT,
        estimated_input_tokens=0,
        estimated_output_tokens=0,
        estimated_cost_usd=cost,
        breakdown={"minutes": minutes, "cost_usd": cost},
    )


def estimate_claude_synthesis_cost(
    evidence_bundle_chars: int,
    expected_output_tokens: int = 8000,
) -> CostEstimate:
    input_tokens = (evidence_bundle_chars // 4) + 2000
    input_cost = (input_tokens / 1_000_000) * settings.CLAUDE_INPUT_PRICE_PER_M
    output_cost = (expected_output_tokens / 1_000_000) * settings.CLAUDE_OUTPUT_PRICE_PER_M
    return CostEstimate(
        provider=Provider.CLAUDE,
        estimated_input_tokens=input_tokens,
        estimated_output_tokens=expected_output_tokens,
        estimated_cost_usd=input_cost + output_cost,
        breakdown={
            "input_cost_usd": input_cost,
            "output_cost_usd": output_cost,
        },
    )


def estimate_full_pipeline_cost(
    video_duration_seconds: float,
    has_voice_track: bool = False,
    media_resolution: str = "low",
) -> dict:
    gemini = estimate_gemini_video_cost(video_duration_seconds, media_resolution)
    stt = estimate_openai_stt_cost(video_duration_seconds) if has_voice_track else None

    estimated_evidence_chars = int(video_duration_seconds * 200)
    claude = estimate_claude_synthesis_cost(estimated_evidence_chars)

    total = gemini.estimated_cost_usd + claude.estimated_cost_usd
    if stt:
        total += stt.estimated_cost_usd
    total_with_margin = total * settings.BUDGET_SAFETY_MULTIPLIER

    return {
        "gemini": gemini,
        "stt": stt,
        "claude": claude,
        "total_estimated_usd": total,
        "total_with_safety_margin_usd": total_with_margin,
    }


# =====================================================================
#  Hard caps — Layer 2
# =====================================================================

def enforce_hard_caps(duration_seconds: float, file_size_bytes: int) -> None:
    if duration_seconds > settings.MAX_VIDEO_DURATION_SECONDS:
        raise HardCapExceeded(
            f"Video duration {duration_seconds:.0f}s exceeds max "
            f"{settings.MAX_VIDEO_DURATION_SECONDS}s"
        )
    size_mb = file_size_bytes / (1024 * 1024)
    if size_mb > settings.MAX_VIDEO_FILE_SIZE_MB:
        raise HardCapExceeded(
            f"File size {size_mb:.1f}MB exceeds max "
            f"{settings.MAX_VIDEO_FILE_SIZE_MB}MB"
        )


# =====================================================================
#  CostGuard orchestrator
# =====================================================================

class CostGuard:
    def __init__(self, spend_store: SpendStore, user_id: str, job_id: str,
                 user_monthly_budget_usd: float | None = None):
        self.spend_store = spend_store
        self.user_id = user_id
        self.job_id = job_id
        self.user_budget = (
            user_monthly_budget_usd or settings.DEFAULT_USER_MONTHLY_BUDGET_USD
        )

    async def check_pipeline_budget(self, pipeline_estimate: dict) -> None:
        cost_with_margin = pipeline_estimate["total_with_safety_margin_usd"]

        if cost_with_margin > settings.PER_JOB_MAX_USD:
            raise BudgetExceeded(
                "Per-job budget exceeded", cost_with_margin, settings.PER_JOB_MAX_USD
            )

        user_spend = await self.spend_store.get_user_month_spend(self.user_id)
        if user_spend + cost_with_margin > self.user_budget:
            raise BudgetExceeded(
                f"User monthly budget exceeded (current spend: ${user_spend:.2f})",
                cost_with_margin,
                self.user_budget - user_spend,
            )

        global_today = await self.spend_store.get_global_day_spend()
        if global_today + cost_with_margin > settings.GLOBAL_DAILY_BUDGET_USD:
            raise BudgetExceeded(
                f"Platform daily budget circuit breaker (today's spend: ${global_today:.2f})",
                cost_with_margin,
                settings.GLOBAL_DAILY_BUDGET_USD - global_today,
            )

        logger.info(
            "Budget check passed: job=%s user=%s estimated=$%.4f user_remaining=$%.2f",
            self.job_id, self.user_id, cost_with_margin,
            self.user_budget - user_spend,
        )

    async def record_actual(self, actual: ActualCost) -> None:
        await self.spend_store.record(self.user_id, self.job_id, actual)
        logger.info(
            "Recorded spend: job=%s provider=%s cost=$%.4f",
            self.job_id, actual.provider.value, actual.cost_usd,
        )


class PostgresSpendStore:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_user_month_spend(self, user_id: str) -> float:
        now = datetime.now(timezone.utc)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        stmt = select(func.coalesce(func.sum(SpendRecord.cost_usd), 0)).where(
            SpendRecord.user_id == user_id,
            SpendRecord.created_at >= month_start,
        )
        result = await self.session.execute(stmt)
        return float(result.scalar() or 0)

    async def get_global_day_spend(self) -> float:
        now = datetime.now(timezone.utc)
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        stmt = select(func.coalesce(func.sum(SpendRecord.cost_usd), 0)).where(
            SpendRecord.created_at >= day_start
        )
        result = await self.session.execute(stmt)
        return float(result.scalar() or 0)

    async def record(self, user_id: str, job_id: str, cost: ActualCost) -> None:
        record = SpendRecord(
            user_id=user_id,
            job_id=job_id,
            provider=cost.provider.value,
            input_tokens=cost.input_tokens,
            output_tokens=cost.output_tokens,
            cost_usd=Decimal(str(round(cost.cost_usd, 6))),
        )
        self.session.add(record)
        await self.session.commit()
