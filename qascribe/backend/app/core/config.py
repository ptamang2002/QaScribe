"""Application configuration — single source of truth for models, pricing, and budgets."""
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ============================================================
    #  Core
    # ============================================================
    APP_ENV: str = "development"
    DEBUG: bool = True
    SECRET_KEY: str = Field(default="change-me-in-production")

    # ============================================================
    #  Infrastructure
    # ============================================================
    DATABASE_URL: str = "postgresql+asyncpg://qa:qa@localhost:5432/qascribe"
    REDIS_URL: str = "redis://localhost:6379/0"
    S3_ENDPOINT_URL: str = "http://localhost:9000"
    S3_BUCKET: str = "qascribe-uploads"
    S3_ACCESS_KEY: str = "minioadmin"
    S3_SECRET_KEY: str = "minioadmin"

    # ============================================================
    #  AI provider keys
    # ============================================================
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    GOOGLE_API_KEY: str = ""

    # ============================================================
    #  Model identifiers — swap by editing .env
    # ============================================================
    GEMINI_MODEL: str = "gemini-2.5-flash"
    OPENAI_STT_MODEL: str = "whisper-1"
    CLAUDE_MODEL: str = "claude-sonnet-4-6"

    # ============================================================
    #  Pricing (USD per 1M tokens unless noted)
    #  Update when you swap models in .env
    # ============================================================
    GEMINI_INPUT_PRICE_PER_M: float = 0.075   # 2.5 Flash dev tier; 2.00 for 3 Pro
    GEMINI_OUTPUT_PRICE_PER_M: float = 0.30   # 2.5 Flash; 12.00 for 3 Pro
    GEMINI_TOKENS_PER_VIDEO_SECOND_DEFAULT: int = 300
    GEMINI_TOKENS_PER_VIDEO_SECOND_LOW: int = 100
    GEMINI_AUDIO_TOKENS_PER_SECOND: int = 32

    OPENAI_STT_PRICE_PER_MINUTE: float = 0.006  # whisper-1; 0.003 for gpt-4o-mini-transcribe

    CLAUDE_INPUT_PRICE_PER_M: float = 3.00    # Sonnet 4.6; 5.00 for Opus 4.7
    CLAUDE_OUTPUT_PRICE_PER_M: float = 15.00  # Sonnet 4.6; 25.00 for Opus 4.7

    # ============================================================
    #  Budget controls — defense layers
    # ============================================================
    MAX_VIDEO_DURATION_SECONDS: int = 3600
    MAX_VIDEO_FILE_SIZE_MB: int = 500

    PER_JOB_MAX_USD: float = 5.00
    DEFAULT_USER_MONTHLY_BUDGET_USD: float = 50.00
    GLOBAL_DAILY_BUDGET_USD: float = 200.00
    BUDGET_SAFETY_MULTIPLIER: float = 1.25

    # ============================================================
    #  Productivity heuristics
    # ============================================================
    MINUTES_SAVED_PER_TESTCASE: int = 10  # for "hours saved" dashboard metric


@lru_cache
def get_settings() -> Settings:
    return Settings()
