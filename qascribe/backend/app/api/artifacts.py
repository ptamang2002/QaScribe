"""Cross-session artifact aggregation endpoints.

Pure DB aggregation — no AI calls, no schema changes. All endpoints scope
to the current user via JOIN on sessions.user_id.
"""
import csv
import io
import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import asc, case, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import (
    AggregatedArtifactItem,
    ArtifactListResponse,
    ArtifactReviewResponse,
    ArtifactReviewUpdate,
    ArtifactStatsResponse,
    CoverageRollupItem,
    CoverageRollupResponse,
)
from app.api.sessions import get_current_user
from app.core.db import get_db
from app.models.spend import Artifact, Session as SessionModel, User

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])
export_router = APIRouter(prefix="/api/export", tags=["export"])


# ---- Validation sets ----

_VALID_TYPES = {"test_case", "bug_report", "coverage_gap"}
_VALID_SORTS = {"created_desc", "created_asc", "severity_desc", "priority_desc"}
_VALID_SEVERITIES = {"critical", "high", "medium", "low"}
_VALID_PRIORITIES = {"P1", "P2", "P3", "P4"}
_VALID_REVIEW_STATUSES = {"unreviewed", "confirmed", "dismissed", "needs_more_info"}

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
    review_status: Optional[str] = Query(None),
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

    rev_list: list[str] = []
    if review_status:
        rev_list = [r.strip() for r in review_status.split(",") if r.strip()]
        for r in rev_list:
            if r not in _VALID_REVIEW_STATUSES:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"invalid review_status: {r}"
                )

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
    if rev_list:
        base = base.where(Artifact.review_status.in_(rev_list))
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
            review_status=a.review_status,
            reviewed_at=a.reviewed_at,
            reviewed_by_user_id=a.reviewed_by_user_id,
            review_notes=a.review_notes,
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

    rev_stmt = (
        select(Artifact.review_status, func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "bug_report",
        )
        .group_by(Artifact.review_status)
    )
    rev_raw = {r: int(c) for r, c in (await db.execute(rev_stmt)).all() if r is not None}
    bugs_by_review_status = {
        k: rev_raw.get(k, 0)
        for k in ("unreviewed", "confirmed", "dismissed", "needs_more_info")
    }

    open_high = bugs_by_severity["critical"] + bugs_by_severity["high"]

    # ---- Phase 5 dashboard fields ----
    high_sev_confirmed_stmt = (
        select(func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "bug_report",
            Artifact.review_status == "confirmed",
            sev_expr.in_(("critical", "high")),
        )
    )
    high_sev_confirmed = (await db.execute(high_sev_confirmed_stmt)).scalar() or 0

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # No updated_at column on Artifact — proxy "edited this month" with
    # test cases CREATED this month that are user_edited=True.
    edited_tc_stmt = (
        select(func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.artifact_type == "test_case",
            Artifact.user_edited.is_(True),
            Artifact.created_at >= month_start,
        )
    )
    edited_tc_this_month = (await db.execute(edited_tc_stmt)).scalar() or 0

    week_start = now - timedelta(days=7)
    last7_stmt = (
        select(Artifact.artifact_type, func.count(Artifact.id))
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user.id,
            Artifact.created_at >= week_start,
        )
        .group_by(Artifact.artifact_type)
    )
    last7_raw = {t: int(c) for t, c in (await db.execute(last7_stmt)).all()}
    last7 = {k: last7_raw.get(k, 0) for k in ("bug_report", "test_case", "coverage_gap")}

    return ArtifactStatsResponse(
        total_test_cases=type_counts.get("test_case", 0),
        total_bug_reports=type_counts.get("bug_report", 0),
        total_coverage_gaps=type_counts.get("coverage_gap", 0),
        bugs_by_severity=bugs_by_severity,
        bugs_by_priority=bugs_by_priority,
        bugs_by_review_status=bugs_by_review_status,
        open_high_severity_count=open_high,
        high_severity_confirmed_count=int(high_sev_confirmed),
        test_cases_user_edited_this_month=int(edited_tc_this_month),
        artifacts_created_last_7_days=last7,
    )


# ---- PATCH /api/artifacts/{id}/review ----

