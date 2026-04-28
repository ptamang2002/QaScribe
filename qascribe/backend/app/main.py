"""FastAPI application entry point."""
import logging
import time
import traceback

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import artifacts, config as config_api, sessions
from app.core.config import get_settings
from app.core.db import engine
from app.models.spend import Base

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
access_logger = logging.getLogger("qascribe.access")

settings = get_settings()

app = FastAPI(
    title="AI-QAScribe API",
    description="QA testing session → structured artifacts via multi-model AI",
    version="2.0.0",
)

# CORS — open regex covers any localhost port (dev convenience)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log every request — helps debug network/CORS issues."""
    start = time.time()
    access_logger.info(f"--> {request.method} {request.url.path}")
    try:
        response = await call_next(request)
        elapsed = (time.time() - start) * 1000
        access_logger.info(
            f"<-- {request.method} {request.url.path} {response.status_code} ({elapsed:.0f}ms)"
        )
        return response
    except Exception as e:
        access_logger.exception(f"!!! {request.method} {request.url.path} crashed: {e}")
        raise


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """In dev, return error details to the browser; in prod, generic 500."""
    logger.exception(
        "Unhandled error on %s %s: %s",
        request.method, request.url.path, exc,
    )
    if settings.APP_ENV == "development":
        return JSONResponse(
            status_code=500,
            content={
                "error": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc().splitlines(),
            },
        )
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


app.include_router(sessions.router)
app.include_router(artifacts.router)
app.include_router(config_api.config_router)
app.include_router(config_api.users_router)


@app.on_event("startup")
async def startup() -> None:
    if settings.APP_ENV == "development":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": "2.0.0"}
