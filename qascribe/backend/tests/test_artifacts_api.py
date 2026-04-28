"""Tests for cross-session artifact aggregation endpoints.

Pure-Python helpers are unit-tested without a DB. Endpoint tests run
against the configured DATABASE_URL (Postgres in dev/CI). If the DB is
unreachable the endpoint tests are skipped — the pure-Python tests still
guard the dedup/normalization logic.
"""
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession

from app.api.artifacts import _max_priority, _normalize_title


# =====================================================================
#  Pure-Python helper tests (no DB)
# =====================================================================

def test_normalize_title_lowercases():
    assert _normalize_title("Hello World") == "hello world"


def test_normalize_title_strips_punctuation():
    assert _normalize_title("Guest checkout flow!") == "guest checkout flow"


def test_normalize_title_collapses_whitespace():
    assert _normalize_title("  Multiple   spaces\there ") == "multiple spaces here"


def test_normalize_title_handles_empty():
    assert _normalize_title("") == ""
    assert _normalize_title(None) == ""  # type: ignore[arg-type]


def test_normalize_title_dedups_punctuation_variants():
    a = _normalize_title("Guest checkout flow not exercised")
    b = _normalize_title("guest checkout flow not exercised!")
    c = _normalize_title("  Guest  Checkout, Flow not exercised. ")
    assert a == b == c


def test_max_priority_picks_highest():
    assert _max_priority(["low", "medium", "high"]) == "high"
    assert _max_priority(["medium", "critical", "low"]) == "critical"
    assert _max_priority([]) == "low"
    assert _max_priority(["nonsense"]) == "low"


# =====================================================================
#  DB-backed endpoint tests
# =====================================================================

@pytest_asyncio.fixture
async def test_engine():
    """Create schema in the configured DB. Skip if unreachable."""
    from app.core.config import get_settings
    from app.models.spend import Base

    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as e:  # pragma: no cover — env-dependent
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

    email = f"test-{uuid.uuid4()}@qascribe.local"
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
    """3 sessions, 9 artifacts, mixed types/severities/priorities + a duped coverage gap."""
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
    s3 = SessionModel(
        user_id=seeded_user.id, title="Settings",
        video_s3_key="k3", video_duration_seconds=60, video_size_bytes=600,
        status="completed",
    )
    for s in (s1, s2, s3):
        db_session.add(s)
    await db_session.commit()
    for s in (s1, s2, s3):
        await db_session.refresh(s)

    artifacts = [
        Artifact(session_id=s1.id, artifact_type="test_case",
                 content={"title": "Login flow", "description": "verifies login"}),
        Artifact(session_id=s1.id, artifact_type="test_case",
                 content={"title": "Logout flow", "description": "verifies logout"}),
        Artifact(session_id=s1.id, artifact_type="bug_report",
                 content={"title": "Cart total wrong", "severity": "high", "priority": "P1"}),
        Artifact(session_id=s1.id, artifact_type="coverage_gap",
                 content={"title": "Guest checkout flow not exercised", "priority": "medium"}),
        Artifact(session_id=s2.id, artifact_type="bug_report",
                 content={"title": "Search lag", "severity": "medium", "priority": "P3"}),
        Artifact(session_id=s2.id, artifact_type="bug_report",
                 content={"title": "Results truncated", "severity": "low", "priority": "P4"}),
        Artifact(session_id=s2.id, artifact_type="coverage_gap",
                 content={"title": "guest checkout flow not exercised!", "priority": "high"}),
        Artifact(session_id=s3.id, artifact_type="bug_report",
                 content={"title": "Settings save crash", "severity": "critical", "priority": "P1"}),
        Artifact(session_id=s3.id, artifact_type="coverage_gap",
                 content={"title": "Profile photo upload", "priority": "low"}),
    ]
    for a in artifacts:
        db_session.add(a)
    await db_session.commit()
    return {"user": seeded_user, "sessions": [s1, s2, s3], "artifacts": artifacts}


@pytest_asyncio.fixture
async def client(db_session, seeded_user):
    """Httpx client wired so get_current_user resolves to the seeded user."""
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


# ---- Required tests ----

async def test_list_artifacts_by_type(client, seeded_data):
    r = await client.get("/api/artifacts", params={"type": "bug_report"})
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 4
    assert len(data["items"]) == 4
    assert all(item["artifact_type"] == "bug_report" for item in data["items"])
    assert all("session_title" in item for item in data["items"])


async def test_list_artifacts_pagination(client, seeded_data):
    r1 = await client.get("/api/artifacts", params={"page": 1, "page_size": 3})
    assert r1.status_code == 200
    p1 = r1.json()
    assert p1["total"] == 9
    assert p1["page"] == 1
    assert p1["page_size"] == 3
    assert len(p1["items"]) == 3

    r2 = await client.get("/api/artifacts", params={"page": 2, "page_size": 3})
    p2 = r2.json()
    assert len(p2["items"]) == 3

    r3 = await client.get("/api/artifacts", params={"page": 3, "page_size": 3})
    p3 = r3.json()
    assert len(p3["items"]) == 3

    ids = (
        {i["id"] for i in p1["items"]}
        | {i["id"] for i in p2["items"]}
        | {i["id"] for i in p3["items"]}
    )
    assert len(ids) == 9  # no overlap

    r4 = await client.get("/api/artifacts", params={"page": 4, "page_size": 3})
    assert r4.json()["items"] == []


async def test_artifact_stats(client, seeded_data):
    r = await client.get("/api/artifacts/stats")
    assert r.status_code == 200
    data = r.json()
    assert data["total_test_cases"] == 2
    assert data["total_bug_reports"] == 4
    assert data["total_coverage_gaps"] == 3
    assert data["bugs_by_severity"] == {
        "critical": 1, "high": 1, "medium": 1, "low": 1,
    }
    assert data["bugs_by_priority"] == {"P1": 2, "P2": 0, "P3": 1, "P4": 1}
    assert data["open_high_severity_count"] == 2  # critical + high


async def test_coverage_rollup_dedups_by_normalized_title(client, seeded_data):
    r = await client.get("/api/artifacts/coverage-rollup")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2

    guest = next(i for i in data["items"] if "guest" in i["title"].lower())
    assert guest["occurrences"] == 2
    assert len(guest["session_ids"]) == 2
    assert guest["highest_priority"] == "high"  # max of medium + high

    profile = next(i for i in data["items"] if "profile" in i["title"].lower())
    assert profile["occurrences"] == 1
    assert profile["highest_priority"] == "low"


# ---- Bonus coverage on filters ----

async def test_list_artifacts_filter_by_severity(client, seeded_data):
    r = await client.get("/api/artifacts", params={"severity": "critical"})
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 1
    assert data["items"][0]["content"]["severity"] == "critical"


async def test_list_artifacts_search_matches_title(client, seeded_data):
    r = await client.get("/api/artifacts", params={"search": "cart"})
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 1
    assert "cart" in data["items"][0]["content"]["title"].lower()


async def test_list_artifacts_invalid_type_returns_400(client, seeded_data):
    r = await client.get("/api/artifacts", params={"type": "bogus"})
    assert r.status_code == 400
