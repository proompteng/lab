"""Promotion evidence evaluation and policy toggles."""

from __future__ import annotations

from .common import (
    Any,
    NON_AUTHORITATIVE_PROVENANCE,
    Path,
    cast,
    contract_from_artifact_payload,
    datetime,
    parse_evidence_contract,
)
from .requirements import (
    as_dict as _as_dict,
    int_or_default as _int_or_default,
    list_of_strings as _list_of_strings,
    requires_alpha_readiness_contract as _requires_alpha_readiness_contract,
    requires_fold_evidence as _requires_fold_evidence,
    requires_jangar_dependency_quorum as _requires_jangar_dependency_quorum,
    requires_stress_evidence as _requires_stress_evidence,
)

from .advisor_fallback import (
    evaluate_advisor_fallback_slo_evidence as _evaluate_advisor_fallback_slo_evidence,
)
from .benchmark_parity import (
    evaluate_benchmark_parity_evidence as _evaluate_benchmark_parity_evidence,
)
from .deeplob_bdlob import (
    evaluate_deeplob_bdlob_contract_evidence as _evaluate_deeplob_bdlob_contract_evidence,
)
from .evidence_artifacts import (
    evaluate_fold_metrics_evidence as _evaluate_fold_metrics_evidence,
    evaluate_rationale_evidence as _evaluate_rationale_evidence,
    evaluate_shadow_live_deviation_evidence as _evaluate_shadow_live_deviation_evidence,
    evaluate_simulation_calibration_evidence as _evaluate_simulation_calibration_evidence,
    evaluate_stress_metrics_evidence as _evaluate_stress_metrics_evidence,
)
from .evidence_core import (
    evaluate_contamination_registry_evidence as _evaluate_contamination_registry_evidence,
    evaluate_expert_router_registry_evidence as _evaluate_expert_router_registry_evidence,
    evaluate_hmm_state_posterior_evidence as _evaluate_hmm_state_posterior_evidence,
    evaluate_janus_evidence as _evaluate_janus_evidence,
)
from .foundation_router import (
    evaluate_foundation_router_parity_evidence as _evaluate_foundation_router_parity_evidence,
)


