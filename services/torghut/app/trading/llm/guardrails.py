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
    effective_fail_mode: str
    rollout_stage: str
    governance_evidence_complete: bool
    committee_enabled: bool
    reasons: tuple[str, ...]


def evaluate_llm_guardrails() -> LLMRiskGuardrails:
    """Evaluate MRM guardrails and return the effective LLM policy surface."""

    reasons: list[str] = []
    allow_requests = True
    shadow_mode = settings.llm_shadow_mode
    adjustment_allowed = settings.llm_adjustment_allowed
    effective_fail_mode = settings.llm_effective_fail_mode()
    rollout_stage = _normalize_rollout_stage(settings.llm_rollout_stage)

    if settings.llm_max_tokens > settings.llm_token_budget_max:
        allow_requests = False
        shadow_mode = True
        adjustment_allowed = False
        reasons.append("llm_token_budget_exceeded")

    allowed_prompt_versions = settings.llm_allowed_prompt_versions
    if (
        allowed_prompt_versions
        and settings.llm_prompt_version not in allowed_prompt_versions
    ):
        allow_requests = False
        shadow_mode = True
        adjustment_allowed = False
        reasons.append("llm_prompt_version_not_allowlisted")

    if rollout_stage == "stage0":
        shadow_mode = True
        adjustment_allowed = False
        if settings.llm_enabled:
            reasons.append("llm_stage0_forces_shadow")
    elif rollout_stage == "stage1":
        shadow_mode = True
        adjustment_allowed = False
        effective_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage1")
    elif rollout_stage == "stage2":
        effective_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage2")

    if not _prompt_template_exists(settings.llm_prompt_version):
        allow_requests = False
        shadow_mode = True
        adjustment_allowed = False
        reasons.append("llm_prompt_template_missing")

    evidence_missing: list[str] = []
    allowed_models = settings.llm_allowed_models
    if not allowed_models:
        evidence_missing.append("llm_model_inventory_missing")
    elif settings.llm_model not in allowed_models:
        evidence_missing.append("llm_model_not_in_inventory")

    if rollout_stage in {"stage2", "stage3"}:
        if not settings.llm_evaluation_report:
            evidence_missing.append("llm_evaluation_report_missing")
        if not settings.llm_effective_challenge_id:
            evidence_missing.append("llm_effective_challenge_missing")
        if not settings.llm_shadow_completed_at:
            evidence_missing.append("llm_shadow_completion_missing")
        if not settings.llm_model_version_lock:
            evidence_missing.append("llm_model_version_lock_missing")
        elif not _matches_model_version_lock(
            settings.llm_model, settings.llm_model_version_lock
        ):
            evidence_missing.append("llm_model_version_lock_mismatch")

    governance_evidence_complete = len(evidence_missing) == 0
    if evidence_missing:
        shadow_mode = True
        adjustment_allowed = False
        reasons.extend(evidence_missing)

    if adjustment_allowed and not settings.llm_adjustment_approved:
        adjustment_allowed = False
        reasons.append("llm_adjustment_not_approved")

    committee_enabled = settings.llm_committee_enabled
    if committee_enabled:
        roles = settings.llm_committee_roles
        mandatory_roles = settings.llm_committee_mandatory_roles
        allowed_roles = {
            "researcher",
            "risk_critic",
            "execution_critic",
            "policy_judge",
        }
        invalid_roles = sorted({role for role in roles if role not in allowed_roles})
        invalid_mandatory_roles = sorted(
            {role for role in mandatory_roles if role not in allowed_roles}
        )
        if invalid_roles or invalid_mandatory_roles:
            allow_requests = False
            shadow_mode = True
            committee_enabled = False
            reasons.append("llm_committee_roles_invalid")

    return LLMRiskGuardrails(
        allow_requests=allow_requests,
        shadow_mode=shadow_mode,
        adjustment_allowed=adjustment_allowed,
        effective_fail_mode=effective_fail_mode,
        rollout_stage=rollout_stage,
        governance_evidence_complete=governance_evidence_complete,
        committee_enabled=committee_enabled,
        reasons=tuple(reasons),
    )


def _prompt_template_exists(version: str) -> bool:
    templates_dir = Path(__file__).resolve().parent / "prompt_templates"
    candidate = templates_dir / f"system_{version}.txt"
    return candidate.exists()


def _matches_model_version_lock(model: str, version_lock: str) -> bool:
    if not version_lock:
        return False
    if model == version_lock:
        return True
    if "@" in version_lock:
        locked_model = version_lock.split("@", 1)[0].strip()
        return bool(locked_model) and model == locked_model
    return False


def _normalize_rollout_stage(stage: str) -> str:
    if stage.startswith("stage0"):
        return "stage0"
    if stage.startswith("stage1"):
        return "stage1"
    if stage.startswith("stage2"):
        return "stage2"
    if stage.startswith("stage3"):
        return "stage3"
    return "stage3"


__all__ = ["LLMRiskGuardrails", "evaluate_llm_guardrails"]
