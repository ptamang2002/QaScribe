# AI-QAScribe — Claude Code Instructions

## What this project is
AI-QAScribe converts QA testing session recordings (video + voice annotations) into structured artifacts: test cases, bug reports, and coverage gap analysis. It has both an upload flow and an in-browser screen+voice recording flow.

**Architecture**: Python/FastAPI backend + React/TypeScript/Vite frontend + multi-model AI pipeline:
- **Gemini** (default `gemini-2.5-flash`, swap to `gemini-3-pro` for prod) — video perception
- **OpenAI Whisper** (`whisper-1`) — voice transcription with timestamps
- **Claude** (default `claude-sonnet-4-6`, swap to `claude-opus-4-7` for prod) — artifact synthesis

## Critical rules (non-negotiable)

### Cost control
ALL AI calls must go through `app.services.cost_guard.CostGuard`. Never call any AI API directly. Four layers of defense are implemented (pre-flight, hard caps, spend tracking, provider-side). Tests in `tests/test_cost_guard.py` must pass.

### Models stay swappable
All model identifiers and prices live in `backend/.env` (loaded via `app/core/config.py`). Swapping models = editing `.env` + restarting services. Never hard-code model names like "gemini-3-pro" or "claude-opus-4-6" anywhere outside config.

### Skills are versioned content
Custom skills live in `backend/app/skills/`. Edit the SKILL.md files to change artifact format/heuristics. No code changes required.

### Database
Use SQLAlchemy 2.0 async style. No schema migrations needed for this version — auto-create tables on startup in dev. Use Alembic when going to prod.

## Repo structure
```
backend/
  app/
    api/              # FastAPI routers + Pydantic schemas
    core/             # config, db, settings
    models/           # SQLAlchemy models (User, Session, Artifact, SpendRecord)
    services/         # business logic
      cost_guard.py   # ★ CRITICAL — never modify without explicit instruction
      gemini_service.py
      stt_service.py
      synthesis_service.py
      storage.py
      video_probe.py
    skills/           # ★ Custom AI skills (markdown)
    workers/          # Celery tasks
  tests/
frontend/
  src/
    api/              # axios client
    components/       # reusable UI
    hooks/            # custom hooks (useScreenRecorder, etc.)
    pages/            # route pages
    types/            # shared TypeScript types
```

## Pages and routes
- `/` — Dashboard (metrics, session list)
- `/sessions/new` — New session (upload OR record in browser)
- `/sessions/:id` — Session detail with sub-tabs (Workflow / Test cases / Bugs / Coverage / Transcript)
- `/settings` — Models in use, pricing, budget, recording defaults

## How to run locally

```bash
# Infrastructure
docker-compose up -d         # postgres, redis, minio

# Backend (Windows: use .venv\Scripts\activate)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env         # then fill API keys
uvicorn app.main:app --reload --port 8000

# Worker (separate terminal)
cd backend && source .venv/bin/activate
celery -A app.workers.celery_app worker --loglevel=info --pool=solo

# Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Stub auth creates a default dev user automatically.

## Common tasks

### Swap models (dev → prod)
1. Edit `backend/.env`: comment out dev block, uncomment prod block (both blocks present in .env.example)
2. Restart uvicorn + celery
3. Verify in Settings page that new model names appear

### Add a new artifact type
1. Add a skill in `backend/app/skills/`
2. Add it to `SynthesisService.generate_artifacts` artifact_types list
3. Add a UI sub-tab in `SessionDetailPage.tsx`

### Debug a failed session
1. Check celery terminal for traceback
2. Check `sessions.error_message` in DB
3. Provider-side issues: check Anthropic/OpenAI/Google consoles

## What NOT to do
- ❌ Bypass cost_guard for "small" calls
- ❌ Hard-code model names outside config
- ❌ Modify skills via code (they're content)
- ❌ Add authentication beyond the stub (out of scope)
- ❌ Add new dependencies without checking lockfile diff
- ❌ Store raw video files in DB (S3/MinIO only)
- ❌ Log full transcripts (PII)

## Industry-standard recording defaults
- Resolution: 1080p
- Frame rate: 30 fps
- Codec: H.264 / MP4 (fallback to WebM/VP9)
- Audio: 128 kbps AAC stereo, mic + system audio as separate tracks where supported
- Max duration: 60 min hard cap (auto-stop at 59:30)
