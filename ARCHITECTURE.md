# AI-QAScribe — Architecture & Data Flow

This document describes how AI-QAScribe processes a QA testing session end-to-end: from the moment a tester hits "stop recording" to the moment structured test cases, bug reports, and coverage gaps appear in the UI.

It's intended as a reference for anyone working on the codebase — humans or AI assistants — to understand the data flow, the role of each AI provider, and where the cost and quality levers live.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [The pipeline at a glance](#2-the-pipeline-at-a-glance)
3. [Stage 1 — Recording or upload](#3-stage-1--recording-or-upload)
4. [Stage 2 — Backend ingest and pre-flight cost guard](#4-stage-2--backend-ingest-and-pre-flight-cost-guard)
5. [Stage 3 — Worker fan-out](#5-stage-3--worker-fan-out)
   - [Gemini — video perception](#51-gemini--video-perception)
   - [Whisper — voice transcription](#52-whisper--voice-transcription)
6. [Stage 4 — The merge step (evidence bundle)](#6-stage-4--the-merge-step-evidence-bundle)
7. [Stage 5 — Claude synthesis](#7-stage-5--claude-synthesis)
8. [Stage 6 — Storage and rendering](#8-stage-6--storage-and-rendering)
9. [Why three different AI providers](#9-why-three-different-ai-providers)
10. [Failure modes and recovery](#10-failure-modes-and-recovery)
11. [Cost control architecture](#11-cost-control-architecture)
12. [Where to make changes](#12-where-to-make-changes)

---

## 1. System overview

AI-QAScribe is a multi-model AI pipeline that turns a recorded QA testing session (screen video + voice narration) into structured artifacts: test cases, bug reports, and coverage gap analysis.

The high-level architecture has three planes:

| Plane | What it does | Tech |
|---|---|---|
| **Frontend** | Records the session, uploads it, displays artifacts | React 18, TypeScript, Vite, Tailwind, TanStack Query |
| **Backend (API)** | Accepts uploads, enforces budget, queues processing, serves artifacts | FastAPI (async), SQLAlchemy 2.0, Postgres, MinIO |
| **Backend (Worker)** | Runs the AI pipeline asynchronously | Celery (solo pool on Windows), Redis broker |

Three external AI services are called during processing:

| Provider | Model (dev) | Model (prod) | Job |
|---|---|---|---|
| Google | `gemini-2.5-flash` | `gemini-3-pro` | Video perception — what visually happened |
| OpenAI | `whisper-1` | `whisper-1` | Voice transcription — what the tester said |
| Anthropic | `claude-sonnet-4-6` | `claude-opus-4-7` | Artifact synthesis — what to write down |

All model identifiers and prices live in `backend/app/core/config.py`, sourced from `.env`. Swapping models is a `.env` change only — never hard-code model names elsewhere.

---

## 2. The pipeline at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tester records / uploads video with voice narration                │
│  (MP4 or WebM, mic + optional system audio)                         │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Backend ingest (FastAPI)                                           │
│  - cost_guard pre-flight estimate                                   │
│  - ffprobe extracts duration                                        │
│  - video stored in MinIO                                            │
│  - session row created, status='queued'                             │
│  - Celery task dispatched                                           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
        ┌────────────────────┴────────────────────┐
        │                                         │
        ▼                                         ▼
┌──────────────────────────┐          ┌──────────────────────────┐
│  Gemini                  │          │  Whisper                 │
│  (video perception)      │          │  (voice transcription)   │
│                          │          │                          │
│  IN:  full video file    │          │  IN:  extracted audio    │
│  OUT: action_log +       │          │  OUT: timed segments     │
│       anomalies          │          │                          │
└────────────┬─────────────┘          └─────────────┬────────────┘
             │                                      │
             └──────────────────┬───────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Merge step                                                         │
│  - normalize timestamps to seconds                                  │
│  - sort: action (0) → anomaly (1) → voice_annotation (2)            │
│  - produce evidence_bundle, persist to sessions row                 │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Claude — artifact synthesis                                        │
│                                                                     │
│  IN:  evidence_bundle + 3 skill prompts (test-case-format,          │
│       bug-report-template, coverage-gap-analysis)                   │
│  OUT: test cases, bug reports, coverage gaps                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Persistence + rendering                                            │
│  - each artifact row links to session via evidence_timestamps       │
│  - workflow endpoint merges evidence + artifacts for the timeline   │
│  - frontend renders timeline view + artifact cards                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Stage 1 — Recording or upload

Two entry points feed the same backend ingest endpoint.

**Recording path** (`useScreenRecorder.ts`):
- The browser's `getDisplayMedia()` API captures the screen video stream
- `getUserMedia()` captures the microphone audio stream
- If supported, system audio of the captured tab is captured as a separate track
- All streams combined into a single `MediaRecorder` instance
- Chunks emitted every 1 second (`timeslice: 1000`) to avoid memory issues on long recordings
- On stop, chunks assembled into a single Blob — MP4/H.264/AAC if supported, WebM/VP9/Opus as fallback
- Hard cap at 60 minutes (`maxDurationSeconds`), warning at 55 minutes (`warnAtSeconds`)

**Upload path** (`NewSessionPage.tsx`):
- User selects a pre-recorded video file
- 500 MB max file size enforced client-side before upload
- Same supported formats as recording

Both paths POST to `POST /api/sessions` as multipart form data:

```
title:        "Checkout flow audit"
test_focus:   "exploratory" | "regression" | "smoke" | "accessibility"
video:        <binary file>
```

---

## 4. Stage 2 — Backend ingest and pre-flight cost guard

Before any expensive work begins, the backend runs three checks in `services/cost_guard.py`. **This file is locked — 14 tests guard it, never modify directly.**

### Pre-flight checks

1. **Duration probe** — `services/video_probe.py` shells out to `ffprobe` to read the video's duration. (This was a v1 bug — `ffprobe` must be on PATH; install via `winget install ffmpeg` on Windows and restart all terminals.)

2. **Cost estimation** — Given the duration, compute a worst-case cost:
   - Gemini: per-minute video cost from config
   - Whisper: per-minute audio cost ($0.006/min for whisper-1)
   - Claude: estimated based on expected token count from the evidence bundle
   - Multiply by `SAFETY_MULTIPLIER` (default 1.25) for headroom

3. **Three-tier budget enforcement**:
   - `PER_JOB_MAX_USD` — single job hard cap (default $5)
   - `DEFAULT_USER_MONTHLY` — per-user monthly limit (default $50)
   - `GLOBAL_DAILY` — global daily circuit breaker (default $200)

If any check fails, the upload is rejected with HTTP 402 and a clear error message. No video is stored, no API calls are made.

### Persistence and queueing

If checks pass:
- Video uploaded to MinIO under `sessions/{session_id}/video.{ext}`
- New row created in `sessions` table with status `queued`, `estimated_cost_usd` populated
- Celery task `process_session(session_id)` dispatched to Redis broker
- HTTP 202 Accepted returned to client (typically within 1 second)

The frontend then polls `GET /api/sessions/{id}` to track status.

---

## 5. Stage 3 — Worker fan-out

The Celery worker (`workers/celery_app.py`) picks up the task. On Windows, the `solo` pool is used because `prefork` doesn't work — this is auto-detected via `sys.platform == "win32"`.

The worker runs Gemini and Whisper **in parallel** via `asyncio.gather` because they're independent — Gemini doesn't need the transcript and Whisper doesn't need the action log.

### 5.1 Gemini — video perception

**File:** `services/gemini_service.py`

Gemini natively processes video. It samples frames, tracks them temporally, and "watches" the recording to identify UI elements, user actions, and visible anomalies.

#### Upload protocol (Gemini Files API)

Gemini's Files API processes uploads asynchronously. Calling `generate_content` immediately after `files.upload` fails with `FAILED_PRECONDITION: File is not in an ACTIVE state`. **The fix (v1 bug)** — poll until the file is ready:

```python
file = client.files.upload(path=video_path)
while file.state.name != "ACTIVE":
    if elapsed > 300:  # 5min timeout
        raise TimeoutError("Gemini file processing took too long")
    time.sleep(2)
    file = client.files.get(name=file.name)
```

**Never remove this polling loop.**

#### Input

- The full video file (uploaded via Files API)
- A structured prompt asking Gemini to extract actions and anomalies as JSON
- Response schema enforced via Gemini's structured output mode

#### Output — `evidence_bundle.action_log`

```json
{
  "actions": [
    {
      "timestamp": "0:14",
      "type": "click",
      "target": "Add to cart button on product page",
      "description": "Clicked Add to cart"
    },
    {
      "timestamp": "0:51",
      "type": "navigate",
      "target": "/checkout",
      "description": "Navigated to checkout"
    },
    {
      "timestamp": "2:03",
      "type": "type",
      "target": "email field",
      "description": "Typed valid email address"
    }
  ],
  "errors_or_anomalies": [
    {
      "timestamp": "1:18",
      "type": "error_message",
      "description": "Something went wrong banner appeared after form submit"
    },
    {
      "timestamp": "2:31",
      "type": "stuck_state",
      "description": "Submit button stuck spinning for 8 seconds"
    }
  ]
}
```

These feed the gray (action) and red (anomaly) markers on the workflow scrubber.

#### Why Gemini

Per the QAScribe whitepaper benchmarks, Gemini scores 72.7% on ScreenSpot-Pro for UI element detection vs Claude's 36.2%. It's purpose-built for "where is the button, what does it say, did anything visually go wrong." Claude's reasoning quality is reserved for the synthesis stage where it actually pays off.

### 5.2 Whisper — voice transcription

**File:** `services/stt_service.py`

Whisper receives only the audio track. ffmpeg extracts audio from the video, then sends just that to OpenAI. This is significantly cheaper than sending the whole video to Gemini *and* doing speech-to-text inside Gemini, and it gives higher quality timestamps.

#### Model selection

Whisper is called with `model="whisper-1"`, `response_format="verbose_json"`, `timestamp_granularities=["segment"]`.

**Why whisper-1 specifically (v1 fix)**: the newer `gpt-4o-mini-transcribe` and `gpt-4o-transcribe` models do not support `verbose_json` or segment timestamps. Segment-level timestamps are non-negotiable for aligning voice to actions, so the older model is required. The `stt_service.py` branches on model name:
- `whisper-1` → `verbose_json` with `timestamp_granularities=["segment"]`
- Other models → fall back to plain `json` (no timestamps)

The default is `whisper-1` and should stay that way unless OpenAI ships a successor that supports timestamps.

#### Output — `evidence_bundle.voice_transcript`

```json
{
  "segments": [
    {
      "start": 32.4,
      "end": 38.1,
      "text": "Now I'm checking that the cart icon updates to show the right count"
    },
    {
      "start": 78.0,
      "end": 85.2,
      "text": "Wait, that's a 'something went wrong' error. That should not happen with valid input."
    },
    {
      "start": 102.5,
      "end": 109.0,
      "text": "Strange. Let me retry with a different email and see if it reproduces."
    }
  ]
}
```

These become the cyan (voice annotation) markers on the workflow scrubber and the right-column cards in the workflow timeline.

---

## 6. Stage 4 — The merge step (evidence bundle)

This is the core of the system. Gemini gives you "what visually happened." Whisper gives you "what the tester was thinking out loud." Neither one alone is enough to write a good test case — you need both, aligned in time.

### Algorithm

1. Parse all timestamps to seconds (Gemini returns `MM:SS` strings, Whisper returns float seconds)
2. Tag each event with its `kind`: `action`, `anomaly`, or `voice_annotation`
3. Sort by timestamp ascending
4. **Tie-break order**: `action` (0) → `anomaly` (1) → `voice_annotation` (2)
   - This matches how a human reads a workflow: "I clicked X, then I noticed Y, then I said Z about it"
5. Number sequentially 1..N
6. Persist to `sessions.evidence_bundle` (JSON column)

### Resulting bundle

```json
{
  "events": [
    {"n": 1, "t": 14, "kind": "action",   "description": "Clicked Add to cart"},
    {"n": 2, "t": 32, "kind": "voice",    "description": "Now I'm checking that the cart icon updates..."},
    {"n": 3, "t": 51, "kind": "action",   "description": "Navigated to checkout"},
    {"n": 4, "t": 78, "kind": "anomaly",  "description": "Something went wrong banner appeared"},
    {"n": 5, "t": 102, "kind": "voice",   "description": "Strange. Let me retry with different email..."}
  ]
}
```

This unified stream powers two things:
1. **The workflow timeline endpoint** — `GET /api/sessions/{id}/workflow` reads this bundle directly, no reprocessing
2. **The Claude synthesis prompt** — Claude reasons over this bundle to produce artifacts

The bundle is also durable evidence: if the user later edits an artifact, you can always re-derive what the AI saw versus what was written down.

---

## 7. Stage 5 — Claude synthesis

**File:** `services/synthesis_service.py`

This is where the value proposition crystallizes. The "10 minutes saved per test case" claim is mostly Stage 5 — Claude is replacing the human's "watch video, take notes, type up structured artifact, repeat" loop.

### Skills folder

The `backend/app/skills/` folder contains three SKILL.md files. **These files are versioned content, not code — never modified by AI assistants without explicit approval.**

| Skill | Purpose |
|---|---|
| `test-case-format/SKILL.md` | Defines what a good test case looks like — structure, tone, validation tagging, scope rules |
| `bug-report-template/SKILL.md` | Defines bug report shape — severity, priority, evidence_timestamps, tester_notes |
| `coverage-gap-analysis/SKILL.md` | Defines what counts as a real coverage gap (evidence-backed) vs speculation |

The skills encode lessons learned from grading real output. Updates to these files improve quality without changing code.

### Synthesis flow

For each of the three artifact types, Claude is invoked separately with a focused prompt:

#### 1. Test cases

**System prompt** loads `test-case-format/SKILL.md`. Key rules from v2 improvements:
- Never generate test cases for things the tester didn't actually perform
- If recording starts mid-flow, only generate tests for what was recorded
- Steps must be ACTIONS (`Click X`, `Type Y`), not state assertions (`Ensure field contains X`)
- Each test case tagged with `validation_type`: `validation:browser-native` / `validation:application` / `validation:server-side`

**User message** includes the full evidence bundle and: "Generate test cases following the rules in the skill. Return as JSON array."

**Claude returns** a JSON array of test case objects, each with `title`, `preconditions`, `steps`, `expected_result`, `validation_type`, `tags`.

#### 2. Bug reports

**System prompt** loads `bug-report-template/SKILL.md`. Key rules:
- Each bug must reference specific `evidence_timestamps` from the bundle
- Severity (critical / high / medium / low) and priority (P1–P4) required
- If a bug masks a separate test case, explicitly add to `tester_notes`: "This bug blocks verification of [specific test case]. Re-test happy path after bug fix."

**Claude returns** a JSON array of bug report objects with `title`, `severity`, `priority`, `evidence_timestamps`, `description`, `tester_notes`.

#### 3. Coverage gaps

**System prompt** loads `coverage-gap-analysis/SKILL.md`. Key rules:
- Every gap must be evidence-backed; `related_tested_flow` must reference an action that actually appears in the action log
- If tester verbally mentioned a UI element they didn't interact with, mark `priority: "low"` and note "Inferred from tester narration"
- Cap output at 10 most important gaps

**Claude returns** a JSON array of coverage gap objects with `title`, `description`, `priority`, `related_tested_flow`.

### Why Claude

Stage 5 is pure structured reasoning over text — there's no video, no audio anymore, just JSON describing what happened. Claude is best-in-class at "given this messy evidence, produce this clean structured output following these specific rules" tasks. Skills support also gives clean evolution paths: improving output quality is editing markdown, not editing code.

---

## 8. Stage 6 — Storage and rendering

Each artifact returned by Claude is persisted as a row in the `artifacts` table:

```sql
artifacts:
  id              UUID PK
  session_id      UUID FK → sessions
  artifact_type   ENUM('test_case', 'bug_report', 'coverage_gap')
  content         JSONB    -- the structured artifact
  evidence_timestamps  TEXT[]  -- timestamps this artifact references
  user_edited     BOOLEAN DEFAULT false
  created_at      TIMESTAMP
  updated_at      TIMESTAMP
```

When the synthesis stage completes, the session row is updated:
- `status` → `completed`
- `actual_cost_usd` → sum of all three API calls' actual costs
- `error_message` cleared (if any)

### Frontend rendering

The `GET /api/sessions/{id}/workflow` endpoint produces the timeline view:

1. Reads `session.evidence_bundle` from the row (no re-processing)
2. For each anomaly in the bundle, scans bug report artifacts and links them via `evidence_timestamps` overlap
3. Returns `WorkflowStep[]` with `kind`, `summary`, `details`, `linked_artifact_ids`

This is what renders the workflow timeline with color-coded markers (gray / cyan / red) and step cards on the right side, with anomaly steps showing "linked to bug #N" when a matching bug report exists.

---

## 9. Why three different AI providers

A common reaction: "couldn't this all be done with one model?" Technically yes — Gemini can do speech-to-text, Claude can analyze video frames, OpenAI's models can write structured artifacts. But each option degrades quality somewhere:

| Approach | What you lose |
|---|---|
| All-Gemini | Worse synthesis quality (Claude leads on structured reasoning) and worse audio transcription with timestamps |
| All-Claude | Dramatically worse video perception (36.2% vs Gemini's 72.7% on UI element detection) |
| All-OpenAI | No equivalent best-in-class video perception model |

The multi-model approach is also the moat. Because every model identifier and price lives in `.env` and `core/config.py`, you can:
- Swap providers when a better model ships
- Run dev tier (~$0.05/min) and prod tier (~$0.30/min) from the same codebase
- A/B test model changes without touching application code
- React to pricing changes in any one provider without affecting the others

Never hard-code `gemini-3-pro` or `claude-opus-4-7` anywhere outside `config.py`. Every model identifier in the codebase must come from environment variables.

---

## 10. Failure modes and recovery

The pipeline has multiple failure points, each handled differently.

### Pre-flight failures (Stage 2)

- **Cost over budget** → HTTP 402, no video stored, user sees clear error
- **Video too long / too large** → HTTP 413, immediate rejection
- **ffprobe missing** → HTTP 500 with friendly message guiding user to install ffmpeg
- **MinIO unreachable** → HTTP 503

These are fast failures. No money spent, no async work queued.

### Async pipeline failures (Stages 3–5)

The Celery task wraps each stage with try/except. On failure:

- Session row updated to `status='failed'`, `error_message=<reason>`
- Partial cost (whatever stages ran) recorded to `actual_cost_usd`
- Frontend displays the failed state with the error and a retry button

Common failure modes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `FAILED_PRECONDITION: File not in ACTIVE state` | Missing Gemini polling loop | Verify `gemini_service.py` polling is intact |
| `verbose_json not compatible with model X` | Wrong Whisper model | Confirm `STT_MODEL=whisper-1` in `.env` |
| `503 UNAVAILABLE` from Gemini | Transient API throttling | Retry-with-backoff (see future enhancement) |
| `Event loop is closed` (Windows + Python 3.14) | asyncpg / proactor loop edge case | Downgrade to Python 3.12 |
| Celery `PermissionError [WinError 5]` | Default prefork pool on Windows | `--pool=solo` (auto-detected) |
| `column sessions.test_focus does not exist` | v1 → v2 schema drift | `docker-compose down -v && docker-compose up -d` |

### Partial-failure handling

The pipeline does not currently support partial completion (e.g. Gemini succeeds but Whisper fails → use action log only). A failure in any stage fails the whole task. This is a deliberate v2 scope choice — partial results would mean degraded artifact quality, which violates the "production-grade output" promise.

---

## 11. Cost control architecture

The four-layer cost control is the moat for shipping this to real users without surprise bills.

### Layer 1 — Pre-flight estimation

Calculated in `cost_guard.py` before any API call. Uses video duration × per-minute cost × safety multiplier. Rejects upfront if estimate exceeds any budget tier.

### Layer 2 — Hard caps

- 60 minute max video duration (recording auto-stops at 59:30, warns at 55:00)
- 500 MB max file size (enforced client-side and server-side)

### Layer 3 — Spend tracking

Two tables:
- `spend_records` — append-only log of every API call's actual cost
- `users.monthly_budget_usd` — per-user budget (default $50)

A pre-call check sums recent spend before each new task. Global daily check sums across all users. Either limit being exceeded blocks new submissions.

### Layer 4 — Provider-side limits

Every API key has a per-provider monthly hard cap configured in the vendor console (Anthropic, OpenAI, Google AI Studio). This is the last line of defense if the application logic has a bug.

### Defaults (configurable in `.env`)

```bash
PER_JOB_MAX_USD=5.00
DEFAULT_USER_MONTHLY=50.00
GLOBAL_DAILY=200.00
SAFETY_MULTIPLIER=1.25
```

---

## 12. Where to make changes

A quick reference for "if I want to change X, where do I look?"

| You want to... | Look at | Notes |
|---|---|---|
| Swap a model | `backend/.env` only | Never hard-code model IDs |
| Change cost guard rules | `backend/app/services/cost_guard.py` | **Locked — 14 tests guard this. Modifying breaks the moat.** |
| Improve test case quality | `backend/app/skills/test-case-format/SKILL.md` | Versioned content; commit messages should explain quality intent |
| Improve bug report quality | `backend/app/skills/bug-report-template/SKILL.md` | Same |
| Improve coverage gap quality | `backend/app/skills/coverage-gap-analysis/SKILL.md` | Same |
| Change recording behavior | `frontend/src/hooks/useScreenRecorder.ts` | Eight edge cases enumerated in JSDoc — preserve all of them |
| Change workflow merge logic | `backend/app/api/sessions.py` (workflow endpoint) | Tie-break order: action (0) → anomaly (1) → voice (2) |
| Change Gemini prompt | `backend/app/services/gemini_service.py` | The polling loop must remain intact |
| Change Whisper params | `backend/app/services/stt_service.py` | Stay on `whisper-1` until a successor supports segment timestamps |
| Change Claude prompts | `backend/app/services/synthesis_service.py` | Skills are loaded into the system prompt — don't duplicate skill content here |
| Add a new artifact type | Multiple files: new skill, synthesis service update, schema, API, types | Larger change — propose plan first |

### Hard rules (non-negotiable)

1. Never modify `backend/app/services/cost_guard.py` — 14 tests guard it
2. Never modify files in `backend/app/skills/` without explicit approval — they are versioned content, not code
3. Never call any AI API outside the existing services (`gemini_service`, `stt_service`, `synthesis_service`)
4. Never change the database schema — use aggregation queries instead
5. Never add new dependencies without checking lockfile diff and asking
6. All model identifiers and prices must stay in `backend/app/core/config.py` (read from `.env`)
7. Never touch authentication — stub `get_current_user` stays as-is
8. Always propose a plan before writing code, wait for approval
9. Always run pytest after backend changes
10. Make changes minimal and surgical — don't refactor adjacent code

---

## Appendix A — Sequence diagram (a single session)

```
Tester      Frontend         API           Worker        Gemini      Whisper      Claude       MinIO       Postgres
  │            │              │              │             │            │           │            │            │
  │ record/upload             │              │             │            │           │            │            │
  ├───────────▶│              │              │             │            │           │            │            │
  │            │ POST /sessions              │             │            │           │            │            │
  │            ├─────────────▶│              │             │            │           │            │            │
  │            │              │ cost_guard   │             │            │           │            │            │
  │            │              ├──────────────┤             │            │           │            │            │
  │            │              │ store video  │             │            │           │            │            │
  │            │              ├─────────────────────────────────────────────────────────────────▶│            │
  │            │              │ insert session row                                                            │
  │            │              ├─────────────────────────────────────────────────────────────────────────────▶│
  │            │              │ enqueue process_session                                                       │
  │            │              ├─────────────▶│             │            │           │            │            │
  │            │  202 Accepted │              │             │            │           │            │            │
  │            │◀─────────────┤              │             │            │           │            │            │
  │            │              │              │ fetch video │            │           │            │            │
  │            │              │              ├──────────────────────────────────────────────────▶│            │
  │            │              │              │             │            │           │            │            │
  │            │              │              │ ┌── parallel ──────────────────────────────┐      │            │
  │            │              │              │ │ analyze video                             │      │            │
  │            │              │              │ ├────────────▶                              │      │            │
  │            │              │              │ │             │ poll until ACTIVE          │      │            │
  │            │              │              │ │             │ generate_content           │      │            │
  │            │              │              │ │ action_log  │                            │      │            │
  │            │              │              │ │◀────────────                              │      │            │
  │            │              │              │ │                                            │      │            │
  │            │              │              │ │ extract audio + transcribe                │      │            │
  │            │              │              │ ├────────────────────────▶                  │      │            │
  │            │              │              │ │ voice_transcript                          │      │            │
  │            │              │              │ │◀────────────────────────                  │      │            │
  │            │              │              │ └─────────────────────────────────────────────┘   │            │
  │            │              │              │                                                    │            │
  │            │              │              │ merge → evidence_bundle                            │            │
  │            │              │              │                                                    │            │
  │            │              │              │ for each (test_cases, bug_reports, coverage_gaps): │            │
  │            │              │              ├──────────────────────────────────────▶ skill+bundle             │
  │            │              │              │                                        │ artifacts │            │
  │            │              │              │◀──────────────────────────────────────                          │
  │            │              │              │                                                                 │
  │            │              │              │ persist artifacts + update session status='completed'           │
  │            │              │              ├────────────────────────────────────────────────────────────────▶│
  │            │              │              │                                                                 │
  │            │ poll /sessions/{id}         │                                                                 │
  │            ├─────────────▶│              │                                                                 │
  │            │              │ read         │                                                                 │
  │            │              ├────────────────────────────────────────────────────────────────────────────────▶│
  │            │              │ session + artifact counts                                                       │
  │            │              │◀───────────────────────────────────────────────────────────────────────────────│
  │            │ render workflow + artifacts │                                                                 │
  │            │◀─────────────│              │                                                                 │
```

---

## Appendix B — File map (where things live)

```
backend/app/
├── api/
│   ├── sessions.py             # POST /sessions, GET workflow, etc.
│   ├── config.py               # GET /config/models (Settings page reads this)
│   └── schemas.py              # All Pydantic request/response schemas
├── core/
│   ├── config.py               # ★ Model IDs and prices loaded from .env
│   └── db.py                   # Async SQLAlchemy engine
├── models/
│   └── spend.py                # User, Session, Artifact, SpendRecord
├── services/
│   ├── cost_guard.py           # ★★★ Pre-flight cost enforcement (LOCKED)
│   ├── gemini_service.py       # Video perception (with ACTIVE polling)
│   ├── stt_service.py          # Whisper transcription (whisper-1 branch)
│   ├── synthesis_service.py    # Claude artifact generation
│   ├── storage.py              # MinIO/S3 operations
│   └── video_probe.py          # ffprobe wrapper
├── skills/                     # ★ Versioned content, not code
│   ├── test-case-format/SKILL.md
│   ├── bug-report-template/SKILL.md
│   └── coverage-gap-analysis/SKILL.md
└── workers/
    └── celery_app.py           # process_session task, Windows pool detection

frontend/src/
├── hooks/
│   ├── useScreenRecorder.ts    # ★ 8 edge cases — preserve all
│   └── useBrowserSupport.ts
├── pages/
│   ├── DashboardPage.tsx
│   ├── NewSessionPage.tsx
│   ├── SessionDetailPage.tsx   # Workflow timeline + artifact tabs
│   └── SettingsPage.tsx
└── components/
    ├── AppShell.tsx            # Sidebar + Outlet
    ├── BudgetBar.tsx
    ├── StatusPill.tsx
    ├── RecordingBar.tsx
    └── Toast.tsx
```

---

*Last updated: April 2026. Update this document when the pipeline architecture changes — not when individual prompts or model versions change (those live in `.env` and skill files).*