@router.patch("/{artifact_id}/review", response_model=ArtifactReviewResponse)
async def review_artifact(
    artifact_id: str,
    payload: ArtifactReviewUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set the review state on a bug_report artifact.

    Idempotent — re-reviewing (including reverting to "unreviewed") is allowed
    and refreshes reviewed_at + reviewed_by_user_id.
    """
    artifact = await db.get(Artifact, artifact_id)
    if not artifact:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    session = await db.get(SessionModel, artifact.session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Artifact not found")
    if artifact.artifact_type != "bug_report":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Review states are only supported for bug_report artifacts",
        )

    artifact.review_status = payload.review_status
    artifact.reviewed_at = datetime.now(timezone.utc)
    artifact.reviewed_by_user_id = user.id
    if payload.review_notes is not None:
        artifact.review_notes = payload.review_notes
    await db.commit()
    await db.refresh(artifact)

    return ArtifactReviewResponse(
        id=artifact.id,
        artifact_type=artifact.artifact_type,
        content=artifact.content,
        user_edited=artifact.user_edited,
        created_at=artifact.created_at,
        review_status=artifact.review_status,
        reviewed_at=artifact.reviewed_at,
        reviewed_by_user_id=artifact.reviewed_by_user_id,
        review_notes=artifact.review_notes,
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


# ---- Export ----

# URL path slug -> stored artifact_type value.
_EXPORT_TYPE_MAP = {
    "bugs": "bug_report",
    "test_cases": "test_case",
    "coverage_gaps": "coverage_gap",
}
_VALID_FORMATS = {"json", "csv"}
_VALID_VALIDATION_TYPES = {"application", "browser-native", "server-side"}


def _flatten_steps(steps) -> str:
    """Test-case steps array → '1. ... | 2. ...' single-cell string."""
    if not isinstance(steps, list):
        return ""
    parts: list[str] = []
    for i, step in enumerate(steps, start=1):
        if isinstance(step, str):
            text = step.strip()
        elif isinstance(step, dict):
            text = (
                step.get("step") or step.get("action") or step.get("description")
                or step.get("text") or ""
            )
            if not isinstance(text, str):
                text = str(text)
            text = text.strip()
        else:
            text = str(step).strip()
        if text:
            parts.append(f"{i}. {text}")
    return " | ".join(parts)


def _flatten_list_field(value) -> str:
    """Array of strings → 'a|b|c'. Scalar string passes through."""
    if isinstance(value, list):
        return "|".join(str(v) for v in value if v is not None and str(v).strip())
    if value is None:
        return ""
    return str(value)


def _extract_validation_type(tags) -> str:
    if not isinstance(tags, list):
        return ""
    for tag in tags:
        if isinstance(tag, str) and tag.startswith("validation:"):
            v = tag.split(":", 1)[1]
            if v in _VALID_VALIDATION_TYPES:
                return v
    return ""


def _non_validation_tags(tags) -> list[str]:
    if not isinstance(tags, list):
        return []
    return [t for t in tags if isinstance(t, str) and not t.startswith("validation:")]


def _parse_iso_date(s: str, field: str) -> datetime:
    try:
        d = date.fromisoformat(s)
    except ValueError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"invalid {field}: {s!r} (expected YYYY-MM-DD)",
        )
    return datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)


def _parse_csv_param(
    raw: Optional[str], allowed: set[str], field: str,
) -> list[str]:
    if not raw:
        return []
    out = [s.strip() for s in raw.split(",") if s.strip()]
    for s in out:
        if s not in allowed:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"invalid {field}: {s}"
            )
    return out


def _build_filename(export_type: str, ext: str) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"qascribe-{export_type}-{today}.{ext}"


def _row_for_bug(art: Artifact, session_title: str, session_created_at: datetime) -> dict:
    c = art.content if isinstance(art.content, dict) else {}
    return {
        "id": art.id,
        "session_title": session_title,
        "session_created_at": session_created_at.isoformat(),
        "title": c.get("title", "") or "",
        "severity": c.get("severity", "") or "",
        "priority": c.get("priority", "") or "",
        "review_status": art.review_status,
        "reviewed_at": art.reviewed_at.isoformat() if art.reviewed_at else "",
        "description": (c.get("description") or c.get("summary") or "") or "",
        "tester_notes": c.get("tester_notes", "") or "",
        "evidence_timestamps": _flatten_list_field(c.get("evidence_timestamps", [])),
        "tags": _flatten_list_field(_non_validation_tags(c.get("tags", []))),
        "user_edited": "true" if art.user_edited else "false",
        "created_at": art.created_at.isoformat(),
    }


def _row_for_test_case(art: Artifact, session_title: str, session_created_at: datetime) -> dict:
    c = art.content if isinstance(art.content, dict) else {}
    tags = c.get("tags", [])
    return {
        "id": art.id,
        "session_title": session_title,
        "session_created_at": session_created_at.isoformat(),
        "tc_id": f"TC-{art.id[:4].upper()}",
        "title": c.get("title", "") or "",
        "preconditions": _flatten_list_field(c.get("preconditions", "")),
        "steps": _flatten_steps(c.get("steps", [])),
        "expected_result": c.get("expected_result", "") or "",
        "validation_type": _extract_validation_type(tags),
        "tags": _flatten_list_field(_non_validation_tags(tags)),
        "user_edited": "true" if art.user_edited else "false",
        "created_at": art.created_at.isoformat(),
    }


def _row_for_coverage_gap(
    art: Artifact, session_title: str, session_created_at: datetime,
) -> dict:
    c = art.content if isinstance(art.content, dict) else {}
    return {
        "id": art.id,
        "session_title": session_title,
        "session_created_at": session_created_at.isoformat(),
        "title": c.get("title") or c.get("untested_flow", "") or "",
        "description": (c.get("description") or c.get("summary") or "") or "",
        "priority": c.get("priority", "") or "",
        "related_tested_flow": c.get("related_tested_flow", "") or "",
        "user_edited": "true" if art.user_edited else "false",
        "created_at": art.created_at.isoformat(),
    }


_CSV_COLUMNS = {
    "bugs": [
        "id", "session_title", "session_created_at", "title", "severity",
        "priority", "review_status", "reviewed_at", "description",
        "tester_notes", "evidence_timestamps", "tags", "user_edited",
        "created_at",
    ],
    "test_cases": [
        "id", "session_title", "session_created_at", "tc_id", "title",
        "preconditions", "steps", "expected_result", "validation_type",
        "tags", "user_edited", "created_at",
    ],
    "coverage_gaps": [
        "id", "session_title", "session_created_at", "title", "description",
        "priority", "related_tested_flow", "user_edited", "created_at",
    ],
}


def _stream_csv(rows: Iterable[dict], fieldnames: list[str]) -> Iterable[str]:
    """Yield CSV chunks (header first, then one row at a time) using
    csv.QUOTE_MINIMAL so commas/quotes/newlines inside cells are escaped
    correctly per RFC 4180."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
    writer.writeheader()
    yield buf.getvalue()
    buf.seek(0); buf.truncate(0)
    for row in rows:
        writer.writerow(row)
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)


