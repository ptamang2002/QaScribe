"""Config + user management routers."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import ModelConfigResponse, UserResponse, UserUpdateRequest
from app.api.sessions import get_current_user
from app.core.config import get_settings
from app.core.db import get_db
from app.models.spend import User

settings = get_settings()

config_router = APIRouter(prefix="/api/config", tags=["config"])
users_router = APIRouter(prefix="/api/users", tags=["users"])


@config_router.get("/models", response_model=ModelConfigResponse)
async def get_model_config():
    """Returns models in use + current pricing. Used by the Settings page."""
    return ModelConfigResponse(
        gemini_model=settings.GEMINI_MODEL,
        stt_model=settings.OPENAI_STT_MODEL,
        claude_model=settings.CLAUDE_MODEL,
        gemini_input_price_per_m=settings.GEMINI_INPUT_PRICE_PER_M,
        gemini_output_price_per_m=settings.GEMINI_OUTPUT_PRICE_PER_M,
        stt_price_per_minute=settings.OPENAI_STT_PRICE_PER_MINUTE,
        claude_input_price_per_m=settings.CLAUDE_INPUT_PRICE_PER_M,
        claude_output_price_per_m=settings.CLAUDE_OUTPUT_PRICE_PER_M,
        per_job_max_usd=settings.PER_JOB_MAX_USD,
        max_video_duration_seconds=settings.MAX_VIDEO_DURATION_SECONDS,
        max_video_file_size_mb=settings.MAX_VIDEO_FILE_SIZE_MB,
    )


@users_router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(get_current_user)):
    return UserResponse(
        id=user.id,
        email=user.email,
        monthly_budget_usd=user.monthly_budget_usd,
    )


@users_router.patch("/me", response_model=UserResponse)
async def update_me(
    payload: UserUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user.monthly_budget_usd = payload.monthly_budget_usd
    await db.commit()
    await db.refresh(user)
    return UserResponse(
        id=user.id,
        email=user.email,
        monthly_budget_usd=user.monthly_budget_usd,
    )
