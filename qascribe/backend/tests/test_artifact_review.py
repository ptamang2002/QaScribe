"""Tests for the bug review workflow (PATCH /api/artifacts/{id}/review).

Mirrors the fixture pattern from test_artifacts_api.py — DB-backed integration
tests skip cleanly when the configured DATABASE_URL is unreachable.
"""
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession


@pytest_asyncio.fixture
async def test_engine():
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
async def seeded(db_session, seeded_user):
    """One session, four bugs covering all review_status values, plus one test_case."""
    from app.models.spend import Artifact, Session as SessionModel

    s = SessionModel(
        user_id=seeded_user.id, title="Bugs",
        video_s3_key="k", video_duration_seconds=60, video_size_bytes=1000,
        status="completed",
    )
    db_session.add(s)
    await db_session.commit()
    await db_session.refresh(s)

    bug_unreviewed = Artifact(
        session_id=s.id, artifact_type="bug_report",
        content={"title": "Cart total wrong", "severity": "high", "priority": "P1"},
    )
    bug_confirmed = Artifact(
        session_id=s.id, artifact_type="bug_report",
        content={"title": "Login redirect", "severity": "low", "priority": "P3"},
        review_status="confirmed",
    )
    bug_dismissed = Artifact(
        session_id=s.id, artifact_type="bug_report",
        content={"title": "Search lag", "severity": "medium", "priority": "P3"},
        review_status="dismissed",
    )
    bug_needs_info = Artifact(
        session_id=s.id, artifact_type="bug_report",
        content={"title": "Logout slow", "severity": "low", "priority": "P4"},
        review_status="needs_more_info",
    )
    test_case = Artifact(
        session_id=s.id, artifact_type="test_case",
        content={"title": "Login flow"},
    )

    artifacts = [bug_unreviewed, bug_confirmed, bug_dismissed, bug_needs_info, test_case]
    for a in artifacts:
        db_session.add(a)
    await db_session.commit()
    for a in artifacts:
        await db_session.refresh(a)

    return {
        "user": seeded_user,
        "session": s,
        "bug_unreviewed": bug_unreviewed,
        "bug_confirmed": bug_confirmed,
        "bug_dismissed": bug_dismissed,
        "bug_needs_info": bug_needs_info,
        "test_case": test_case,
    }


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


# ---- Required tests ----

async def test_patch_review_changes_status(client, seeded):
    bug = seeded["bug_unreviewed"]
    r = await client.patch(
        f"/api/artifacts/{bug.id}/review",
        json={"review_status": "confirmed"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == bug.id
    assert data["review_status"] == "confirmed"


async def test_patch_review_sets_timestamp_and_user(client, seeded):
    bug = seeded["bug_unreviewed"]
    r = await client.patch(
        f"/api/artifacts/{bug.id}/review",
        json={"review_status": "dismissed"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["reviewed_at"] is not None
    assert data["reviewed_by_user_id"] == seeded["user"].id


async def test_patch_review_rejects_non_bug_artifacts(client, seeded):
    tc = seeded["test_case"]
    r = await client.patch(
        f"/api/artifacts/{tc.id}/review",
        json={"review_status": "confirmed"},
    )
    assert r.status_code == 400


async def test_patch_review_rejects_invalid_status(client, seeded):
    bug = seeded["bug_unreviewed"]
    r = await client.patch(
        f"/api/artifacts/{bug.id}/review",
        json={"review_status": "wontfix"},
    )
    assert r.status_code == 422


async def test_patch_review_with_notes(client, seeded):
    bug = seeded["bug_unreviewed"]
    r = await client.patch(
        f"/api/artifacts/{bug.id}/review",
        json={"review_status": "dismissed", "review_notes": "won't fix because duplicate of #42"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["review_notes"] == "won't fix because duplicate of #42"


async def test_patch_review_idempotent(client, seeded):
    bug = seeded["bug_confirmed"]
    r1 = await client.patch(
        f"/api/artifacts/{bug.id}/review",
        json={"review_status": "unreviewed"},
    )
    assert r1.status_code == 200
    assert r1.json()["review_status"] == "unreviewed"
    first_ts = r1.json()["reviewed_at"]
    assert first_ts is not None

    r2 = await client.patch(
        f"/api/artifacts/{bug.id}/review",
        json={"review_status": "confirmed"},
    )
    assert r2.status_code == 200
    assert r2.json()["review_status"] == "confirmed"
    assert r2.json()["reviewed_at"] is not None


async def test_list_filters_by_review_status(client, seeded):
    r = await client.get("/api/artifacts", params={"review_status": "unreviewed"})
    assert r.status_code == 200
    data = r.json()
    # 1 unreviewed bug + 1 unreviewed test_case = 2 total
    assert all(item["review_status"] == "unreviewed" for item in data["items"])
    assert data["total"] == 2

    r2 = await client.get("/api/artifacts", params={"review_status": "confirmed,dismissed"})
    assert r2.status_code == 200
    data2 = r2.json()
    assert data2["total"] == 2
    statuses = {item["review_status"] for item in data2["items"]}
    assert statuses == {"confirmed", "dismissed"}

    r3 = await client.get("/api/artifacts", params={"review_status": "garbage"})
    assert r3.status_code == 400


async def test_stats_includes_review_breakdown(client, seeded):
    r = await client.get("/api/artifacts/stats")
    assert r.status_code == 200
    data = r.json()
    assert "bugs_by_review_status" in data
    assert data["bugs_by_review_status"] == {
        "unreviewed": 1,
        "confirmed": 1,
        "dismissed": 1,
        "needs_more_info": 1,
    }


async def test_existing_artifacts_default_to_unreviewed(db_session, seeded_user):
    """A freshly-inserted Artifact without an explicit review_status defaults to 'unreviewed'."""
    from app.models.spend import Artifact, Session as SessionModel

    s = SessionModel(
        user_id=seeded_user.id, title="Default check",
        video_s3_key="k", video_duration_seconds=10, video_size_bytes=100,
        status="completed",
    )
    db_session.add(s)
    await db_session.commit()
    await db_session.refresh(s)

    a = Artifact(
        session_id=s.id, artifact_type="bug_report",
        content={"title": "Fresh bug"},
    )
    db_session.add(a)
    await db_session.commit()
    await db_session.refresh(a)

    assert a.review_status == "unreviewed"
    assert a.reviewed_at is None
    assert a.reviewed_by_user_id is None
    assert a.review_notes is None