def _json_item(art: Artifact, session_title: str) -> dict:
    return {
        "id": art.id,
        "session_id": art.session_id,
        "session_title": session_title,
        "artifact_type": art.artifact_type,
        "content": art.content,
        "evidence_timestamps": _extract_evidence_timestamps(art.content),
        "review_status": art.review_status,
        "reviewed_at": art.reviewed_at.isoformat() if art.reviewed_at else None,
        "reviewed_by_user_id": art.reviewed_by_user_id,
        "review_notes": art.review_notes,
        "user_edited": art.user_edited,
        "created_at": art.created_at.isoformat(),
    }


def _stream_json(metadata: dict, items: list[dict]) -> Iterable[str]:
    """Stream a pretty-printed JSON document with the {metadata, items} shape.

    Yields the metadata header up-front, then each item on its own line, so
    we never hold a fully-serialized blob in memory beyond a single item.
    """
    yield "{\n"
    meta_str = json.dumps(metadata, indent=2, default=str)
    yield '  "metadata": ' + meta_str.replace("\n", "\n  ")
    yield ',\n  "items": ['
    if not items:
        yield "]\n}\n"
        return
    yield "\n"
    for i, item in enumerate(items):
        chunk = json.dumps(item, indent=2, default=str).replace("\n", "\n    ")
        yield "    " + chunk
        yield ",\n" if i < len(items) - 1 else "\n"
    yield "  ]\n}\n"


def _parse_export_filters(
    export_type: str,
    session_id: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    review_status: Optional[str],
    severity: Optional[str],
    priority: Optional[str],
    validation_type: Optional[str],
) -> dict:
    """Validate and normalize export query params. Raises 400 on bad input
    or filter/type mismatch."""
    if export_type not in _EXPORT_TYPE_MAP:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"invalid export type: {export_type}",
        )
    if export_type != "bugs" and (review_status or severity):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "review_status and severity filters are only valid for bugs",
        )
    if export_type == "test_cases" and priority:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "priority filter is not supported for test_cases",
        )
    if export_type != "test_cases" and validation_type:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "validation_type filter is only valid for test_cases",
        )
    # Bugs use P1–P4 priority; coverage_gap.priority is severity-style.
    pri_allowed = (
        _VALID_PRIORITIES if export_type == "bugs" else _VALID_SEVERITIES
    )
    return {
        "artifact_type": _EXPORT_TYPE_MAP[export_type],
        "session_id": session_id,
        "date_from": date_from,
        "date_to": date_to,
        "date_from_dt": _parse_iso_date(date_from, "date_from") if date_from else None,
        "date_to_dt": (
            _parse_iso_date(date_to, "date_to") + timedelta(days=1)
            if date_to else None
        ),
        "sev_list": _parse_csv_param(severity, _VALID_SEVERITIES, "severity"),
        "pri_list": _parse_csv_param(priority, pri_allowed, "priority"),
        "rev_list": _parse_csv_param(review_status, _VALID_REVIEW_STATUSES, "review_status"),
        "val_list": _parse_csv_param(validation_type, _VALID_VALIDATION_TYPES, "validation_type"),
    }


