"""Model risk management guardrails for the LLM advisory layer."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ...config import settings


@dataclass(frozen=True)
class LLMRiskGuardrails:
    allow_requests: bool
    shadow_mode: bool
    adjustment_allowed: bool
    reasons: tuple[str, ...]


def evaluate_llm_guardrails() -> LLMRiskGuardrails:
    """Evaluate MRM guardrails and return the effective LLM policy surface."""

    reasons: list[str] = []
    allow_requests = True
    shadow_mode = settings.llm_shadow_mode
    adjustment_allowed = settings.llm_adjustment_allowed

    if not _prompt_template_exists(settings.llm_prompt_version):
        allow_requests = False
        shadow_mode = True
        adjustment_allowed = False
        reasons.append("llm_prompt_template_missing")

    if not settings.llm_shadow_mode:
        evidence_missing: list[str] = []
        allowed_models = settings.llm_allowed_models
        if not allowed_models:
            evidence_missing.append("llm_model_inventory_missing")
        elif settings.llm_model not in allowed_models:
            evidence_missing.append("llm_model_not_in_inventory")
        if not settings.llm_evaluation_report:
            evidence_missing.append("llm_evaluation_report_missing")
        if not settings.llm_effective_challenge_id:
            evidence_missing.append("llm_effective_challenge_missing")
        if not settings.llm_shadow_completed_at:
            evidence_missing.append("llm_shadow_completion_missing")
        if evidence_missing:
            shadow_mode = True
            adjustment_allowed = False
            reasons.extend(evidence_missing)

    if adjustment_allowed and not settings.llm_adjustment_approved:
        adjustment_allowed = False
        reasons.append("llm_adjustment_not_approved")

    return LLMRiskGuardrails(
        allow_requests=allow_requests,
        shadow_mode=shadow_mode,
        adjustment_allowed=adjustment_allowed,
        reasons=tuple(reasons),
    )


def _prompt_template_exists(version: str) -> bool:
    templates_dir = Path(__file__).resolve().parent / "prompt_templates"
    candidate = templates_dir / f"system_{version}.txt"
    return candidate.exists()


__all__ = ["LLMRiskGuardrails", "evaluate_llm_guardrails"]
