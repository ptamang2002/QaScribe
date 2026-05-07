"""Tests for /api/export/{artifact_type}/{format}.

Pure-Python helpers (CSV flattening, validation extraction) are unit-tested
without a DB. Endpoint tests run against the configured DATABASE_URL and
skip if it's unreachable.
"""
import csv
import io
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession

from app.api.artifacts import (
    _extract_validation_type,
    _flatten_list_field,
    _flatten_steps,
)


# =====================================================================
#  Pure-Python helper tests
# =====================================================================

def test_flatten_steps_handles_string_array():
    steps = ["Click Add to cart", "Type valid email", "Submit form"]
    assert _flatten_steps(steps) == "1. Click Add to cart | 2. Type valid email | 3. Submit form"


def test_flatten_steps_handles_dict_objects():
    steps = [{"step": "Open page"}, {"action": "Click button"}]
    assert _flatten_steps(steps) == "1. Open page | 2. Click button"


def test_flatten_steps_skips_empty():
    assert _flatten_steps([]) == ""
    assert _flatten_steps(None) == ""  # type: ignore[arg-type]


def test_flatten_list_field_pipe_joins():
    assert _flatten_list_field(["smoke", "regression"]) == "smoke|regression"
    assert _flatten_list_field("plain string") == "plain string"
    assert _flatten_list_field(None) == ""
    assert _flatten_list_field([]) == ""


def test_extract_validation_type_finds_tag():
    assert _extract_validation_type(["validation:application", "smoke"]) == "application"
    assert _extract_validation_type(["smoke", "regression"]) == ""
    assert _extract_validation_type(None) == ""


# =====================================================================
#  Fixtures
# =====================================================================

@pytest_asyncio.fixture
async def test_engine():
    from app.core.config import get_settings
    from app.models.spend import Base

    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as e:  # pragma: no cover
        await engine.dispose()
        pytest.skip(f"DB unreachable, skipping integration tests: {e}")
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(test_engine):
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


@pytest_asyncio.fixture
async def seeded_user(db_session):
    from app.models.spend import Artifact, Session as SessionModel, User

    email = f"export-test-{uuid.uuid4()}@qascribe.local"
    user = User(email=email, hashed_password="x")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    yield user

    sids = (await db_session.execute(
        select(SessionModel.id).where(SessionModel.user_id == user.id)
    )).scalars().all()
    if sids:
        await db_session.execute(delete(Artifact).where(Artifact.session_id.in_(sids)))
        await db_session.execute(delete(SessionModel).where(SessionModel.user_id == user.id))
    await db_session.execute(delete(User).where(User.id == user.id))
    await db_session.commit()


@pytest_asyncio.fixture
async def seeded_data(db_session, seeded_user):
    """Two sessions with a mix of bugs, test cases, and coverage gaps."""
    from app.models.spend import Artifact, Session as SessionModel

    s1 = SessionModel(
        user_id=seeded_user.id, title="Checkout audit",
        video_s3_key="k1", video_duration_seconds=120, video_size_bytes=1000,
        status="completed",
    )
    s2 = SessionModel(
        user_id=seeded_user.id, title="Search bar",
        video_s3_key="k2", video_duration_seconds=90, video_size_bytes=900,
        status="completed",
    )
    db_session.add_all([s1, s2])
    await db_session.commit()
    await db_session.refresh(s1)
    await db_session.refresh(s2)

    artifacts = [
        Artifact(
            session_id=s1.id, artifact_type="bug_report",
            content={
                "title": "Cart total wrong",
                "severity": "high", "priority": "P1",
                "description": "Total shown is $5 lower than line items.\nReproduces every time.",
                "tester_notes": "Possibly tax rounding",
                "evidence_timestamps": ["00:01:23", "00:02:45"],
                "tags": ["smoke", "regression"],
            },
        ),
        Artifact(
            session_id=s1.id, artifact_type="bug_report",
            content={
                "title": 'Quote, comma, "and quotes"',
                "severity": "low", "priority": "P4",
                "description": "Has a comma, and \"quotes\" inside\nplus newline",
            },
            review_status="confirmed",
        ),
        Artifact(
            session_id=s1.id, artifact_type="test_case",
            content={
                "title": "Verify cart total",
                "preconditions": ["Logged in", "Cart has items"],
                "steps": [
                    {"step": "Open cart"},
                    {"step": "Read total"},
                    {"step": "Compare to line items"},
                ],
                "expected_result": "Total equals sum of line items",
                "tags": ["validation:application", "checkout"],
            },
        ),
        Artifact(
            session_id=s2.id, artifact_type="test_case",
            content={
                "title": "Verify search clears",
                "steps": ["Type query", "Press X", "Verify cleared"],
                "tags": ["validation:browser-native", "search"],
            },
        ),
        Artifact(
            session_id=s2.id, artifact_type="coverage_gap",
            content={
                "title": "Empty search submission",
                "description": "Never tested submitting empty search",
                "priority": "medium",
                "related_tested_flow": "Search with valid query",
            },
        ),
    ]
    for a in artifacts:
        db_session.add(a)
    await db_session.commit()
    return {"user": seeded_user, "sessions": [s1, s2], "artifacts": artifacts}


@pytest_asyncio.fixture
async def client(db_session, seeded_user):
    from app.api.sessions import get_current_user
    from app.core.db import get_db
    from app.main import app

    async def _override_db():
        yield db_session

    async def _override_user():
        return seeded_user

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = _override_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


# =====================================================================
#  Endpoint tests
# =====================================================================

