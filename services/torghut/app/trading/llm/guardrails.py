"""Model risk management guardrails for the LLM advisory layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ...config import settings


_ALLOWED_COMMITTEE_ROLES = {
    "researcher",
    "risk_critic",
    "execution_critic",
    "policy_judge",
}


def _empty_reasons() -> list[str]:
    return []


@dataclass(frozen=True)
class LLMRiskGuardrails:
    allow_requests: bool
    shadow_mode: bool
    adjustment_allowed: bool
    committee_enabled: bool
    effective_fail_mode: str
    rollout_stage: str
    governance_evidence_complete: bool
    quality_thresholds: dict[str, float]
    fallback_controls: dict[str, str]
    reasons: tuple[str, ...]


@dataclass
class _GuardrailState:
    allow_requests: bool
    shadow_mode: bool
    adjustment_allowed: bool
    effective_fail_mode: str
    reasons: list[str] = field(default_factory=_empty_reasons)


def evaluate_llm_guardrails() -> LLMRiskGuardrails:
    """Evaluate MRM guardrails and return the effective LLM policy surface."""

    rollout_stage = _normalize_rollout_stage(settings.llm_rollout_stage)
    state = _initial_guardrail_state()
    _apply_token_budget_guardrail(state)
    _apply_prompt_allowlist_guardrail(state)
    _apply_rollout_stage_guardrail(state, rollout_stage)
    _apply_prompt_template_guardrail(state)

    evidence_missing = _governance_evidence_missing(rollout_stage)
    governance_evidence_complete = len(evidence_missing) == 0
    if evidence_missing:
        _force_shadow_without_adjustment(state, evidence_missing)

    _apply_adjustment_approval_guardrail(state)
    committee_enabled = _resolve_committee_enabled(state)

    return LLMRiskGuardrails(
        allow_requests=state.allow_requests,
        shadow_mode=state.shadow_mode,
        adjustment_allowed=state.adjustment_allowed,
        committee_enabled=committee_enabled,
        effective_fail_mode=state.effective_fail_mode,
        rollout_stage=rollout_stage,
        governance_evidence_complete=governance_evidence_complete,
        quality_thresholds={
            "min_confidence": settings.llm_min_confidence,
            "max_uncertainty": settings.llm_max_uncertainty,
            "min_calibrated_top_probability": settings.llm_min_calibrated_top_probability,
            "min_probability_margin": settings.llm_min_probability_margin,
        },
        fallback_controls={
            "quality_fail_mode": settings.llm_quality_fail_mode,
            "abstain_fail_mode": settings.llm_abstain_fail_mode,
            "escalate_fail_mode": settings.llm_escalate_fail_mode,
        },
        reasons=tuple(state.reasons),
    )


def _initial_guardrail_state() -> _GuardrailState:
    return _GuardrailState(
        allow_requests=True,
        shadow_mode=settings.llm_shadow_mode,
        adjustment_allowed=settings.llm_adjustment_allowed,
        effective_fail_mode=settings.llm_effective_fail_mode(),
    )


def _block_requests(state: _GuardrailState, reason: str) -> None:
    state.allow_requests = False
    _force_shadow_without_adjustment(state, [reason])


def _force_shadow_without_adjustment(
    state: _GuardrailState, reasons: list[str]
) -> None:
    state.shadow_mode = True
    state.adjustment_allowed = False
    state.reasons.extend(reasons)


def _apply_token_budget_guardrail(state: _GuardrailState) -> None:
    if settings.llm_max_tokens <= settings.llm_token_budget_max:
        return
    _block_requests(state, "llm_token_budget_exceeded")


def _apply_prompt_allowlist_guardrail(state: _GuardrailState) -> None:
    allowed_prompt_versions = settings.llm_allowed_prompt_versions
    if (
        allowed_prompt_versions
        and settings.llm_prompt_version not in allowed_prompt_versions
    ):
        _block_requests(state, "llm_prompt_version_not_allowlisted")


def _apply_rollout_stage_guardrail(state: _GuardrailState, rollout_stage: str) -> None:
    if rollout_stage == "stage0":
        state.shadow_mode = True
        state.adjustment_allowed = False
        if settings.llm_enabled:
            state.reasons.append("llm_stage0_forces_shadow")
        return
    if rollout_stage == "stage1":
        state.shadow_mode = True
        state.adjustment_allowed = False
        state.effective_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage1")
        return
    if rollout_stage == "stage2":
        state.effective_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage2")


def _apply_prompt_template_guardrail(state: _GuardrailState) -> None:
    if _prompt_template_exists(settings.llm_prompt_version):
        return
    _block_requests(state, "llm_prompt_template_missing")


def _governance_evidence_missing(rollout_stage: str) -> list[str]:
    missing: list[str] = []
    allowed_models = settings.llm_allowed_models
    if not allowed_models:
        missing.append("llm_model_inventory_missing")
    elif settings.llm_model not in allowed_models:
        missing.append("llm_model_not_in_inventory")

    if rollout_stage not in {"stage2", "stage3"}:
        return missing
    if not settings.llm_evaluation_report:
        missing.append("llm_evaluation_report_missing")
    if not settings.llm_effective_challenge_id:
        missing.append("llm_effective_challenge_missing")
    if not settings.llm_shadow_completed_at:
        missing.append("llm_shadow_completion_missing")
    if not settings.llm_model_version_lock:
        missing.append("llm_model_version_lock_missing")
        return missing
    if not _matches_model_version_lock(settings.llm_model, settings.llm_model_version_lock):
        missing.append("llm_model_version_lock_mismatch")
    return missing


def _apply_adjustment_approval_guardrail(state: _GuardrailState) -> None:
    if not state.adjustment_allowed:
        return
    if settings.llm_adjustment_approved:
        return
    state.adjustment_allowed = False
    state.reasons.append("llm_adjustment_not_approved")


def _resolve_committee_enabled(state: _GuardrailState) -> bool:
    if not settings.llm_committee_enabled:
        return False
    if not _committee_roles_valid():
        _block_requests(state, "llm_committee_roles_invalid")
        return False
    return True


def _committee_roles_valid() -> bool:
    invalid_roles = sorted(
        {role for role in settings.llm_committee_roles if role not in _ALLOWED_COMMITTEE_ROLES}
    )
    invalid_mandatory_roles = sorted(
        {
            role
            for role in settings.llm_committee_mandatory_roles
            if role not in _ALLOWED_COMMITTEE_ROLES
        }
    )
    return not invalid_roles and not invalid_mandatory_roles


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
