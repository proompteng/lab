"""Typed hypothesis cards compiled from whitepaper research outputs."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Mapping, Sequence, cast


HYPOTHESIS_CARD_SCHEMA_VERSION = "torghut.hypothesis-card.v1"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


def _string_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        values: Sequence[Any] = [value]
    elif isinstance(value, Sequence):
        values = cast(Sequence[Any], value)
    else:
        return ()
    resolved: list[str] = []
    for item in values:
        text = _string(item)
        if text and text not in resolved:
            resolved.append(text)
    return tuple(resolved)


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _claim_id(claim: Mapping[str, Any], *, index: int) -> str:
    return _string(claim.get("claim_id")) or f"claim-{index}"


def _claim_text(claim: Mapping[str, Any]) -> str:
    return _string(claim.get("claim_text")) or _string(claim.get("claim"))


def _metadata_terms(claim: Mapping[str, Any]) -> tuple[str, ...]:
    metadata = _mapping(claim.get("metadata"))
    terms: list[str] = []
    for key in (
        "required_features",
        "features",
        "entry_motifs",
        "exit_motifs",
        "risk_controls",
    ):
        terms.extend(_string_tuple(claim.get(key)))
        terms.extend(_string_tuple(metadata.get(key)))
    return tuple(dict.fromkeys(item for item in terms if item))


def _infer_terms(*, claims: Sequence[Mapping[str, Any]], kind: str) -> tuple[str, ...]:
    terms: list[str] = []
    joined = " ".join(_claim_text(claim).lower() for claim in claims)
    for claim in claims:
        terms.extend(_metadata_terms(claim))
        terms.extend(_string_tuple(claim.get(f"{kind}_json")))
        terms.extend(_string_tuple(claim.get(kind)))
    if kind == "required_features":
        if any(
            token in joined
            for token in (
                "order flow",
                "order-flow",
                "lob",
                "limit order book",
                "trade-flow",
            )
        ):
            terms.extend(["order_flow_imbalance", "spread_bps", "relative_volume"])
        if any(token in joined for token in ("momentum", "trend")):
            terms.extend(["intraday_momentum_rank", "prior_day_return"])
        if any(token in joined for token in ("reversal", "mean reversion", "washout")):
            terms.extend(["session_selloff_bps", "cross_section_reversal_rank"])
    if kind == "entry_motifs":
        if any(token in joined for token in ("order flow", "trade-flow", "cluster")):
            terms.append("microbar_rank")
        if "momentum" in joined or "trend" in joined:
            terms.append("momentum_pullback")
        if "reversal" in joined or "washout" in joined:
            terms.append("rebound")
    if kind == "risk_controls":
        terms.extend(["quote_quality", "stop_loss", "max_drawdown"])
    return tuple(dict.fromkeys(item for item in terms if item))


def _mechanism_from_claims(claims: Sequence[Mapping[str, Any]]) -> str:
    for claim in claims:
        text = _claim_text(claim)
        claim_type = _string(claim.get("claim_type"))
        if text and claim_type in {
            "signal_mechanism",
            "feature_recipe",
            "normalization_rule",
        }:
            return text
    for claim in claims:
        text = _claim_text(claim)
        if text:
            return text
    return "Whitepaper-derived market mechanism"


def _failure_modes(
    claims: Sequence[Mapping[str, Any]], relations: Sequence[Mapping[str, Any]]
) -> tuple[str, ...]:
    modes: list[str] = []
    for claim in claims:
        if _string(claim.get("expected_direction")).lower() in {
            "negative",
            "fails",
            "failure",
        }:
            modes.append(_claim_text(claim) or _claim_id(claim, index=len(modes) + 1))
        modes.extend(_string_tuple(claim.get("expected_failure_modes")))
    for relation in relations:
        relation_type = _string(relation.get("relation_type")).lower()
        if relation_type in {"contradicts", "conflicts_with", "invalidates"}:
            rationale = _string(relation.get("rationale"))
            modes.append(
                rationale or f"contradiction:{_string(relation.get('relation_id'))}"
            )
    if not modes:
        modes.append("fails_under_cost_or_quote_quality_stress")
    return tuple(dict.fromkeys(item for item in modes if item))


@dataclass(frozen=True)
class HypothesisCard:
    schema_version: Literal["torghut.hypothesis-card.v1"]
    hypothesis_id: str
    source_run_id: str
    source_claim_ids: tuple[str, ...]
    mechanism: str
    asset_scope: str
    horizon_scope: str
    expected_direction: str
    required_features: tuple[str, ...]
    entry_motifs: tuple[str, ...]
    exit_motifs: tuple[str, ...]
    risk_controls: tuple[str, ...]
    expected_regimes: tuple[str, ...]
    failure_modes: tuple[str, ...]
    implementation_constraints: Mapping[str, Any]
    confidence: Decimal

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "hypothesis_id": self.hypothesis_id,
            "source_run_id": self.source_run_id,
            "source_claim_ids": list(self.source_claim_ids),
            "mechanism": self.mechanism,
            "asset_scope": self.asset_scope,
            "horizon_scope": self.horizon_scope,
            "expected_direction": self.expected_direction,
            "required_features": list(self.required_features),
            "entry_motifs": list(self.entry_motifs),
            "exit_motifs": list(self.exit_motifs),
            "risk_controls": list(self.risk_controls),
            "expected_regimes": list(self.expected_regimes),
            "failure_modes": list(self.failure_modes),
            "implementation_constraints": dict(self.implementation_constraints),
            "confidence": str(self.confidence),
        }


def hypothesis_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"hyp-{_stable_hash(payload)[:24]}"


def build_hypothesis_cards(
    *,
    source_run_id: str,
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]] = (),
    min_confidence: Decimal = Decimal("0.50"),
) -> list[HypothesisCard]:
    normalized_claims = [dict(item) for item in claims if _claim_text(item)]
    if not normalized_claims:
        return []
    source_claim_ids = tuple(
        _claim_id(claim, index=index)
        for index, claim in enumerate(normalized_claims, start=1)
    )
    confidence_values = [
        _decimal(claim.get("confidence"), default="0.60") for claim in normalized_claims
    ]
    confidence = sum(confidence_values, Decimal("0")) / Decimal(len(confidence_values))
    if confidence < min_confidence:
        return []
    first_claim = normalized_claims[0]
    base_payload = {
        "source_run_id": source_run_id,
        "source_claim_ids": list(source_claim_ids),
        "mechanism": _mechanism_from_claims(normalized_claims),
        "required_features": list(
            _infer_terms(claims=normalized_claims, kind="required_features")
        ),
    }
    return [
        HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id=hypothesis_id_for_payload(base_payload),
            source_run_id=source_run_id,
            source_claim_ids=source_claim_ids,
            mechanism=str(base_payload["mechanism"]),
            asset_scope=_string(first_claim.get("asset_scope"))
            or "us_equities_intraday",
            horizon_scope=_string(first_claim.get("horizon_scope")) or "intraday",
            expected_direction=_string(first_claim.get("expected_direction"))
            or "positive",
            required_features=tuple(cast(list[str], base_payload["required_features"])),
            entry_motifs=_infer_terms(claims=normalized_claims, kind="entry_motifs")
            or ("runtime_default",),
            exit_motifs=_infer_terms(claims=normalized_claims, kind="exit_motifs")
            or ("time_exit",),
            risk_controls=_infer_terms(claims=normalized_claims, kind="risk_controls"),
            expected_regimes=_string_tuple(first_claim.get("expected_regimes"))
            or ("liquid_regular_session",),
            failure_modes=_failure_modes(normalized_claims, relations),
            implementation_constraints={
                "requires_runtime_family": True,
                "requires_scheduler_v3_replay": True,
                "requires_shadow_validation": True,
            },
            confidence=confidence,
        )
    ]


def hypothesis_card_from_payload(payload: Mapping[str, Any]) -> HypothesisCard:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != HYPOTHESIS_CARD_SCHEMA_VERSION:
        raise ValueError(f"hypothesis_card_schema_invalid:{schema_version}")
    return HypothesisCard(
        schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
        hypothesis_id=_string(payload.get("hypothesis_id")),
        source_run_id=_string(payload.get("source_run_id")),
        source_claim_ids=_string_tuple(payload.get("source_claim_ids")),
        mechanism=_string(payload.get("mechanism")),
        asset_scope=_string(payload.get("asset_scope")),
        horizon_scope=_string(payload.get("horizon_scope")),
        expected_direction=_string(payload.get("expected_direction")),
        required_features=_string_tuple(payload.get("required_features")),
        entry_motifs=_string_tuple(payload.get("entry_motifs")),
        exit_motifs=_string_tuple(payload.get("exit_motifs")),
        risk_controls=_string_tuple(payload.get("risk_controls")),
        expected_regimes=_string_tuple(payload.get("expected_regimes")),
        failure_modes=_string_tuple(payload.get("failure_modes")),
        implementation_constraints=_mapping(payload.get("implementation_constraints")),
        confidence=_decimal(payload.get("confidence")),
    )
