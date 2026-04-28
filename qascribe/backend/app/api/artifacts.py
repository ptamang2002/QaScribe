"""Cross-session artifact aggregation endpoints.

Pure DB aggregation — no AI calls, no schema changes. All endpoints scope
to the current user via JOIN on sessions.user_id.
"""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import asc, case, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import (
    AggregatedArtifactItem,
    ArtifactListResponse,
    ArtifactStatsResponse,
    CoverageRollupItem,
    CoverageRollupResponse,
)
from app.api.sessions import get_current_user
from app.core.db import get_db
from app.models.spend import Artifact, Session as SessionModel, User

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])


# ---- Validation sets ----

_VALID_TYPES = {"test_case", "bug_report", "coverage_gap"}
_VALID_SORTS = {"created_desc", "created_asc", "severity_desc", "priority_desc"}
_VALID_SEVERITIES = {"critical", "high", "medium", "low"}
_VALID_PRIORITIES = {"P1", "P2", "P3", "P4"}

# Severity ordering: also used for coverage_gap "priority" field which
# happens to use the same severity-style values (critical/high/medium/low).
_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}


# ---- Pure helpers (testable without a DB) ----

def _normalize_title(t: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    if not t:
        return ""
    t = t.lower()
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _extract_title(content: dict) -> str:
    if not isinstance(content, dict):
        return ""
    return content.get("title") or content.get("untested_flow") or ""


def _extract_evidence_timestamps(content: dict) -> list[str]:
    if not isinstance(content, dict):
        return []
    ts = content.get("evidence_timestamps", [])
    return ts if isinstance(ts, list) else []


def _extract_description(content: dict) -> str:
    if not isinstance(content, dict):
        return ""
    raw = content.get("description") or content.get("summary") or ""
    return raw.strip() if isinstance(raw, str) else ""


def _max_priority(values: list[str]) -> str:
    best, best_rank = "low", 0
    for v in values:
        if not isinstance(v, str):
            continue
        r = _SEVERITY_RANK.get(v.lower(), 0)
        if r > best_rank:
            best_rank, best = r, v.lower()
    return best


# ---- GET /api/artifacts ----

@router.get("", response_model=ArtifactListResponse)
async def list_artifacts(
    type: Optional[str] = Query(None),
    session_id: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    sort: str = Query("created_desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List artifacts across sessions with filters, search, sort, and pagination.

    `severity` and `priority` accept a single value or a comma-separated list
    (e.g. ?severity=high,critical) — matched as IN (...).
    """
    if type is not None and type not in _VALID_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid type: {type}")
    if sort not in _VALID_SORTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid sort: {sort}")

    sev_list: list[str] = []
    if severity:
        sev_list = [s.strip() for s in severity.split(",") if s.strip()]
        for s in sev_list:
            if s not in _VALID_SEVERITIES:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid severity: {s}")

    pri_list: list[str] = []
    if priority:
        pri_list = [p.strip() for p in priority.split(",") if p.strip()]
        for p in pri_list:
            if p not in _VALID_PRIORITIES:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid priority: {p}")

    sev_expr = Artifact.content["severity"].as_string()
    pri_expr = Artifact.content["priority"].as_string()

    base = (
        select(
            Artifact,
            SessionModel.title.label("session_title"),
            SessionModel.created_at.label("session_created_at"),
            SessionModel.video_duration_seconds.label("session_duration_seconds"),
        )
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(SessionModel.user_id == user.id)
    )

    if type is not None:
        base = base.where(Artifact.artifact_type == type)
    if session_id is not None:
        base = base.where(Artifact.session_id == session_id)
    if sev_list:
        base = base.where(sev_expr.in_(sev_list))
    if pri_list:
        base = base.where(pri_expr.in_(pri_list))
    if search:
        like = f"%{search.lower()}%"
        base = base.where(
            or_(
                func.lower(Artifact.content["title"].as_string()).like(like),
                func.lower(Artifact.content["description"].as_string()).like(like),
                func.lower(Artifact.content["summary"].as_string()).like(like),
                func.lower(Artifact.content["untested_flow"].as_string()).like(like),
            )
        )

    if sort == "created_desc":
        base = base.order_by(desc(Artifact.created_at))
    elif sort == "created_asc":
        base = base.order_by(asc(Artifact.created_at))
    elif sort == "severity_desc":
        sev_rank = case(
            (sev_expr == "critical", 4),
            (sev_expr == "high", 3),
            (sev_expr == "medium", 2),
            (sev_expr == "low", 1),
            else_=0,
        )
        base = base.order_by(desc(sev_rank), desc(Artifact.created_at))
    elif sort == "priority_desc":
        pri_rank = case(
            (pri_expr == "P1", 4),
            (pri_expr == "P2", 3),
            (pri_expr == "P3", 2),
            (pri_expr == "P4", 1),
            else_=0,
        )
        base = base.order_by(desc(pri_rank), desc(Artifact.created_at))

    count_stmt = select(func.count()).select_from(base.order_by(None).subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    offset = (page - 1) * page_size
    rows = (await db.execute(base.limit(page_size).offset(offset))).all()

    items = [
        AggregatedArtifactItem(
            id=a.id,
            session_id=a.session_id,
            session_title=stitle,
            session_created_at=screated,
            session_duration_seconds=sdur,
            artifact_type=a.artifact_type,
            content=a.content,
            evidence_timestamps=_extract_evidence_timestamps(a.content),
            user_edited=a.user_edited,
            created_at=a.created_at,
        )
        for a, stitle, screated, sdur in rows
    ]

    return ArtifactListResponse(
        items=items, total=total, page=page, page_size=page_size,
    )


# ---- GET /api/artifacts/stats ----

@router.get("/stats", response_model=ArtifactStatsResponse)
async def artifact_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Aggregate counts powering dashboard tiles and sidebar badges."""
    type_counts_stmt = (
        select(Artifact.artifact_type, func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(SessionModel.user_id == user.id)
        .group_by(Artifact.artifact_type)
    )
    type_counts = {t: int(c) for t, c in (await db.execute(type_counts_stmt)).all()}

    sev_expr = Artifact.content["severity"].as_string()
    sev_stmt = (
        select(sev_expr, func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "bug_report",
        )
        .group_by(sev_expr)
    )
    sev_raw = {s: int(c) for s, c in (await db.execute(sev_stmt)).all() if s is not None}
    bugs_by_severity = {k: sev_raw.get(k, 0) for k in ("critical", "high", "medium", "low")}

    pri_expr = Artifact.content["priority"].as_string()
    pri_stmt = (
        select(pri_expr, func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "bug_report",
        )
        .group_by(pri_expr)
    )
    pri_raw = {p: int(c) for p, c in (await db.execute(pri_stmt)).all() if p is not None}
    bugs_by_priority = {k: pri_raw.get(k, 0) for k in ("P1", "P2", "P3", "P4")}

    open_high = bugs_by_severity["critical"] + bugs_by_severity["high"]

    return ArtifactStatsResponse(
        total_test_cases=type_counts.get("test_case", 0),
        total_bug_reports=type_counts.get("bug_report", 0),
        total_coverage_gaps=type_counts.get("coverage_gap", 0),
        bugs_by_severity=bugs_by_severity,
        bugs_by_priority=bugs_by_priority,
        open_high_severity_count=open_high,
    )


# ---- GET /api/artifacts/coverage-rollup ----

@router.get("/coverage-rollup", response_model=CoverageRollupResponse)
async def coverage_rollup(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Group coverage gaps by normalized title across sessions."""
    stmt = (
        select(Artifact)
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "coverage_gap",
        )
    )
    artifacts = (await db.execute(stmt)).scalars().all()

    groups: dict[str, dict] = {}
    for art in artifacts:
        raw_title = _extract_title(art.content)
        norm = _normalize_title(raw_title)
        if not norm:
            continue
        g = groups.setdefault(norm, {
            "title": raw_title,
            "session_ids": [],
            "priorities": [],
            "first_seen": art.created_at,
            "latest_seen": art.created_at,
            "latest_description": _extract_description(art.content),
        })
        if art.session_id not in g["session_ids"]:
            g["session_ids"].append(art.session_id)
        priority = (art.content or {}).get("priority")
        if isinstance(priority, str):
            g["priorities"].append(priority)
        if art.created_at < g["first_seen"]:
            g["first_seen"] = art.created_at
        if art.created_at >= g["latest_seen"]:
            g["latest_seen"] = art.created_at
            desc = _extract_description(art.content)
            if desc:
                g["latest_description"] = desc

    items = [
        CoverageRollupItem(
            title=g["title"],
            description=g["latest_description"],
            occurrences=len(g["session_ids"]),
            session_ids=g["session_ids"],
            highest_priority=_max_priority(g["priorities"]),
            first_seen=g["first_seen"],
            latest_seen=g["latest_seen"],
        )
        for g in groups.values()
    ]
    items.sort(key=lambda i: (-i.occurrences, i.title))

    return CoverageRollupResponse(items=items, total=len(items))
