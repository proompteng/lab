"""Deterministic Janus-Q artifacts for event/CAR and HGRM reward evidence."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from ..evaluation import WalkForwardDecision
from ..models import SignalEnvelope

JANUS_EVENT_CAR_IMPL_VERSION = "2.0.0"
JANUS_HGRM_REWARD_IMPL_VERSION = "2.0.0"
JANUS_SCAFFOLD_BLOCKED_REASON = "janus_empirical_authority_missing"

_EVENT_TYPE_ALIASES: dict[str, str] = {
    "earnings_call": "earnings",
    "earnings_release": "earnings",
    "guidance_update": "guidance",
    "macro_news": "macro",
    "technical_indicator": "technical_indicator",
}


def _to_utc_iso(ts: datetime) -> str:
    resolved = ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)
    return resolved.astimezone(timezone.utc).isoformat()


def _decimal_str(value: Decimal) -> str:
    return str(value.normalize()) if value != 0 else "0"


def _hash_payload(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _safe_decimal(value: object) -> Decimal:
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return Decimal("0")


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _resolve_decision_signal_seq(decision: Any) -> int | None:
    raw_params = getattr(decision, "params", None)
    if not isinstance(raw_params, dict):
        return None
    params = cast(dict[str, Any], raw_params)
    for key in ("signal_seq", "seq"):
        seq = _safe_int(params.get(key))
        if seq is not None:
            return seq
    return None


def _normalize_event_type(raw: str) -> str:
    normalized = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return "unknown_event"
    return _EVENT_TYPE_ALIASES.get(normalized, normalized)


def _event_type(payload: dict[str, Any]) -> str:
    for key in (
        "event_type",
        "eventType",
        "news_event_type",
        "taxonomy",
        "signal_type",
    ):
        raw = payload.get(key)
        if isinstance(raw, str) and raw.strip():
            return _normalize_event_type(raw)
    if "macd" in payload or "rsi14" in payload or "rsi" in payload:
        return "technical_indicator"
    return "unknown_event"


def _clip_decimal(
    value: Decimal, *, floor: Decimal, ceil: Decimal
) -> tuple[Decimal, bool]:
    if value < floor:
        return floor, True
    if value > ceil:
        return ceil, True
    return value, False


def _event_dataset_snapshot_hash(signals: list[SignalEnvelope]) -> str:
    payload = [
        {
            "event_ts": _to_utc_iso(signal.event_ts),
            "symbol": signal.symbol,
            "seq": int(signal.seq or 0),
            "source": str(signal.source or "unknown"),
            "payload_hash": _hash_payload(signal.payload or {}),
        }
        for signal in signals
    ]
    return _hash_payload(payload)


def _event_schema_hash() -> str:
    return _hash_payload(
        {
            "schema_version": "janus-event-car-v1",
            "record_fields": [
                "event_id",
                "event_ts",
                "symbol",
                "seq",
                "event_type",
                "semantic_direction",
                "strength_label",
                "price_t",
                "price_t_plus_1",
                "raw_return",
                "abnormal_return",
                "risk_neutralized_return",
                "car",
                "payload_hash",
                "source",
            ],
        }
    )


def _reward_schema_hash() -> str:
    return _hash_payload(
        {
            "schema_version": "janus-hgrm-reward-v1",
            "record_fields": [
                "reward_id",
                "event_id",
                "event_ts",
                "symbol",
                "strategy_id",
                "action",
                "expected_direction",
                "event_type",
                "predicted_event_type",
                "direction_gate",
                "event_type_gate",
                "pnl_reward",
                "magnitude_reward",
                "process_reward",
                "final_reward_unclipped",
                "final_reward",
                "clipped",
            ],
        }
    )


def _decision_snapshot_hash(walk_decisions: list[WalkForwardDecision]) -> str:
    payload = [
        {
            "event_ts": _to_utc_iso(item.decision.event_ts),
            "symbol": item.decision.symbol,
            "strategy_id": item.decision.strategy_id,
            "action": item.decision.action,
            "signal_seq": _resolve_decision_signal_seq(item.decision),
        }
        for item in sorted(
            walk_decisions,
            key=lambda entry: (
                entry.decision.event_ts,
                entry.decision.symbol,
                entry.decision.strategy_id,
            ),
        )
    ]
    return _hash_payload(payload)


def _factor_neutralized_return(
    *,
    raw_return: Decimal,
    market_return: Decimal,
    payload: dict[str, Any],
) -> Decimal:
    beta_market = _safe_decimal(payload.get("beta_market"))
    if beta_market == 0 and payload.get("beta") is not None:
        beta_market = _safe_decimal(payload.get("beta"))
    if beta_market == 0:
        beta_market = Decimal("1")
    beta_sector = _safe_decimal(payload.get("beta_sector"))
    market_factor = _safe_decimal(payload.get("market_return"))
    if market_factor == 0:
        market_factor = market_return
    sector_factor = _safe_decimal(payload.get("sector_return"))
    factor_component = (beta_market * market_factor) + (beta_sector * sector_factor)
    return raw_return - factor_component


def _car_direction(car: Decimal) -> str:
    if car > 0:
        return "long"
    if car < 0:
        return "short"
    return "neutral"


def _strength_label(car: Decimal, *, threshold: Decimal) -> str:
    if abs(car) >= threshold:
        return "strong"
    return "weak"


def _janus_scaffold_authority(*, notes: str) -> dict[str, object]:
    return evidence_contract_payload(
        provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
        maturity=EvidenceMaturity.STUB,
        authoritative=False,
        placeholder=True,
        notes=notes,
    )


car_direction = _car_direction
clip_decimal = _clip_decimal
decision_snapshot_hash = _decision_snapshot_hash
decimal_str = _decimal_str
event_dataset_snapshot_hash = _event_dataset_snapshot_hash
event_schema_hash = _event_schema_hash
event_type = _event_type
factor_neutralized_return = _factor_neutralized_return
hash_payload = _hash_payload
janus_scaffold_authority = _janus_scaffold_authority
resolve_decision_signal_seq = _resolve_decision_signal_seq
reward_schema_hash = _reward_schema_hash
safe_decimal = _safe_decimal
strength_label = _strength_label
to_utc_iso = _to_utc_iso


@dataclass(frozen=True)
class JanusEventCarRecordV1:
    event_id: str
    event_ts: datetime
    symbol: str
    seq: int
    event_type: str
    semantic_direction: str
    strength_label: str
    price_t: str
    price_t_plus_1: str
    raw_return: str
    abnormal_return: str
    risk_neutralized_return: str
    car: str
    payload_hash: str
    source: str

    def to_payload(self) -> dict[str, object]:
        return {
            "event_id": self.event_id,
            "event_ts": _to_utc_iso(self.event_ts),
            "symbol": self.symbol,
            "seq": self.seq,
            "event_type": self.event_type,
            "semantic_direction": self.semantic_direction,
            "strength_label": self.strength_label,
            "price_t": self.price_t,
            "price_t_plus_1": self.price_t_plus_1,
            "raw_return": self.raw_return,
            "abnormal_return": self.abnormal_return,
            "risk_neutralized_return": self.risk_neutralized_return,
            "car": self.car,
            "payload_hash": self.payload_hash,
            "source": self.source,
        }


@dataclass(frozen=True)
class JanusEventCarArtifactV1:
    schema_version: str
    run_id: str
    generated_at: datetime
    methodology: dict[str, object]
    lineage: dict[str, object]
    records: list[JanusEventCarRecordV1]
    summary: dict[str, object]
    manifest_hash: str
    artifact_authority: dict[str, object]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "generated_at": _to_utc_iso(self.generated_at),
            "methodology": dict(self.methodology),
            "lineage": dict(self.lineage),
            "records": [item.to_payload() for item in self.records],
            "summary": dict(self.summary),
            "manifest_hash": self.manifest_hash,
            "artifact_authority": dict(self.artifact_authority),
        }


@dataclass(frozen=True)
class JanusHgrmRewardConfigV1:
    direction_gate_match: Decimal = Decimal("1")
    direction_gate_mismatch: Decimal = Decimal("-1")
    direction_gate_neutral: Decimal = Decimal("-0.50")
    event_type_gate_match: Decimal = Decimal("1")
    event_type_gate_mismatch: Decimal = Decimal("0.40")
    event_type_gate_unknown: Decimal = Decimal("0.70")
    transaction_cost_bps: Decimal = Decimal("5")
    magnitude_match_weight: Decimal = Decimal("1")
    magnitude_mismatch_weight: Decimal = Decimal("1")
    process_reward_bonus: Decimal = Decimal("0.10")
    final_reward_clip_floor: Decimal = Decimal("-3")
    final_reward_clip_ceil: Decimal = Decimal("3")

    def to_payload(self) -> dict[str, str]:
        return {
            "direction_gate_match": _decimal_str(self.direction_gate_match),
            "direction_gate_mismatch": _decimal_str(self.direction_gate_mismatch),
            "direction_gate_neutral": _decimal_str(self.direction_gate_neutral),
            "event_type_gate_match": _decimal_str(self.event_type_gate_match),
            "event_type_gate_mismatch": _decimal_str(self.event_type_gate_mismatch),
            "event_type_gate_unknown": _decimal_str(self.event_type_gate_unknown),
            "transaction_cost_bps": _decimal_str(self.transaction_cost_bps),
            "magnitude_match_weight": _decimal_str(self.magnitude_match_weight),
            "magnitude_mismatch_weight": _decimal_str(self.magnitude_mismatch_weight),
            "process_reward_bonus": _decimal_str(self.process_reward_bonus),
            "final_reward_clip_floor": _decimal_str(self.final_reward_clip_floor),
            "final_reward_clip_ceil": _decimal_str(self.final_reward_clip_ceil),
        }


@dataclass(frozen=True)
class JanusHgrmRewardRecordV1:
    reward_id: str
    event_id: str
    event_ts: datetime
    symbol: str
    strategy_id: str
    action: str
    expected_direction: str
    event_type: str
    predicted_event_type: str | None
    direction_gate: str
    event_type_gate: str
    pnl_reward: str
    magnitude_reward: str
    process_reward: str
    final_reward_unclipped: str
    final_reward: str
    clipped: bool

    def to_payload(self) -> dict[str, object]:
        return {
            "reward_id": self.reward_id,
            "event_id": self.event_id,
            "event_ts": _to_utc_iso(self.event_ts),
            "symbol": self.symbol,
            "strategy_id": self.strategy_id,
            "action": self.action,
            "expected_direction": self.expected_direction,
            "event_type": self.event_type,
            "predicted_event_type": self.predicted_event_type,
            "direction_gate": self.direction_gate,
            "event_type_gate": self.event_type_gate,
            "pnl_reward": self.pnl_reward,
            "magnitude_reward": self.magnitude_reward,
            "process_reward": self.process_reward,
            "final_reward_unclipped": self.final_reward_unclipped,
            "final_reward": self.final_reward,
            "clipped": self.clipped,
        }


@dataclass(frozen=True)
class JanusHgrmRewardArtifactV1:
    schema_version: str
    run_id: str
    candidate_id: str
    generated_at: datetime
    reward_version: str
    reward_config: dict[str, str]
    lineage: dict[str, object]
    rewards: list[JanusHgrmRewardRecordV1]
    summary: dict[str, object]
    manifest_hash: str
    artifact_authority: dict[str, object]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "candidate_id": self.candidate_id,
            "generated_at": _to_utc_iso(self.generated_at),
            "reward_version": self.reward_version,
            "reward_config": dict(self.reward_config),
            "lineage": dict(self.lineage),
            "rewards": [item.to_payload() for item in self.rewards],
            "summary": dict(self.summary),
            "manifest_hash": self.manifest_hash,
            "artifact_authority": dict(self.artifact_authority),
        }


def build_janus_event_car_artifact_v1(
    *,
    run_id: str,
    signals: list[SignalEnvelope],
    generated_at: datetime | None = None,
    strong_threshold: Decimal = Decimal("0.0025"),
    event_window_policy: str = "next_signal_same_symbol",
    abnormal_return_model: str = "cross_sectional_market_mean",
    risk_neutralization_model: str = "factor_linear_v1",
) -> JanusEventCarArtifactV1:
    from .janus_q_event_car import build_janus_event_car_artifact_v1_impl

    return build_janus_event_car_artifact_v1_impl(
        run_id=run_id,
        signals=signals,
        generated_at=generated_at,
        strong_threshold=strong_threshold,
        event_window_policy=event_window_policy,
        abnormal_return_model=abnormal_return_model,
        risk_neutralization_model=risk_neutralization_model,
    )


def build_janus_hgrm_reward_artifact_v1(
    *,
    run_id: str,
    candidate_id: str,
    event_car: JanusEventCarArtifactV1,
    walk_decisions: list[WalkForwardDecision],
    generated_at: datetime | None = None,
    reward_config: JanusHgrmRewardConfigV1 | None = None,
) -> JanusHgrmRewardArtifactV1:
    from .janus_q_hgrm import build_janus_hgrm_reward_artifact_v1_impl

    return build_janus_hgrm_reward_artifact_v1_impl(
        run_id=run_id,
        candidate_id=candidate_id,
        event_car=event_car,
        walk_decisions=walk_decisions,
        generated_at=generated_at,
        reward_config=reward_config,
    )


def build_janus_q_evidence_summary_v1(
    *,
    event_car: JanusEventCarArtifactV1,
    hgrm_reward: JanusHgrmRewardArtifactV1,
    event_car_artifact_ref: str,
    hgrm_reward_artifact_ref: str,
) -> dict[str, object]:
    event_count = _safe_int(event_car.summary.get("event_count", 0)) or 0
    reward_count = _safe_int(hgrm_reward.summary.get("reward_count", 0)) or 0
    mapped_count = _safe_int(hgrm_reward.summary.get("event_mapped_count", 0)) or 0
    reasons: list[str] = []
    if event_count <= 0:
        reasons.append("janus_event_count_missing")
    if reward_count <= 0:
        reasons.append("janus_reward_count_missing")
    if reward_count > 0 and mapped_count < reward_count:
        reasons.append("janus_reward_event_mapping_incomplete")
    reasons.append(JANUS_SCAFFOLD_BLOCKED_REASON)
    return {
        "schema_version": "janus-q-evidence-v1",
        "evidence_complete": False,
        "reasons": reasons,
        "event_car": {
            "schema_version": event_car.schema_version,
            "event_count": event_count,
            "manifest_hash": event_car.manifest_hash,
            "artifact_ref": event_car_artifact_ref,
            "artifact_authority": dict(event_car.artifact_authority),
        },
        "hgrm_reward": {
            "schema_version": hgrm_reward.schema_version,
            "reward_count": reward_count,
            "event_mapped_count": mapped_count,
            "direction_gate_pass_ratio": str(
                hgrm_reward.summary.get("direction_gate_pass_ratio", "0")
            ),
            "manifest_hash": hgrm_reward.manifest_hash,
            "artifact_ref": hgrm_reward_artifact_ref,
            "artifact_authority": dict(hgrm_reward.artifact_authority),
        },
        "artifact_authority": _janus_scaffold_authority(
            notes="Janus-Q evidence summary is currently assembled from deterministic scaffold artifacts."
        )
        | {"blocking_reason": JANUS_SCAFFOLD_BLOCKED_REASON},
    }


__all__ = [
    "JanusEventCarArtifactV1",
    "JanusEventCarRecordV1",
    "JanusHgrmRewardConfigV1",
    "JanusHgrmRewardArtifactV1",
    "JanusHgrmRewardRecordV1",
    "build_janus_event_car_artifact_v1",
    "build_janus_hgrm_reward_artifact_v1",
    "build_janus_q_evidence_summary_v1",
]
