"""Claude artifact synthesis. Uses skills to enforce output formats."""
import json
import logging
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

from app.core.config import get_settings
from app.services.cost_guard import (
    ActualCost, CostGuard, Provider, estimate_claude_synthesis_cost,
)

logger = logging.getLogger(__name__)
settings = get_settings()

SKILLS_DIR = Path(__file__).parent.parent / "skills"


def load_skill(skill_name: str) -> str:
    skill_path = SKILLS_DIR / skill_name / "SKILL.md"
    if not skill_path.exists():
        raise FileNotFoundError(f"Skill not found: {skill_name}")
    return skill_path.read_text()


SYNTHESIS_SYSTEM = """You are a senior QA engineer assistant. You convert
testing session evidence into structured artifacts.

You will be given:
  1. An action log from a screen recording (timestamps, clicks, observations)
  2. Optionally, a transcript of the tester's voice annotations
  3. Skills (instructions and templates) for the artifact types to produce

Produce the requested artifacts as JSON. Be precise — use exact UI labels and
timestamps from the evidence. Never invent details. If something is uncertain,
note it in the artifact rather than guessing.
"""


class SynthesisService:
    def __init__(self):
        self.client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)

    async def generate_artifacts(
        self,
        evidence_bundle: dict[str, Any],
        cost_guard: CostGuard,
        artifact_types: list[str] | None = None,
    ) -> dict[str, list[dict]]:
        artifact_types = artifact_types or ["test_cases", "bug_reports", "coverage_gaps"]

        skills_text = ""
        skill_map = {
            "test_cases": "test-case-format",
            "bug_reports": "bug-report-template",
            "coverage_gaps": "coverage-gap-analysis",
        }
        for atype in artifact_types:
            if atype in skill_map:
                skills_text += f"\n\n=== SKILL: {skill_map[atype]} ===\n"
                skills_text += load_skill(skill_map[atype])

        evidence_json = json.dumps(evidence_bundle, indent=2)
        user_prompt = (
            f"EVIDENCE BUNDLE:\n```json\n{evidence_json}\n```\n\n"
            f"SKILLS:\n{skills_text}\n\n"
            f"Generate the following artifact types: {', '.join(artifact_types)}.\n"
            f"Return a single JSON object with keys: {', '.join(artifact_types)}.\n"
            f"Each value should be an array of artifact objects matching the skill's schema."
        )

        char_count = len(user_prompt) + len(SYNTHESIS_SYSTEM)
        estimate = estimate_claude_synthesis_cost(char_count)
        logger.info(
            "Claude call: chars=%d estimate=$%.4f model=%s",
            char_count, estimate.estimated_cost_usd, settings.CLAUDE_MODEL,
        )

        response = await self.client.messages.create(
            model=settings.CLAUDE_MODEL,
            max_tokens=16000,
            system=SYNTHESIS_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
        )

        actual_cost = (
            (response.usage.input_tokens / 1_000_000) * settings.CLAUDE_INPUT_PRICE_PER_M
            + (response.usage.output_tokens / 1_000_000) * settings.CLAUDE_OUTPUT_PRICE_PER_M
        )
        await cost_guard.record_actual(ActualCost(
            provider=Provider.CLAUDE,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cost_usd=actual_cost,
        ))

        text_blocks = [b.text for b in response.content if hasattr(b, "text")]
        full_text = "".join(text_blocks)

        cleaned = full_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.rsplit("```", 1)[0].strip()

        return json.loads(cleaned)
