"""Model risk management guardrails for the LLM advisory layer."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ...config import settings

LLMFailMode = Literal["veto", "pass_through"]
LLMRolloutStage = Literal[
    "stage0_baseline",
    "stage1_shadow_pilot",
    "stage2_paper_advisory",
    "stage3_controlled_live",
]


@dataclass(frozen=True)
class LLMRiskGuardrails:
    allow_requests: bool
    enabled: bool
    rollout_stage: LLMRolloutStage
    shadow_mode: bool
    fail_mode: LLMFailMode
    adjustment_allowed: bool
    reasons: tuple[str, ...]


def evaluate_llm_guardrails() -> LLMRiskGuardrails:
    """Evaluate MRM guardrails and return the effective LLM policy surface."""

    reasons: list[str] = []
    enabled = settings.llm_enabled
    allow_requests = enabled
    rollout_stage = settings.llm_rollout_stage
    shadow_mode = settings.llm_shadow_mode
    fail_mode: LLMFailMode = settings.llm_fail_mode
    adjustment_allowed = settings.llm_adjustment_allowed

    stage_reasons: list[str] = []
    if rollout_stage == "stage0_baseline":
        if enabled:
            stage_reasons.append("llm_stage0_requires_disabled")
        enabled = False
        allow_requests = False
        shadow_mode = True
        adjustment_allowed = False
        fail_mode = "veto"
    elif rollout_stage == "stage1_shadow_pilot":
        if not enabled:
            stage_reasons.append("llm_stage1_requires_enabled")
        shadow_mode = True
        adjustment_allowed = False
        expected_fail_mode = (
            "pass_through" if settings.trading_mode == "paper" else "veto"
        )
        if settings.llm_fail_mode != expected_fail_mode:
            stage_reasons.append("llm_stage1_fail_mode_mismatch")
        fail_mode = expected_fail_mode
        allow_requests = enabled
    elif rollout_stage == "stage2_paper_advisory":
        expected_fail_mode: LLMFailMode = "pass_through"
        if settings.llm_fail_mode != expected_fail_mode:
            stage_reasons.append("llm_stage2_fail_mode_mismatch")
        fail_mode = expected_fail_mode
        if settings.trading_mode == "live":
            stage_reasons.append("llm_stage2_live_requires_shadow")
            shadow_mode = True

    reasons.extend(stage_reasons)

    if not _prompt_template_exists(settings.llm_prompt_version):
        allow_requests = False
        shadow_mode = True
        adjustment_allowed = False
        reasons.append("llm_prompt_template_missing")

    if not shadow_mode:
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
        model_lock = settings.llm_model_version_lock
        if not model_lock:
            evidence_missing.append("llm_model_version_lock_missing")
        elif model_lock != settings.llm_model:
            evidence_missing.append("llm_model_version_lock_mismatch")
        if evidence_missing:
            shadow_mode = True
            adjustment_allowed = False
            reasons.extend(evidence_missing)

    if adjustment_allowed and not settings.llm_adjustment_approved:
        adjustment_allowed = False
        reasons.append("llm_adjustment_not_approved")

    return LLMRiskGuardrails(
        allow_requests=allow_requests,
        enabled=enabled,
        rollout_stage=rollout_stage,
        shadow_mode=shadow_mode,
        fail_mode=fail_mode,
        adjustment_allowed=adjustment_allowed,
        reasons=tuple(reasons),
    )


def _prompt_template_exists(version: str) -> bool:
    templates_dir = Path(__file__).resolve().parent / "prompt_templates"
    candidate = templates_dir / f"system_{version}.txt"
    return candidate.exists()


__all__ = ["LLMRiskGuardrails", "evaluate_llm_guardrails"]