async def test_export_bugs_json_returns_array(client, seeded_data):
    r = await client.get("/api/export/bugs/json")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert "qascribe-bugs-" in r.headers["content-disposition"]

    payload = json.loads(r.text)
    assert "metadata" in payload
    assert "items" in payload
    assert payload["metadata"]["artifact_type"] == "bugs"
    assert payload["metadata"]["count"] == 2
    assert "exported_at" in payload["metadata"]
    assert isinstance(payload["items"], list)
    assert len(payload["items"]) == 2
    assert all(it["artifact_type"] == "bug_report" for it in payload["items"])


async def test_export_bugs_csv_has_correct_columns(client, seeded_data):
    r = await client.get("/api/export/bugs/csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")

    rows = list(csv.reader(io.StringIO(r.text)))
    header = rows[0]
    assert header == [
        "id", "session_title", "session_created_at", "title", "severity",
        "priority", "review_status", "reviewed_at", "description",
        "tester_notes", "evidence_timestamps", "tags", "user_edited",
        "created_at",
    ]
    assert len(rows) == 3  # 1 header + 2 bugs


async def test_export_test_cases_csv_flattens_steps(client, seeded_data):
    r = await client.get("/api/export/test_cases/csv")
    assert r.status_code == 200
    reader = csv.DictReader(io.StringIO(r.text))
    rows = list(reader)
    cart = next(row for row in rows if row["title"] == "Verify cart total")
    assert cart["steps"] == "1. Open cart | 2. Read total | 3. Compare to line items"
    assert cart["validation_type"] == "application"
    assert cart["preconditions"] == "Logged in|Cart has items"
    assert cart["tags"] == "checkout"  # validation:* stripped


async def test_export_filters_by_session(client, seeded_data):
    s2_id = seeded_data["sessions"][1].id
    r = await client.get(
        "/api/export/test_cases/json", params={"session_id": s2_id},
    )
    assert r.status_code == 200
    payload = json.loads(r.text)
    assert payload["metadata"]["count"] == 1
    assert payload["items"][0]["session_id"] == s2_id


async def test_export_filters_by_date_range(db_session, client, seeded_data):
    """Mutate one bug to be 30 days old, then narrow the date window."""
    from app.models.spend import Artifact

    bug = next(
        a for a in seeded_data["artifacts"]
        if a.artifact_type == "bug_report" and a.content.get("severity") == "high"
    )
    bug.created_at = datetime.now(timezone.utc) - timedelta(days=30)
    await db_session.commit()

    today = datetime.now(timezone.utc).date()
    seven_days_ago = (today - timedelta(days=7)).isoformat()
    r = await client.get(
        "/api/export/bugs/json",
        params={"date_from": seven_days_ago, "date_to": today.isoformat()},
    )
    assert r.status_code == 200
    payload = json.loads(r.text)
    assert payload["metadata"]["count"] == 1  # the 30-day-old bug is excluded


async def test_export_filters_by_review_status_only_for_bugs(client, seeded_data):
    r_ok = await client.get(
        "/api/export/bugs/json", params={"review_status": "confirmed"},
    )
    assert r_ok.status_code == 200
    payload = json.loads(r_ok.text)
    assert payload["metadata"]["count"] == 1
    assert payload["items"][0]["review_status"] == "confirmed"

    r_bad_tc = await client.get(
        "/api/export/test_cases/json", params={"review_status": "confirmed"},
    )
    assert r_bad_tc.status_code == 400

    r_bad_cov = await client.get(
        "/api/export/coverage_gaps/json", params={"severity": "high"},
    )
    assert r_bad_cov.status_code == 400

    r_bad_val = await client.get(
        "/api/export/bugs/json", params={"validation_type": "application"},
    )
    assert r_bad_val.status_code == 400


async def test_export_empty_returns_valid_file(client, seeded_user):
    """No artifacts at all → JSON empty array, CSV header-only — never 404."""
    r_json = await client.get("/api/export/bugs/json")
    assert r_json.status_code == 200
    payload = json.loads(r_json.text)
    assert payload["metadata"]["count"] == 0
    assert payload["items"] == []

    r_csv = await client.get("/api/export/bugs/csv")
    assert r_csv.status_code == 200
    rows = list(csv.reader(io.StringIO(r_csv.text)))
    assert len(rows) == 1  # header only
    assert rows[0][0] == "id"


async def test_export_csv_handles_special_characters(client, seeded_data):
    """Comma + double-quote + newline inside description must round-trip
    through csv.reader without breaking row boundaries."""
    r = await client.get("/api/export/bugs/csv")
    assert r.status_code == 200
    rows = list(csv.DictReader(io.StringIO(r.text)))
    tricky = next(row for row in rows if row["title"].startswith("Quote, comma"))
    assert "comma" in tricky["description"]
    assert '"quotes"' in tricky["description"]
    assert "newline" in tricky["description"]
    # The crucial assertion: special chars didn't bleed across rows.
    assert len(rows) == 2


async def test_export_pipe_delimiter_in_arrays(client, seeded_data):
    r = await client.get("/api/export/bugs/csv")
    assert r.status_code == 200
    rows = list(csv.DictReader(io.StringIO(r.text)))
    cart_bug = next(row for row in rows if row["title"] == "Cart total wrong")
    assert cart_bug["evidence_timestamps"] == "00:01:23|00:02:45"
    assert cart_bug["tags"] == "smoke|regression"
    # Pipe, not comma — the cell does not contain a separator that would
    # require csv-level splitting.
    assert "," not in cart_bug["tags"]
