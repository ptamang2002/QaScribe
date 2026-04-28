"""Gemini video perception. ALL calls go through CostGuard.

Critical fix included from v1: poll file state until ACTIVE before
calling generate_content. Gemini Files API processes uploads
asynchronously and rejects requests against PROCESSING files.
"""
import json
import logging
import time
from typing import Any

from google import genai
from google.genai import types

from app.core.config import get_settings
from app.services.cost_guard import (
    ActualCost, CostGuard, Provider, estimate_gemini_video_cost,
)

logger = logging.getLogger(__name__)
settings = get_settings()


PERCEPTION_PROMPT = """You are analyzing a QA testing session screen recording.

Extract a structured action log of what happened in this video. For each
significant event, capture:
  - timestamp (MM:SS)
  - action_type: one of [click, type, navigate, scroll, error_observed, ui_state_change, wait]
  - target: what the tester interacted with (button text, field name, URL, etc.)
  - observation: what visibly happened (page loaded, error appeared, modal opened)
  - screen_context: brief description of the screen/page

Also identify:
  - flows_observed: list of user flows the tester exercised (e.g. "login", "checkout")
  - errors_or_anomalies: any visible bugs, crashes, broken UI, slow loads
  - ui_components_touched: UI elements interacted with

Return JSON ONLY in this schema:
{
  "actions": [{"timestamp": "MM:SS", "action_type": "...", "target": "...",
               "observation": "...", "screen_context": "..."}],
  "flows_observed": ["..."],
  "errors_or_anomalies": [{"timestamp": "MM:SS", "description": "..."}],
  "ui_components_touched": ["..."]
}
"""


class GeminiPerceptionService:
    def __init__(self):
        self.client = genai.Client(api_key=settings.GOOGLE_API_KEY)

    async def analyze_video(
        self,
        video_path: str,
        duration_seconds: float,
        cost_guard: CostGuard,
        media_resolution: str = "low",
    ) -> dict[str, Any]:
        """Analyze a video and return structured action log.

        cost_guard MUST already have approved this call via check_pipeline_budget.
        """
        estimate = estimate_gemini_video_cost(duration_seconds, media_resolution)
        logger.info(
            "Gemini call: duration=%.0fs estimate=$%.4f model=%s",
            duration_seconds, estimate.estimated_cost_usd, settings.GEMINI_MODEL,
        )

        # Upload to Gemini Files API
        uploaded_file = self.client.files.upload(file=video_path)
        logger.info("Uploaded to Gemini, file=%s state=%s",
                    uploaded_file.name, uploaded_file.state)

        # Poll until ACTIVE — Gemini processes uploaded videos asynchronously
        # and rejects requests against files still in PROCESSING state.
        max_wait_seconds = 300
        poll_interval = 2
        elapsed = 0
        while uploaded_file.state.name == "PROCESSING":
            if elapsed >= max_wait_seconds:
                raise RuntimeError(
                    f"Gemini file processing timed out after {max_wait_seconds}s "
                    f"for file {uploaded_file.name}"
                )
            time.sleep(poll_interval)
            elapsed += poll_interval
            uploaded_file = self.client.files.get(name=uploaded_file.name)
            logger.info("Waiting for Gemini file: state=%s elapsed=%ds",
                        uploaded_file.state.name, elapsed)

        if uploaded_file.state.name != "ACTIVE":
            raise RuntimeError(
                f"Gemini file ended in non-ACTIVE state: {uploaded_file.state.name}"
            )

        logger.info("Gemini file ACTIVE after %ds, calling generate_content", elapsed)

        response = self.client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[
                uploaded_file,
                PERCEPTION_PROMPT,
            ],
            config=types.GenerateContentConfig(
                media_resolution=(
                    "media_resolution_low" if media_resolution == "low"
                    else "media_resolution_medium"
                ),
                response_mime_type="application/json",
            ),
        )

        # Record ACTUAL cost from API response usage metadata
        usage = response.usage_metadata
        actual_input_tokens = usage.prompt_token_count
        actual_output_tokens = usage.candidates_token_count
        actual_cost = (
            (actual_input_tokens / 1_000_000) * settings.GEMINI_INPUT_PRICE_PER_M
            + (actual_output_tokens / 1_000_000) * settings.GEMINI_OUTPUT_PRICE_PER_M
        )
        await cost_guard.record_actual(ActualCost(
            provider=Provider.GEMINI,
            input_tokens=actual_input_tokens,
            output_tokens=actual_output_tokens,
            cost_usd=actual_cost,
        ))

        # Clean up uploaded file
        try:
            self.client.files.delete(name=uploaded_file.name)
        except Exception as e:
            logger.warning("Failed to delete Gemini file: %s", e)

        return json.loads(response.text)
