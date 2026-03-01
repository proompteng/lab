"""Composable advisory modules used by the Torghut DSPy runtime adapter."""

from __future__ import annotations

import json
from json import JSONDecodeError
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from typing import Any, Protocol, cast

from .signatures import (
    DSPyCommitteeMemberOutput,
    DSPyTradeReviewInput,
    DSPyTradeReviewOutput,
)

try:
    import dspy as _dspy  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - optional runtime dependency in local test envs
    _dspy = None

dspy: Any = _dspy

_SAFE_DEFAULT_CHECKS = ["risk_engine", "order_firewall", "execution_policy"]
_DSPY_OPENAI_BASE_PATH = "/openai/v1"
_DSPY_OPENAI_CHAT_COMPLETION_SUFFIX = "/chat/completions"


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


@dataclass
class LiveDSPyCommitteeProgram:
    """Best-effort DSPy-backed committee executor.

    This path is activated when an artifact manifest resolves to `executor=dspy_live`.
    If DSPy dependencies or runtime configuration are unavailable, this module raises
    and callers should trigger deterministic fallback behavior.
    """

    model_name: str
    api_base: str | None = None
    api_completion_url: str | None = None
    api_key: str | None = None
    _predictor: Any = field(default=None, init=False, repr=False)
    _lm: Any = field(default=None, init=False, repr=False)

    def run(self, payload: DSPyTradeReviewInput) -> DSPyTradeReviewOutput:
        self._ensure_predictor()
        if dspy is None:  # pragma: no cover - defensive guard
            raise RuntimeError("dspy_dependency_unavailable")
        if self._predictor is None or self._lm is None:
            raise RuntimeError("dspy_predictor_unavailable")

        request_json = json.dumps(
            payload.request_json, separators=(",", ":"), ensure_ascii=True
        )
        raw_result: Any
        context_factory = getattr(dspy, "context", None)
        if callable(context_factory):
            context_manager = context_factory(lm=self._lm)
            if not isinstance(context_manager, AbstractContextManager):
                raise RuntimeError("dspy_context_manager_invalid")
            with context_manager:
                raw_result = self._predictor(request_json=request_json)
        else:
            configure = getattr(dspy, "configure")
            configure(lm=self._lm)
            raw_result = self._predictor(request_json=request_json)

        response_json = getattr(raw_result, "response_json", None)
        if response_json is None:
            raise RuntimeError("dspy_response_missing")

        parsed: Any = response_json
        if isinstance(response_json, (bytes, bytearray)):
            try:
                parsed = json.loads(response_json.decode("utf-8"))
            except JSONDecodeError as exc:
                raise RuntimeError(
                    f"dspy_response_json_decode_error:{exc.msg}"
                ) from exc
        elif isinstance(response_json, str):
            try:
                parsed = json.loads(response_json)
            except JSONDecodeError as exc:
                raise RuntimeError(
                    f"dspy_response_json_decode_error:{exc.msg}"
                ) from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("dspy_response_not_object")
        return DSPyTradeReviewOutput.model_validate(parsed)

    def _ensure_predictor(self) -> None:
        if self._predictor is not None:
            return
        if dspy is None:
            raise RuntimeError("dspy_dependency_unavailable")
        normalized_model = self.model_name.strip()
        if not normalized_model:
            raise RuntimeError("dspy_model_not_configured")

        lm_kwargs: dict[str, Any] = {
            "model": normalized_model,
            "temperature": 0.0,
            "max_tokens": 900,
        }
        api_base = _coerce_dspy_api_base(
            api_base=self.api_base,
            api_completion_url=self.api_completion_url,
        )
        if not api_base:
            raise RuntimeError("dspy_api_base_missing")
        lm_kwargs["api_base"] = api_base
        if self.api_key:
            lm_kwargs["api_key"] = self.api_key
        self._lm = dspy.LM(**lm_kwargs)

        input_field = getattr(dspy, "InputField")
        output_field = getattr(dspy, "OutputField")

        class TradeReviewSignature(dspy.Signature):  # type: ignore[name-defined,misc]
            request_json = input_field(desc="JSON-encoded Torghut trade review request")
            response_json = output_field(
                desc="JSON object matching the DSPyTradeReviewOutput schema"
            )

        self._predictor = dspy.Predict(TradeReviewSignature)


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


def _coerce_dspy_api_base(
    *, api_base: str | None, api_completion_url: str | None
) -> str:
    candidate = api_completion_url if api_completion_url is not None else api_base
    normalized = (candidate or "").strip()
    if not normalized:
        return ""

    parsed = urlsplit(normalized)
    if (
        not parsed.scheme
        or parsed.scheme not in {"http", "https"}
        or not parsed.netloc
    ):
        raise RuntimeError("dspy_api_base_invalid")
    if parsed.query or parsed.fragment:
        raise RuntimeError("dspy_api_base_invalid")

    normalized_path = parsed.path.rstrip("/")
    if normalized_path in ("", "/"):
        base_path = ""
    elif normalized_path == _DSPY_OPENAI_BASE_PATH:
        base_path = _DSPY_OPENAI_BASE_PATH
    elif normalized_path == _DSPY_OPENAI_BASE_PATH + _DSPY_OPENAI_CHAT_COMPLETION_SUFFIX:
        base_path = _DSPY_OPENAI_BASE_PATH
    else:
        raise RuntimeError("dspy_api_base_invalid")

    return (
        f"{parsed.scheme}://{parsed.netloc}{base_path}"
    )


__all__ = [
    "DSPyCommitteeProgram",
    "HeuristicCommitteeProgram",
    "LiveDSPyCommitteeProgram",
]