def _build_export_stmt(user_id: str, f: dict):
    sev_expr = Artifact.content["severity"].as_string()
    pri_expr = Artifact.content["priority"].as_string()
    stmt = (
        select(
            Artifact,
            SessionModel.title.label("session_title"),
            SessionModel.created_at.label("session_created_at"),
        )
        .join(SessionModel, Artifact.session_id == SessionModel.id)
        .where(
            SessionModel.user_id == user_id,
            Artifact.artifact_type == f["artifact_type"],
        )
    )
    if f["session_id"] is not None:
        stmt = stmt.where(Artifact.session_id == f["session_id"])
    if f["date_from_dt"] is not None:
        stmt = stmt.where(Artifact.created_at >= f["date_from_dt"])
    if f["date_to_dt"] is not None:
        stmt = stmt.where(Artifact.created_at < f["date_to_dt"])
    if f["sev_list"]:
        stmt = stmt.where(sev_expr.in_(f["sev_list"]))
    if f["pri_list"]:
        stmt = stmt.where(pri_expr.in_(f["pri_list"]))
    if f["rev_list"]:
        stmt = stmt.where(Artifact.review_status.in_(f["rev_list"]))
    return stmt.order_by(desc(Artifact.created_at))


def _apply_validation_filter(rows, val_list: list[str]):
    """validation_type lives inside content.tags as 'validation:<value>' —
    JSON array containment varies by backend, so we filter in Python."""
    if not val_list:
        return rows
    return [
        r for r in rows
        if _extract_validation_type(
            (r[0].content or {}).get("tags") if isinstance(r[0].content, dict) else None
        ) in val_list
    ]


@export_router.get("/{export_type}/count")
async def export_count(
    export_type: str,
    session_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    review_status: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    validation_type: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return how many artifacts an export with the same filters would
    contain. Powers the 'This will export N items' preview."""
    f = _parse_export_filters(
        export_type, session_id, date_from, date_to,
        review_status, severity, priority, validation_type,
    )
    rows = (await db.execute(_build_export_stmt(user.id, f))).all()
    rows = _apply_validation_filter(rows, f["val_list"])
    return {"count": len(rows)}


@export_router.get("/{export_type}/{fmt}")
async def export_artifacts(
    export_type: str,
    fmt: str,
    session_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    review_status: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    validation_type: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Export filtered artifacts of a single type as JSON or CSV.

    Bug-only filters (review_status/severity/priority) and test-case-only
    filter (validation_type) return 400 if combined with the wrong type.
    """
    if fmt not in _VALID_FORMATS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"invalid format: {fmt}",
        )

    f = _parse_export_filters(
        export_type, session_id, date_from, date_to,
        review_status, severity, priority, validation_type,
    )

    rows = (await db.execute(_build_export_stmt(user.id, f))).all()
    rows = _apply_validation_filter(rows, f["val_list"])

    filename = _build_filename(export_type, fmt)
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
    }

    filters_applied: dict = {}
    if session_id: filters_applied["session_id"] = session_id
    if date_from: filters_applied["date_from"] = date_from
    if date_to: filters_applied["date_to"] = date_to
    if f["rev_list"]: filters_applied["review_status"] = f["rev_list"]
    if f["sev_list"]: filters_applied["severity"] = f["sev_list"]
    if f["pri_list"]: filters_applied["priority"] = f["pri_list"]
    if f["val_list"]: filters_applied["validation_type"] = f["val_list"]

    if fmt == "json":
        items = [_json_item(art, stitle) for art, stitle, _ in rows]
        metadata = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "artifact_type": export_type,
            "filters_applied": filters_applied,
            "count": len(items),
        }
        return StreamingResponse(
            _stream_json(metadata, items),
            media_type="application/json",
            headers=headers,
        )

    # CSV
    fieldnames = _CSV_COLUMNS[export_type]
    if export_type == "bugs":
        row_fn = _row_for_bug
    elif export_type == "test_cases":
        row_fn = _row_for_test_case
    else:
        row_fn = _row_for_coverage_gap
    rows_iter = (row_fn(art, stitle, screated) for art, stitle, screated in rows)
    return StreamingResponse(
        _stream_csv(rows_iter, fieldnames),
        media_type="text/csv",
        headers=headers,
    )
