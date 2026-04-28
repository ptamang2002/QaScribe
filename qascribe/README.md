# AI-QAScribe

Convert QA testing session recordings (video + voice) into structured artifacts: test cases, bug reports, and coverage gap analysis. Multi-model AI pipeline (Gemini + Whisper + Claude). Built-in screen + voice recording. Production-grade cost controls.

## Features
- 📤 **Upload** existing testing recordings (MP4, MOV, WebM)
- 🎬 **Record in browser** — screen + microphone + tab audio, all in one click
- 🎯 **Workflow timeline** — every step the tester took, interleaved with voice annotations and anomaly markers
- 🐛 **AI artifacts** — test cases, bug reports, coverage gap analysis, all editable inline
- 💰 **4-layer cost controls** — pre-flight estimation, hard caps, per-user budgets, global daily circuit breaker
- 🔄 **Models swappable** — edit `.env`, restart, done

## Quick start (Windows / macOS / Linux)

### Prerequisites
- Python 3.11+ (Python 3.14 supported)
- Node.js 20+
- Docker + Docker Compose
- ffmpeg (`winget install ffmpeg` on Windows, `brew install ffmpeg` on Mac, `apt install ffmpeg` on Linux)
- API keys: Anthropic, OpenAI, Google AI

Verify ffmpeg with `ffprobe -version`. **If you install ffmpeg, restart your terminal so PATH refreshes.**

### Step 1 — Infrastructure
```bash
docker-compose up -d
```
Spins up Postgres, Redis, and MinIO (S3-compatible object storage).

### Step 2 — Backend

**Windows (PowerShell or Command Prompt):**
```cmd
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -e .
copy .env.example .env
```

**macOS / Linux:**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env
```

Edit `.env` and fill in your three API keys.

Then run:
```bash
uvicorn app.main:app --reload --port 8000
```

### Step 3 — Worker (separate terminal)

```cmd
cd backend
.venv\Scripts\activate
celery -A app.workers.celery_app worker --loglevel=info --pool=solo
```

(The `--pool=solo` flag is required on Windows. The worker auto-detects this; the flag is just explicit.)

### Step 4 — Frontend (separate terminal)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Cost control — the most important feature

Four defensive layers, all configurable in `backend/.env`:

| Layer | Where | What it does |
|---|---|---|
| 1. Pre-flight estimation | API + worker | Calculate predicted cost from video duration before any API call |
| 2. Hard caps | Upload validation | Reject videos longer or larger than configured limits |
| 3. Spend tracking | Postgres `spend_records` | Per-user monthly budget + global daily circuit breaker |
| 4. Provider-side | Anthropic / OpenAI / Google consoles | Final emergency brake (you set these in vendor accounts) |

```bash
# .env
PER_JOB_MAX_USD=5.00
DEFAULT_USER_MONTHLY_BUDGET_USD=50.00
GLOBAL_DAILY_BUDGET_USD=200.00
MAX_VIDEO_DURATION_SECONDS=3600     # 60 min
MAX_VIDEO_FILE_SIZE_MB=500
```

## Swapping models (dev ↔ prod)

`.env` ships with two blocks. Comment out one, uncomment the other:

```bash
# DEVELOPMENT TIER (cheap, ~$0.05/min)
GEMINI_MODEL=gemini-2.5-flash
GEMINI_INPUT_PRICE_PER_M=0.075
GEMINI_OUTPUT_PRICE_PER_M=0.30
CLAUDE_MODEL=claude-sonnet-4-6
CLAUDE_INPUT_PRICE_PER_M=3.00
CLAUDE_OUTPUT_PRICE_PER_M=15.00

# PRODUCTION TIER (best quality, ~$0.30/min)
# GEMINI_MODEL=gemini-3-pro
# GEMINI_INPUT_PRICE_PER_M=2.00
# GEMINI_OUTPUT_PRICE_PER_M=12.00
# CLAUDE_MODEL=claude-opus-4-7
# CLAUDE_INPUT_PRICE_PER_M=5.00
# CLAUDE_OUTPUT_PRICE_PER_M=25.00
```

Restart uvicorn + celery. Confirm in Settings page that the new model names appear.

## In-browser recording

Click **New session → Record now**. The flow:
1. Pick source: Browser tab / Window / Entire screen
2. Select microphone, optionally enable system audio
3. Start recording. Auto-stops at 59:30 (configurable).
4. Preview the recording. Use it or discard.
5. If used: same upload + estimate + process pipeline as a file upload.

**Browser support**: Chrome / Edge fully supported. Firefox supported. Safari supports mic-only (the app detects this and shows an info banner).

**The "Share tab audio" checkbox**: when picking a browser tab, check the box in the picker dialog to capture page sounds. Otherwise you'll get mic-only audio (the app warns you).

## Tests
```bash
cd backend
pytest
```

The cost guard tests are the most important — they verify all 4 budget defense layers.

## Troubleshooting

### "Network Error" in upload UI, no backend log
- CORS or backend not running. Check `curl http://localhost:8000/health`.
- Backend's CORS config allows any localhost port via regex — should "just work."

### 500 error: "ffprobe not found"
- ffmpeg not on PATH. Install with `winget install ffmpeg`, then **restart all terminals**.

### Celery on Windows: `PermissionError: [WinError 5]`
- The default `prefork` pool doesn't work on Windows. Use `--pool=solo` or `--pool=threads`. The app config already sets `solo` on Windows automatically.

### Gemini error: "File is not in an ACTIVE state"
- Already handled — the service polls until ACTIVE before calling generate_content. If you see this again, check the celery log for the polling output.

### OpenAI STT: "response_format 'verbose_json' is not compatible"
- We use `whisper-1` which supports `verbose_json` with timestamps. Don't switch back to `gpt-4o-mini-transcribe` without losing timestamp alignment.

### Recording: the browser red-dot stays after stopping
- Bug we already fixed — `stream.getTracks().forEach(t => t.stop())` runs on cleanup. If you still see it, refresh the tab.

### Recording: tab audio missing
- User didn't tick "Share tab audio" in the picker. App shows a warning banner; recording still works mic-only.

## API quick reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sessions/estimate` | Pre-flight cost preview |
| POST | `/api/sessions` | Upload + queue processing |
| GET | `/api/sessions/{id}` | Session status |
| GET | `/api/sessions/{id}/artifacts` | All artifacts |
| GET | `/api/sessions/{id}/workflow` | Step-by-step merged timeline |
| GET | `/api/sessions/{id}/video` | Presigned S3 URL for playback |
| GET | `/api/sessions` | List sessions (paginated) |
| PUT | `/api/sessions/{id}/artifacts/{aid}` | Inline edit artifact |
| DELETE | `/api/sessions/{id}/artifacts/{aid}` | Reject/delete artifact |
| GET | `/api/sessions/dashboard/stats` | Dashboard 4 metrics |
| GET | `/api/sessions/budget/status` | Live budget |
| GET | `/api/config/models` | Models + prices in use |
| PATCH | `/api/users/me` | Update monthly budget |

## Roadmap (future enhancements you'll request via Claude Code)
- Real auth (JWT + login/signup)
- Jira / Linear push integration via MCP
- Team workspaces
- Webcam picture-in-picture in recording
- AI-suggested skill improvements based on user edits
- Multi-language voice transcription
