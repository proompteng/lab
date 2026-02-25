"""Composable advisory modules used by the Torghut DSPy runtime adapter."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, cast

from .signatures import DSPyCommitteeMemberOutput, DSPyTradeReviewInput, DSPyTradeReviewOutput

_SAFE_DEFAULT_CHECKS = ["risk_engine", "order_firewall", "execution_policy"]


class DSPyCommitteeProgram(Protocol):
    """Minimal execution contract for a DSPy-style review program."""

    def run(self, payload: DSPyTradeReviewInput) -> DSPyTradeReviewOutput:
        """Run advisory program and produce structured output."""
        ...


@dataclass
class HeuristicCommitteeProgram:
    """Deterministic committee-style fallback program.

    This acts as a safety-preserving scaffolding implementation when a compiled
    DSPy artifact is selected but an actual DSPy runtime is not available.
    """

    def run(self, payload: DSPyTradeReviewInput) -> DSPyTradeReviewOutput:
        request = payload.request_json
        policy = cast(dict[str, Any], request.get("policy") or {})
        market_context = cast(dict[str, Any], request.get("market_context") or {})

        risk_flags = _collect_risk_flags(market_context)
        committee = _build_committee(risk_flags)

        if not policy.get("adjustment_allowed", False):
            verdict = "veto"
            rationale = "dspy_policy_guard_adjustment_disallowed"
            confidence = 0.86
        elif risk_flags:
            verdict = "veto"
            rationale = "dspy_market_context_risk_flags_detected"
            confidence = 0.82
        else:
            verdict = "approve"
            rationale = "dspy_committee_consensus_approve"
            confidence = 0.64

        return DSPyTradeReviewOutput(
            verdict=verdict,
            confidence=confidence,
            rationale=rationale,
            rationaleShort=rationale,
            requiredChecks=sorted(_SAFE_DEFAULT_CHECKS),
            riskFlags=risk_flags,
            adjustedQty=None,
            adjustedOrderType=None,
            limitPrice=None,
            uncertaintyBand="medium",
            committee=committee,
            calibrationMetadata={"runtime": "deterministic_heuristic_scaffold"},
        )


def _collect_risk_flags(market_context: dict[str, Any]) -> list[str]:
    flags: set[str] = set()
    if isinstance(market_context.get("risk_flags"), list):
        for value in cast(list[Any], market_context.get("risk_flags")):
            text = str(value).strip()
            if text:
                flags.add(text)
    domains = cast(dict[str, Any], market_context.get("domains") or {})
    for domain_payload in domains.values():
        if not isinstance(domain_payload, dict):
            continue
        domain_payload_dict = cast(dict[str, Any], domain_payload)
        domain_flags = domain_payload_dict.get("risk_flags")
        if isinstance(domain_flags, list):
            for value in cast(list[Any], domain_flags):
                text = str(value).strip()
                if text:
                    flags.add(text)
    return sorted(flags)


def _build_committee(risk_flags: list[str]) -> list[DSPyCommitteeMemberOutput]:
    role_payloads = {
        "researcher": {
            "verdict": "approve",
            "confidence": 0.62,
            "uncertaintyBand": "medium",
            "rationaleShort": "research_signal_quality_acceptable",
        },
        "risk_critic": {
            "verdict": "veto" if risk_flags else "approve",
            "confidence": 0.9 if risk_flags else 0.71,
            "uncertaintyBand": "low" if risk_flags else "medium",
            "rationaleShort": (
                "risk_flags_detected_in_market_context"
                if risk_flags
                else "no_deterministic_risk_flags_detected"
            ),
            "riskFlags": risk_flags,
        },
        "execution_critic": {
            "verdict": "approve",
            "confidence": 0.68,
            "uncertaintyBand": "medium",
            "rationaleShort": "execution_constraints_within_bounds",
        },
        "policy_judge": {
            "verdict": "approve",
            "confidence": 0.74,
            "uncertaintyBand": "medium",
            "rationaleShort": "advisory_output_schema_validated",
            "requiredChecks": sorted(_SAFE_DEFAULT_CHECKS),
        },
    }
    out: list[DSPyCommitteeMemberOutput] = []
    for role, payload in role_payloads.items():
        out.append(
            DSPyCommitteeMemberOutput.model_validate(
                {
                    "role": role,
                    "requiredChecks": [],
                    "riskFlags": [],
                    **payload,
                }
            )
        )
    return out
__all__ = ["DSPyCommitteeProgram", "HeuristicCommitteeProgram"]
