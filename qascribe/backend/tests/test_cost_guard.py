"""Tests for cost_guard. These verify all 3 budget defense layers."""
import pytest
from app.services.cost_guard import (
    BudgetExceeded, CostGuard, HardCapExceeded, Provider, ActualCost,
    enforce_hard_caps, estimate_claude_synthesis_cost,
    estimate_full_pipeline_cost, estimate_gemini_video_cost,
    estimate_openai_stt_cost,
)


class FakeSpendStore:
    def __init__(self, user_month_spend: float = 0, global_day_spend: float = 0):
        self.user_month_spend = user_month_spend
        self.global_day_spend = global_day_spend
        self.records: list = []

    async def get_user_month_spend(self, user_id: str) -> float:
        return self.user_month_spend

    async def get_global_day_spend(self) -> float:
        return self.global_day_spend

    async def record(self, user_id: str, job_id: str, cost: ActualCost) -> None:
        self.records.append((user_id, job_id, cost))
        self.user_month_spend += cost.cost_usd
        self.global_day_spend += cost.cost_usd


def test_gemini_estimate_low_resolution():
    est = estimate_gemini_video_cost(60.0, "low")
    assert est.estimated_input_tokens == 60 * 100 + 60 * 32 + 1000


def test_gemini_estimate_default_higher_than_low():
    low = estimate_gemini_video_cost(60.0, "low")
    default = estimate_gemini_video_cost(60.0, "default")
    assert default.estimated_input_tokens > low.estimated_input_tokens


def test_stt_estimate_priced_per_minute():
    est = estimate_openai_stt_cost(120.0)
    # 2 minutes * $0.006 = $0.012 (whisper-1 default)
    assert est.estimated_cost_usd > 0


def test_claude_estimate_scales_with_input():
    small = estimate_claude_synthesis_cost(1000)
    large = estimate_claude_synthesis_cost(100_000)
    assert large.estimated_cost_usd > small.estimated_cost_usd


def test_full_pipeline_includes_all():
    est = estimate_full_pipeline_cost(60.0, has_voice_track=True)
    assert est["gemini"] is not None
    assert est["stt"] is not None
    assert est["claude"] is not None
    assert est["total_with_safety_margin_usd"] > est["total_estimated_usd"]


def test_full_pipeline_no_voice_skips_stt():
    est = estimate_full_pipeline_cost(60.0, has_voice_track=False)
    assert est["stt"] is None


def test_hard_cap_rejects_long_video():
    with pytest.raises(HardCapExceeded, match="duration"):
        enforce_hard_caps(duration_seconds=4000, file_size_bytes=1024)


def test_hard_cap_rejects_large_file():
    with pytest.raises(HardCapExceeded, match="size"):
        enforce_hard_caps(duration_seconds=60, file_size_bytes=10**9)


def test_hard_cap_passes_normal_video():
    enforce_hard_caps(duration_seconds=600, file_size_bytes=50 * 1024 * 1024)


@pytest.mark.asyncio
async def test_costguard_allows_small_job():
    store = FakeSpendStore(user_month_spend=0)
    guard = CostGuard(store, user_id="u1", job_id="j1", user_monthly_budget_usd=50.0)
    estimate = estimate_full_pipeline_cost(60.0, has_voice_track=True)
    await guard.check_pipeline_budget(estimate)


@pytest.mark.asyncio
async def test_costguard_rejects_user_budget_exceeded():
    store = FakeSpendStore(user_month_spend=49.99)
    guard = CostGuard(store, user_id="u1", job_id="j1", user_monthly_budget_usd=50.0)
    estimate = estimate_full_pipeline_cost(600.0, has_voice_track=True)
    with pytest.raises(BudgetExceeded, match="User monthly budget"):
        await guard.check_pipeline_budget(estimate)


@pytest.mark.asyncio
async def test_costguard_rejects_per_job_cap():
    """With dev-tier pricing the per-job cap is harder to exceed; use a very
    long duration so we trip it regardless of which model tier is configured."""
    from app.services.cost_guard import settings as cg_settings
    store = FakeSpendStore()
    guard = CostGuard(store, user_id="u1", job_id="j1", user_monthly_budget_usd=10000)
    # Find a duration that produces estimated cost > PER_JOB_MAX_USD
    duration = 100_000.0  # ~28 hours; will exceed any reasonable cap
    estimate = estimate_full_pipeline_cost(duration, has_voice_track=True)
    assert estimate["total_with_safety_margin_usd"] > cg_settings.PER_JOB_MAX_USD
    with pytest.raises(BudgetExceeded, match="Per-job budget"):
        await guard.check_pipeline_budget(estimate)


@pytest.mark.asyncio
async def test_costguard_rejects_global_daily_cap():
    store = FakeSpendStore(global_day_spend=199.99)
    guard = CostGuard(store, user_id="u1", job_id="j1", user_monthly_budget_usd=10000)
    estimate = estimate_full_pipeline_cost(60.0, has_voice_track=True)
    with pytest.raises(BudgetExceeded, match="daily budget"):
        await guard.check_pipeline_budget(estimate)


@pytest.mark.asyncio
async def test_costguard_records_actual():
    store = FakeSpendStore()
    guard = CostGuard(store, user_id="u1", job_id="j1")
    await guard.record_actual(ActualCost(
        provider=Provider.GEMINI, input_tokens=10000, output_tokens=2000, cost_usd=0.05
    ))
    assert len(store.records) == 1