def _evaluate_promotion_evidence(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    promotion_target: str,
    artifact_root: Path,
    now: datetime | None = None,
) -> tuple[list[str], list[dict[str, object]], list[str]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    refs: list[str] = []
    if promotion_target == "shadow":
        return reasons, details, refs

    evidence_raw = gate_report_payload.get("promotion_evidence")
    evidence = (
        cast(dict[str, Any], evidence_raw) if isinstance(evidence_raw, dict) else {}
    )
    deterministic_reasons, deterministic_details = (
        _evaluate_deterministic_authority_firewall(
            evidence=evidence,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(deterministic_reasons)
    details.extend(deterministic_details)
    if bool(policy_payload.get("promotion_require_truthful_evidence_contracts", False)):
        authority_reasons, authority_details = _evaluate_promotion_evidence_authority(
            evidence=evidence,
            promotion_target=promotion_target,
        )
        reasons.extend(authority_reasons)
        details.extend(authority_details)
    portfolio_reasons, portfolio_details = _evaluate_portfolio_promotion_summary(
        gate_report_payload=gate_report_payload,
        promotion_target=promotion_target,
    )
    reasons.extend(portfolio_reasons)
    details.extend(portfolio_details)
    alpha_readiness_reasons, alpha_readiness_details = (
        _evaluate_alpha_readiness_summary(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(alpha_readiness_reasons)
    details.extend(alpha_readiness_details)
    stress_required = _requires_stress_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    fold_required = _requires_fold_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    stress_reasons, stress_details, stress_refs = _evaluate_stress_metrics_evidence(
        policy_payload=policy_payload,
        evidence=evidence,
        artifact_root=artifact_root,
        now=now,
    )
    if stress_required:
        reasons.extend(stress_reasons)
        details.extend(stress_details)
        refs.extend(stress_refs)
    if fold_required:
        fold_reasons, fold_details, fold_refs = _evaluate_fold_metrics_evidence(
            policy_payload=policy_payload,
            evidence=evidence,
            artifact_root=artifact_root,
            now=now,
        )
        reasons.extend(fold_reasons)
        details.extend(fold_details)
        refs.extend(fold_refs)
    (
        simulation_calibration_reasons,
        simulation_calibration_details,
        simulation_calibration_refs,
    ) = _evaluate_simulation_calibration_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        artifact_root=artifact_root,
        promotion_target=promotion_target,
    )
    reasons.extend(simulation_calibration_reasons)
    details.extend(simulation_calibration_details)
    refs.extend(simulation_calibration_refs)

    (
        shadow_live_deviation_reasons,
        shadow_live_deviation_details,
        shadow_live_deviation_refs,
    ) = _evaluate_shadow_live_deviation_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        artifact_root=artifact_root,
        promotion_target=promotion_target,
    )
    reasons.extend(shadow_live_deviation_reasons)
    details.extend(shadow_live_deviation_details)
    refs.extend(shadow_live_deviation_refs)

    janus_reasons, janus_details, janus_refs = _evaluate_janus_evidence(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
        evidence=evidence,
        artifact_root=artifact_root,
        now=now,
    )
    reasons.extend(janus_reasons)
    details.extend(janus_details)
    refs.extend(janus_refs)

    contamination_reasons, contamination_details, contamination_refs = (
        _evaluate_contamination_registry_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(contamination_reasons)
    details.extend(contamination_details)
    refs.extend(contamination_refs)

    hmm_reasons, hmm_details, hmm_refs = _evaluate_hmm_state_posterior_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        artifact_root=artifact_root,
        promotion_target=promotion_target,
    )
    reasons.extend(hmm_reasons)
    details.extend(hmm_details)
    refs.extend(hmm_refs)

    expert_router_reasons, expert_router_details, expert_router_refs = (
        _evaluate_expert_router_registry_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(expert_router_reasons)
    details.extend(expert_router_details)
    refs.extend(expert_router_refs)

    rationale_reasons, rationale_details = _evaluate_rationale_evidence(
        policy_payload=policy_payload,
        gate_report_payload=gate_report_payload,
        evidence=evidence,
        promotion_target=promotion_target,
    )
    reasons.extend(rationale_reasons)
    details.extend(rationale_details)

    benchmark_parity_reasons, benchmark_parity_details, benchmark_parity_refs = (
        _evaluate_benchmark_parity_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(benchmark_parity_reasons)
    details.extend(benchmark_parity_details)
    refs.extend(benchmark_parity_refs)

    parity_reasons, parity_details, parity_refs = (
        _evaluate_foundation_router_parity_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(parity_reasons)
    details.extend(parity_details)
    refs.extend(parity_refs)

    deeplob_reasons, deeplob_details, deeplob_refs = (
        _evaluate_deeplob_bdlob_contract_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(deeplob_reasons)
    details.extend(deeplob_details)
    refs.extend(deeplob_refs)

    advisor_reasons, advisor_details, advisor_refs = (
        _evaluate_advisor_fallback_slo_evidence(
            policy_payload=policy_payload,
            gate_report_payload=gate_report_payload,
            artifact_root=artifact_root,
            promotion_target=promotion_target,
        )
    )
    reasons.extend(advisor_reasons)
    details.extend(advisor_details)
    refs.extend(advisor_refs)

    return sorted(set(reasons)), details, sorted(set(refs))


def _evaluate_deterministic_authority_firewall(
    *,
    evidence: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    if promotion_target not in {"paper", "live"}:
        return reasons, details
    for evidence_name, raw_payload in evidence.items():
        payload = _as_dict(raw_payload)
        if not payload:
            continue
        contract_payload = _extract_evidence_authority_payload(payload)
        if not contract_payload:
            continue
        contract = parse_evidence_contract(contract_payload)
        provenance = str(contract.get("provenance", "")).strip()
        if provenance not in {item.value for item in NON_AUTHORITATIVE_PROVENANCE}:
            continue
        reasons.append("promotion_evidence_deterministic_authority_blocked")
        details.append(
            {
                "reason": "promotion_evidence_deterministic_authority_blocked",
                "evidence_name": str(evidence_name),
                "promotion_target": promotion_target,
                "provenance": provenance,
                "maturity": contract.get("maturity"),
                "authoritative": bool(contract.get("authoritative", False)),
            }
        )
    return reasons, details


def _evaluate_promotion_evidence_authority(
    *,
    evidence: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]]]:
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    required = (
        "fold_metrics",
        "stress_metrics",
        "simulation_calibration",
        "shadow_live_deviation",
        "janus_q",
        "benchmark_parity",
        "foundation_router_parity",
        "deeplob_bdlob_contract",
        "advisor_fallback_slo",
        "hmm_state_posterior",
        "expert_router_registry",
        "contamination_registry",
        "promotion_rationale",
    )
    for evidence_name in required:
        payload = _as_dict(evidence.get(evidence_name))
        if not payload:
            continue
        contract_payload = _extract_evidence_authority_payload(payload)
        if not contract_payload:
            reasons.append("promotion_evidence_authority_missing")
            details.append(
                {
                    "reason": "promotion_evidence_authority_missing",
                    "evidence_name": evidence_name,
                    "promotion_target": promotion_target,
                }
            )
            continue
        contract = parse_evidence_contract(contract_payload)
        provenance = str(contract.get("provenance", "")).strip()
        if provenance in {item.value for item in NON_AUTHORITATIVE_PROVENANCE}:
            reasons.append("promotion_evidence_non_authoritative")
            details.append(
                {
                    "reason": "promotion_evidence_non_authoritative",
                    "evidence_name": evidence_name,
                    "promotion_target": promotion_target,
                    "provenance": provenance,
                    "maturity": contract.get("maturity"),
                }
            )
        if not bool(contract.get("authoritative", False)):
            reasons.append("promotion_evidence_authoritative_flag_false")
            details.append(
                {
                    "reason": "promotion_evidence_authoritative_flag_false",
                    "evidence_name": evidence_name,
                    "promotion_target": promotion_target,
                    "provenance": provenance,
                }
            )
    return reasons, details


def _evaluate_portfolio_promotion_summary(
    *,
    gate_report_payload: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]]]:
    if promotion_target not in {"paper", "live"}:
        return [], []
    vnext_payload = _as_dict(gate_report_payload.get("vnext"))
    portfolio_summary = _as_dict(vnext_payload.get("portfolio_promotion"))
    if not portfolio_summary:
        return [], []
    strategy_count = _int_or_default(portfolio_summary.get("strategy_count"), 0)
    if strategy_count <= 1:
        return [], []
    reasons: list[str] = []
    details: list[dict[str, object]] = []
    spec_compiled_count = _int_or_default(
        portfolio_summary.get("spec_compiled_count"), 0
    )
    if spec_compiled_count < strategy_count:
        reasons.append("portfolio_promotion_strategy_compilation_incomplete")
        details.append(
            {
                "reason": "portfolio_promotion_strategy_compilation_incomplete",
                "strategy_count": strategy_count,
                "spec_compiled_count": spec_compiled_count,
            }
        )
    missing_policy_refs = _list_of_strings(portfolio_summary.get("missing_policy_refs"))
    if missing_policy_refs:
        reasons.append("portfolio_promotion_policy_refs_missing")
        details.append(
            {
                "reason": "portfolio_promotion_policy_refs_missing",
                "missing_policy_refs": missing_policy_refs,
            }
        )
    return reasons, details


def _evaluate_alpha_readiness_summary(
    *,
    policy_payload: dict[str, Any],
    gate_report_payload: dict[str, Any],
    promotion_target: str,
) -> tuple[list[str], list[dict[str, object]]]:
    if promotion_target not in {"paper", "live"}:
        return [], []
    require_alpha_readiness = _requires_alpha_readiness_contract(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    require_dependency_quorum = _requires_jangar_dependency_quorum(
        policy_payload=policy_payload,
        promotion_target=promotion_target,
    )
    if not require_alpha_readiness and not require_dependency_quorum:
        return [], []
    alpha_readiness = _as_dict(gate_report_payload.get("alpha_readiness"))
    dependency_quorum = _as_dict(gate_report_payload.get("dependency_quorum"))
    reasons: list[str] = []
    details: list[dict[str, object]] = []

    if require_alpha_readiness and not alpha_readiness:
        reasons.append("alpha_readiness_summary_missing")
        details.append(
            {
                "reason": "alpha_readiness_summary_missing",
                "promotion_target": promotion_target,
            }
        )
    elif require_alpha_readiness:
        if not bool(alpha_readiness.get("promotion_eligible", False)):
            reasons.append("alpha_readiness_not_promotion_eligible")
            details.append(
                {
                    "reason": "alpha_readiness_not_promotion_eligible",
                    "promotion_target": promotion_target,
                    "reasons": _list_of_strings(alpha_readiness.get("reasons")),
                    "strategy_families": _list_of_strings(
                        alpha_readiness.get("strategy_families")
                    ),
                    "matched_hypothesis_ids": _list_of_strings(
                        alpha_readiness.get("matched_hypothesis_ids")
                    ),
                }
            )

    if not require_dependency_quorum:
        return reasons, details

    if not dependency_quorum:
        reasons.append("jangar_dependency_quorum_missing")
        details.append(
            {
                "reason": "jangar_dependency_quorum_missing",
                "promotion_target": promotion_target,
            }
        )
        return reasons, details

    decision = str(dependency_quorum.get("decision") or "").strip().lower()
    if decision == "allow":
        return reasons, details
    if decision == "delay":
        reasons.append("jangar_dependency_quorum_delay")
    else:
        reasons.append("jangar_dependency_quorum_block")
    details.append(
        {
            "reason": reasons[-1],
            "promotion_target": promotion_target,
            "decision": decision or "unknown",
            "dependency_reasons": _list_of_strings(dependency_quorum.get("reasons")),
            "message": str(dependency_quorum.get("message") or "").strip() or None,
        }
    )
    return reasons, details


def _extract_evidence_authority_payload(payload: dict[str, Any]) -> dict[str, Any]:
    direct = _as_dict(payload.get("artifact_authority"))
    if direct:
        return direct
    contract = contract_from_artifact_payload(payload)
    if contract:
        return contract
    for nested_key in ("event_car", "hgrm_reward"):
        nested_payload = _as_dict(payload.get(nested_key))
        nested_contract = _as_dict(nested_payload.get("artifact_authority"))
        if nested_contract:
            return nested_contract
    return {}


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
evaluate_alpha_readiness_summary = _evaluate_alpha_readiness_summary
evaluate_promotion_evidence = _evaluate_promotion_evidence
