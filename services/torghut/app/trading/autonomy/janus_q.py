"""Deterministic Janus-Q artifacts for event/CAR and HGRM reward evidence."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from ..evaluation import WalkForwardDecision
from ..features import extract_price
from ..models import SignalEnvelope

JANUS_EVENT_CAR_IMPL_VERSION = "2.0.0"
JANUS_HGRM_REWARD_IMPL_VERSION = "2.0.0"

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
    if event_window_policy != "next_signal_same_symbol":
        raise ValueError("unsupported_event_window_policy")
    if abnormal_return_model not in {"cross_sectional_market_mean", "identity"}:
        raise ValueError("unsupported_abnormal_return_model")
    if risk_neutralization_model not in {"factor_linear_v1", "identity"}:
        raise ValueError("unsupported_risk_neutralization_model")

    ordered = sorted(signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    if not ordered:
        raise ValueError("janus_event_car_requires_signals")

    next_price_by_index: dict[int, Decimal] = {}
    prices_by_index: dict[int, Decimal] = {}
    indices_by_symbol: dict[str, list[int]] = {}
    for index, signal in enumerate(ordered):
        indices_by_symbol.setdefault(signal.symbol, []).append(index)
        prices_by_index[index] = extract_price(signal.payload or {}) or Decimal("0")

    for indexes in indices_by_symbol.values():
        for offset, current_index in enumerate(indexes):
            current_price = prices_by_index.get(current_index, Decimal("0"))
            if offset + 1 >= len(indexes):
                next_price_by_index[current_index] = current_price
                continue
            next_index = indexes[offset + 1]
            next_price = prices_by_index.get(next_index, current_price)
            next_price_by_index[current_index] = next_price

    raw_returns_by_index: dict[int, Decimal] = {}
    raw_returns_by_ts: dict[str, list[Decimal]] = {}
    for index, signal in enumerate(ordered):
        price_t = prices_by_index.get(index, Decimal("0"))
        price_t1 = next_price_by_index.get(index, price_t)
        raw_return = Decimal("0")
        if price_t > 0:
            raw_return = (price_t1 - price_t) / price_t
        raw_returns_by_index[index] = raw_return
        ts_key = _to_utc_iso(signal.event_ts)
        raw_returns_by_ts.setdefault(ts_key, []).append(raw_return)

    market_mean_by_ts = {
        key: (
            sum(values, Decimal("0")) / Decimal(len(values)) if values else Decimal("0")
        )
        for key, values in raw_returns_by_ts.items()
    }

    records: list[JanusEventCarRecordV1] = []
    positive = 0
    negative = 0
    neutral = 0
    strong = 0
    unknown_event_type = 0
    abs_car_total = Decimal("0")
    for index, signal in enumerate(ordered):
        payload = signal.payload or {}
        ts_key = _to_utc_iso(signal.event_ts)
        raw_return = raw_returns_by_index.get(index, Decimal("0"))
        market_return = market_mean_by_ts.get(ts_key, Decimal("0"))
        abnormal = (
            raw_return - market_return
            if abnormal_return_model == "cross_sectional_market_mean"
            else raw_return
        )
        risk_neutralized = (
            _factor_neutralized_return(
                raw_return=raw_return,
                market_return=market_return,
                payload=payload,
            )
            if risk_neutralization_model == "factor_linear_v1"
            else abnormal
        )
        car = risk_neutralized
        direction = _car_direction(car)
        strength = _strength_label(car, threshold=strong_threshold)
        event_type = _event_type(payload)
        if event_type == "unknown_event":
            unknown_event_type += 1
        if direction == "long":
            positive += 1
        elif direction == "short":
            negative += 1
        else:
            neutral += 1
        if strength == "strong":
            strong += 1
        abs_car_total += abs(car)
        seq = int(signal.seq or 0)
        event_payload = {
            "event_ts": ts_key,
            "symbol": signal.symbol,
            "seq": seq,
            "source": signal.source,
            "payload": payload,
        }
        event_id = hashlib.sha256(
            json.dumps(event_payload, sort_keys=True, separators=(",", ":"), default=str).encode(
                "utf-8"
            )
        ).hexdigest()[:24]
        records.append(
            JanusEventCarRecordV1(
                event_id=event_id,
                event_ts=signal.event_ts,
                symbol=signal.symbol,
                seq=seq,
                event_type=event_type,
                semantic_direction=direction,
                strength_label=strength,
                price_t=_decimal_str(prices_by_index.get(index, Decimal("0"))),
                price_t_plus_1=_decimal_str(next_price_by_index.get(index, Decimal("0"))),
                raw_return=_decimal_str(raw_return),
                abnormal_return=_decimal_str(abnormal),
                risk_neutralized_return=_decimal_str(risk_neutralized),
                car=_decimal_str(car),
                payload_hash=_hash_payload(payload),
                source=str(signal.source or "unknown"),
            )
        )

    summary: dict[str, object] = {
        "event_count": len(records),
        "positive_direction_count": positive,
        "negative_direction_count": negative,
        "neutral_direction_count": neutral,
        "strong_event_count": strong,
        "unknown_event_type_count": unknown_event_type,
        "mean_abs_car": _decimal_str(
            abs_car_total / Decimal(len(records)) if records else Decimal("0")
        ),
    }
    methodology: dict[str, object] = {
        "stage": "m1_fidelity_upgrade",
        "event_window_policy": event_window_policy,
        "abnormal_return_model": abnormal_return_model,
        "risk_neutralization_model": risk_neutralization_model,
        "paper_alignment": {
            "car_reference": "janus_q_sec_3_1_eq_1_to_5",
            "label_reference": "janus_q_sec_3_1_2",
        },
    }
    lineage: dict[str, object] = {
        "dataset_snapshot_hash": _event_dataset_snapshot_hash(ordered),
        "schema_hash": _event_schema_hash(),
        "generation_code_hash": _hash_payload(
            {
                "impl_version": JANUS_EVENT_CAR_IMPL_VERSION,
                "function": "build_janus_event_car_artifact_v1",
            }
        ),
        "run_config_hash": _hash_payload(
            {
                "strong_threshold": _decimal_str(strong_threshold),
                "event_window_policy": event_window_policy,
                "abnormal_return_model": abnormal_return_model,
                "risk_neutralization_model": risk_neutralization_model,
            }
        ),
    }
    manifest = _hash_payload([item.to_payload() for item in records])
    return JanusEventCarArtifactV1(
        schema_version="janus-event-car-v1",
        run_id=run_id,
        generated_at=generated_at or datetime.now(timezone.utc),
        methodology=methodology,
        lineage=lineage,
        records=records,
        summary=summary,
        manifest_hash=manifest,
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
    resolved_config = reward_config or JanusHgrmRewardConfigV1()
    event_lookup_by_seq: dict[tuple[str, str, int], JanusEventCarRecordV1] = {}
    event_lookup_by_symbol_ts: dict[tuple[str, str], list[JanusEventCarRecordV1]] = {}
    for record in event_car.records:
        ts_key = _to_utc_iso(record.event_ts)
        symbol_key = record.symbol
        event_lookup_by_seq.setdefault((ts_key, symbol_key, record.seq), record)
        event_lookup_by_symbol_ts.setdefault((ts_key, symbol_key), []).append(record)

    rewards: list[JanusHgrmRewardRecordV1] = []
    mapped_count = 0
    ambiguous_unmapped_count = 0
    direction_pass = 0
    event_type_match = 0
    hard_gate_fail = 0
    clipped_final_reward = 0
    sum_final = Decimal("0")
    sum_pnl = Decimal("0")
    for item in sorted(
        walk_decisions,
        key=lambda entry: (
            entry.decision.event_ts,
            entry.decision.symbol,
            entry.decision.strategy_id,
        ),
    ):
        decision = item.decision
        lookup_key = (_to_utc_iso(decision.event_ts), decision.symbol)
        candidates = event_lookup_by_symbol_ts.get(lookup_key, [])
        decision_seq = _resolve_decision_signal_seq(decision)
        event: JanusEventCarRecordV1 | None = None
        if decision_seq is not None:
            event = event_lookup_by_seq.get((lookup_key[0], lookup_key[1], decision_seq))
        elif len(candidates) == 1:
            event = candidates[0]
        elif len(candidates) > 1:
            ambiguous_unmapped_count += 1

        expected_direction = "neutral"
        event_type = "unclassified_event"
        car = Decimal("0")
        event_id = "unmapped"
        if event is not None:
            mapped_count += 1
            expected_direction = event.semantic_direction
            event_type = event.event_type
            car = _safe_decimal(event.car)
            event_id = event.event_id

        action_direction = "long" if decision.action == "buy" else "short"
        if expected_direction == "neutral":
            direction_gate = resolved_config.direction_gate_neutral
        elif action_direction == expected_direction:
            direction_gate = resolved_config.direction_gate_match
            direction_pass += 1
        else:
            direction_gate = resolved_config.direction_gate_mismatch
            hard_gate_fail += 1

        predicted_event_type_raw = decision.params.get("event_type")
        predicted_event_type = (
            str(predicted_event_type_raw).strip().lower()
            if isinstance(predicted_event_type_raw, str) and predicted_event_type_raw.strip()
            else None
        )
        if predicted_event_type is None:
            event_type_gate = resolved_config.event_type_gate_unknown
        elif predicted_event_type == event_type:
            event_type_gate = resolved_config.event_type_gate_match
            event_type_match += 1
        else:
            event_type_gate = resolved_config.event_type_gate_mismatch

        position_sign = Decimal("1") if decision.action == "buy" else Decimal("-1")
        transaction_cost = resolved_config.transaction_cost_bps / Decimal("10000")
        pnl_reward = (car * position_sign) - transaction_cost
        if action_direction == expected_direction:
            magnitude_reward = abs(car) * resolved_config.magnitude_match_weight
        else:
            magnitude_reward = -abs(car) * resolved_config.magnitude_mismatch_weight
        process_reward = (
            resolved_config.process_reward_bonus
            if (decision.rationale or str(decision.params.get("rationale", "")).strip())
            else Decimal("0")
        )
        unclipped_final_reward = (
            (direction_gate * event_type_gate * pnl_reward)
            + magnitude_reward
            + process_reward
        )
        final_reward, was_clipped = _clip_decimal(
            unclipped_final_reward,
            floor=resolved_config.final_reward_clip_floor,
            ceil=resolved_config.final_reward_clip_ceil,
        )
        if was_clipped:
            clipped_final_reward += 1
        sum_final += final_reward
        sum_pnl += pnl_reward

        reward_payload = {
            "event_id": event_id,
            "strategy_id": decision.strategy_id,
            "symbol": decision.symbol,
            "event_ts": _to_utc_iso(decision.event_ts),
            "action": decision.action,
            "direction_gate": _decimal_str(direction_gate),
            "event_type_gate": _decimal_str(event_type_gate),
            "pnl_reward": _decimal_str(pnl_reward),
            "magnitude_reward": _decimal_str(magnitude_reward),
            "process_reward": _decimal_str(process_reward),
            "final_reward_unclipped": _decimal_str(unclipped_final_reward),
            "final_reward": _decimal_str(final_reward),
            "clipped": was_clipped,
        }
        rewards.append(
            JanusHgrmRewardRecordV1(
                reward_id=hashlib.sha256(
                    json.dumps(reward_payload, sort_keys=True, separators=(",", ":")).encode(
                        "utf-8"
                    )
                ).hexdigest()[:24],
                event_id=event_id,
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                strategy_id=decision.strategy_id,
                action=decision.action,
                expected_direction=expected_direction,
                event_type=event_type,
                predicted_event_type=predicted_event_type,
                direction_gate=_decimal_str(direction_gate),
                event_type_gate=_decimal_str(event_type_gate),
                pnl_reward=_decimal_str(pnl_reward),
                magnitude_reward=_decimal_str(magnitude_reward),
                process_reward=_decimal_str(process_reward),
                final_reward_unclipped=_decimal_str(unclipped_final_reward),
                final_reward=_decimal_str(final_reward),
                clipped=was_clipped,
            )
        )

    reward_count = len(rewards)
    summary: dict[str, object] = {
        "reward_count": reward_count,
        "event_mapped_count": mapped_count,
        "event_ambiguous_unmapped_count": ambiguous_unmapped_count,
        "hard_gate_fail_count": hard_gate_fail,
        "clipped_final_reward_count": clipped_final_reward,
        "direction_gate_pass_ratio": _decimal_str(
            Decimal(direction_pass) / Decimal(reward_count) if reward_count else Decimal("0")
        ),
        "event_type_match_ratio": _decimal_str(
            Decimal(event_type_match) / Decimal(reward_count) if reward_count else Decimal("0")
        ),
        "mean_final_reward": _decimal_str(
            sum_final / Decimal(reward_count) if reward_count else Decimal("0")
        ),
        "mean_pnl_reward": _decimal_str(
            sum_pnl / Decimal(reward_count) if reward_count else Decimal("0")
        ),
    }
    lineage: dict[str, object] = {
        "event_manifest_hash": event_car.manifest_hash,
        "decision_snapshot_hash": _decision_snapshot_hash(walk_decisions),
        "schema_hash": _reward_schema_hash(),
        "generation_code_hash": _hash_payload(
            {
                "impl_version": JANUS_HGRM_REWARD_IMPL_VERSION,
                "function": "build_janus_hgrm_reward_artifact_v1",
            }
        ),
        "run_config_hash": _hash_payload(resolved_config.to_payload()),
    }
    manifest = _hash_payload([item.to_payload() for item in rewards])
    return JanusHgrmRewardArtifactV1(
        schema_version="janus-hgrm-reward-v1",
        run_id=run_id,
        candidate_id=candidate_id,
        generated_at=generated_at or datetime.now(timezone.utc),
        reward_version="janus-hgrm-v1",
        reward_config=resolved_config.to_payload(),
        lineage=lineage,
        rewards=rewards,
        summary=summary,
        manifest_hash=manifest,
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
    return {
        "schema_version": "janus-q-evidence-v1",
        "evidence_complete": not reasons,
        "reasons": reasons,
        "event_car": {
            "schema_version": event_car.schema_version,
            "event_count": event_count,
            "manifest_hash": event_car.manifest_hash,
            "artifact_ref": event_car_artifact_ref,
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
        },
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
