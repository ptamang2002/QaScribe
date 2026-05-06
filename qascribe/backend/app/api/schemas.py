"""Pydantic schemas for the API layer."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ReviewStatus = Literal["unreviewed", "confirmed", "dismissed", "needs_more_info"]


# ---- Cost / Budget ----

class CostBreakdown(BaseModel):
    gemini_usd: float
    stt_usd: float
    claude_usd: float


class CostEstimateResponse(BaseModel):
    duration_seconds: float
    has_voice_track: bool
    estimated_cost_usd: float
    estimated_cost_with_safety_margin_usd: float
    breakdown: CostBreakdown
    would_exceed_per_job_cap: bool
    user_monthly_budget_remaining_usd: float


class BudgetStatusResponse(BaseModel):
    user_id: str
    monthly_budget_usd: float
    month_to_date_spend_usd: float
    remaining_usd: float
    global_today_spend_usd: float
    global_daily_cap_usd: float


# ---- Sessions ----

class SessionCreateResponse(BaseModel):
    session_id: str
    status: str
    estimated_cost_usd: float


class SessionStatusResponse(BaseModel):
    session_id: str
    title: str
    test_focus: str
    status: str
    duration_seconds: float
    estimated_cost_usd: float | None
    actual_cost_usd: float | None
    error_message: str | None
    has_voice_track: bool
    created_at: datetime
    artifact_counts: dict   # {"test_case": 7, "bug_report": 1, "coverage_gap": 10}


class SessionListItem(BaseModel):
    session_id: str
    title: str
    test_focus: str
    status: str
    duration_seconds: float
    estimated_cost_usd: float | None
    actual_cost_usd: float | None
    artifact_count: int
    created_at: datetime


class VideoUrlResponse(BaseModel):
    url: str
    expires_in_seconds: int


# ---- Artifacts ----

class ArtifactResponse(BaseModel):
    id: str
    artifact_type: str
    content: dict
    user_edited: bool
    created_at: datetime
    review_status: ReviewStatus
    reviewed_at: datetime | None = None
    reviewed_by_user_id: str | None = None
    review_notes: str | None = None


class ArtifactUpdateRequest(BaseModel):
    content: dict


class ArtifactReviewUpdate(BaseModel):
    review_status: ReviewStatus
    review_notes: str | None = None


class ArtifactReviewResponse(ArtifactResponse):
    pass


# ---- Workflow ----

class WorkflowStep(BaseModel):
    step_number: int
    timestamp_seconds: float
    kind: str   # "action" | "voice_annotation" | "anomaly"
    summary: str
    details: str
    linked_artifact_ids: list[str] = []


class WorkflowResponse(BaseModel):
    session_id: str
    duration_seconds: float
    steps: list[WorkflowStep]


# ---- Dashboard ----

class DashboardStatsResponse(BaseModel):
    sessions_this_month: int
    test_cases_generated: int
    bugs_surfaced: int
    estimated_hours_saved: int


# ---- Cross-session artifacts ----

class AggregatedArtifactItem(BaseModel):
    id: str
    session_id: str
    session_title: str
    session_created_at: datetime
    session_duration_seconds: float
    artifact_type: str
    content: dict
    evidence_timestamps: list[str] = []
    user_edited: bool
    created_at: datetime
    review_status: ReviewStatus
    reviewed_at: datetime | None = None
    reviewed_by_user_id: str | None = None
    review_notes: str | None = None


class ArtifactListResponse(BaseModel):
    items: list[AggregatedArtifactItem]
    total: int
    page: int
    page_size: int


class ArtifactStatsResponse(BaseModel):
    total_test_cases: int
    total_bug_reports: int
    total_coverage_gaps: int
    bugs_by_severity: dict[str, int]
    bugs_by_priority: dict[str, int]
    bugs_by_review_status: dict[str, int]
    open_high_severity_count: int


class CoverageRollupItem(BaseModel):
    title: str
    description: str = ""
    occurrences: int
    session_ids: list[str]
    highest_priority: str
    first_seen: datetime
    latest_seen: datetime


class CoverageRollupResponse(BaseModel):
    items: list[CoverageRollupItem]
    total: int


# ---- Config ----

class ModelConfigResponse(BaseModel):
    gemini_model: str
    stt_model: str
    claude_model: str
    gemini_input_price_per_m: float
    gemini_output_price_per_m: float
    stt_price_per_minute: float
    claude_input_price_per_m: float
    claude_output_price_per_m: float
    per_job_max_usd: float
    max_video_duration_seconds: int
    max_video_file_size_mb: int


# ---- User ----

class UserUpdateRequest(BaseModel):
    monthly_budget_usd: float = Field(gt=0, le=10000)


class UserResponse(BaseModel):
    id: str
    email: str
    monthly_budget_usd: float
