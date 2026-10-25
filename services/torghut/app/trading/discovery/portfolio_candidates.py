"""Canonical portfolio candidate specs for whitepaper autoresearch."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast


PORTFOLIO_CANDIDATE_SCHEMA_VERSION = "torghut.portfolio-candidate-spec.v1"


def stable_portfolio_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def portfolio_candidate_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"port-{stable_portfolio_hash(payload)[:24]}"


def _string(value: Any) -> str:
    return str(value or "").strip()


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _mapping_tuple(value: Any) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    rows = cast(Sequence[Any], value)
    return tuple(
        cast(Mapping[str, Any], item) for item in rows if isinstance(item, Mapping)
    )


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return ()
    rows = cast(Sequence[Any], value)
    return tuple(str(item) for item in rows if str(item).strip())


@dataclass(frozen=True)
class PortfolioCandidateSpec:
    schema_version: Literal["torghut.portfolio-candidate-spec.v1"]
    portfolio_candidate_id: str
    source_candidate_ids: tuple[str, ...]
    target_net_pnl_per_day: Decimal
    sleeves: tuple[Mapping[str, Any], ...]
    capital_budget: Mapping[str, Any]
    correlation_budget: Mapping[str, Any]
    drawdown_budget: Mapping[str, Any]
    evidence_refs: tuple[str, ...]
    objective_scorecard: Mapping[str, Any]
    optimizer_report: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "portfolio_candidate_id": self.portfolio_candidate_id,
            "source_candidate_ids": list(self.source_candidate_ids),
            "target_net_pnl_per_day": str(self.target_net_pnl_per_day),
            "sleeves": [dict(item) for item in self.sleeves],
            "capital_budget": dict(self.capital_budget),
            "correlation_budget": dict(self.correlation_budget),
            "drawdown_budget": dict(self.drawdown_budget),
            "evidence_refs": list(self.evidence_refs),
            "objective_scorecard": dict(self.objective_scorecard),
            "optimizer_report": dict(self.optimizer_report),
        }


def portfolio_candidate_from_payload(
    payload: Mapping[str, Any],
) -> PortfolioCandidateSpec:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != PORTFOLIO_CANDIDATE_SCHEMA_VERSION:
        raise ValueError(f"portfolio_candidate_schema_invalid:{schema_version}")
    return PortfolioCandidateSpec(
        schema_version=PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
        portfolio_candidate_id=_string(payload.get("portfolio_candidate_id")),
        source_candidate_ids=_string_tuple(payload.get("source_candidate_ids")),
        target_net_pnl_per_day=_decimal(payload.get("target_net_pnl_per_day")),
        sleeves=_mapping_tuple(payload.get("sleeves")),
        capital_budget=_mapping(payload.get("capital_budget")),
        correlation_budget=_mapping(payload.get("correlation_budget")),
        drawdown_budget=_mapping(payload.get("drawdown_budget")),
        evidence_refs=_string_tuple(payload.get("evidence_refs")),
        objective_scorecard=_mapping(payload.get("objective_scorecard")),
        optimizer_report=_mapping(payload.get("optimizer_report")),
    )
