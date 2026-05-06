"""SQLAlchemy models. Note: evidence_bundle on Session is NEW for v2 — stores
the merged action_log + transcript so we can render the workflow view without
re-processing.
"""
from datetime import datetime
from decimal import Decimal
from sqlalchemy import (
    String, DateTime, Integer, Numeric, Text, ForeignKey, JSON, Float, Boolean
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func
import uuid


class Base(DeclarativeBase):
    pass


def gen_id() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=gen_id)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String, nullable=False)
    monthly_budget_usd: Mapped[float] = mapped_column(Float, default=50.00)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Session(Base):
    """A QA testing session — one uploaded video + optional voice."""
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=gen_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    test_focus: Mapped[str] = mapped_column(String, default="exploratory")
    # exploratory | regression | smoke | accessibility
    video_s3_key: Mapped[str] = mapped_column(String, nullable=False)
    video_duration_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    video_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    has_voice_track: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String, default="uploaded")
    # uploaded -> queued -> processing -> completed | failed | rejected_budget
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    actual_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # NEW: stores merged action_log + transcript for workflow view
    evidence_bundle: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    artifacts: Mapped[list["Artifact"]] = relationship(back_populates="session")


class Artifact(Base):
    """A generated artifact: test case, bug report, or coverage analysis."""
    __tablename__ = "artifacts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=gen_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), nullable=False)
    artifact_type: Mapped[str] = mapped_column(String, nullable=False)
    # test_case | bug_report | coverage_gap
    content: Mapped[dict] = mapped_column(JSON, nullable=False)
    user_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    # Bug review workflow (Phase 4). Currently only meaningful for bug_report rows.
    # unreviewed | confirmed | dismissed | needs_more_info
    review_status: Mapped[str] = mapped_column(
        String, nullable=False, default="unreviewed"
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reviewed_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    session: Mapped["Session"] = relationship(back_populates="artifacts")


class SpendRecord(Base):
    """Every AI API call's actual cost. Source of truth for budgets."""
    __tablename__ = "spend_records"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=gen_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True
    )
    job_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
