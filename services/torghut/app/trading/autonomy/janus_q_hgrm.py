"""HGRM reward assembly helpers for Janus-Q artifacts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from ..evaluation import WalkForwardDecision
from .janus_q import (
    JANUS_HGRM_REWARD_IMPL_VERSION,
    JANUS_SCAFFOLD_BLOCKED_REASON,
    JanusEventCarArtifactV1,
    JanusEventCarRecordV1,
    JanusHgrmRewardArtifactV1,
    JanusHgrmRewardConfigV1,
    JanusHgrmRewardRecordV1,
    clip_decimal,
    decision_snapshot_hash,
    decimal_str,
    hash_payload,
    janus_scaffold_authority,
    resolve_decision_signal_seq,
    reward_schema_hash,
    safe_decimal,
    to_utc_iso,
)


@dataclass(frozen=True)
class _JanusRewardEventLookup:
    by_seq: dict[tuple[str, str, int], JanusEventCarRecordV1]
    by_symbol_ts: dict[tuple[str, str], list[JanusEventCarRecordV1]]


@dataclass(frozen=True)
class _ResolvedJanusRewardEvent:
    record: JanusEventCarRecordV1 | None
    ambiguous_unmapped: bool
    expected_direction: str
    event_type: str
    car: Decimal
    event_id: str


@dataclass(frozen=True)
class _JanusRewardGates:
    action_direction: str
    predicted_event_type: str | None
    direction_gate: Decimal
    event_type_gate: Decimal


@dataclass(frozen=True)
class _JanusRewardComponents:
    pnl_reward: Decimal
    magnitude_reward: Decimal
    process_reward: Decimal
    unclipped_final_reward: Decimal
    final_reward: Decimal
    was_clipped: bool


@dataclass(frozen=True)
class _JanusRewardBuildResult:
    rewards: list[JanusHgrmRewardRecordV1]
    ambiguous_unmapped_count: int


def build_janus_hgrm_reward_artifact_v1_impl(
    *,
    run_id: str,
    candidate_id: str,
    event_car: JanusEventCarArtifactV1,
    walk_decisions: list[WalkForwardDecision],
    generated_at: datetime | None = None,
    reward_config: JanusHgrmRewardConfigV1 | None = None,
) -> JanusHgrmRewardArtifactV1:
    resolved_config = reward_config or JanusHgrmRewardConfigV1()
    build_result = _janus_reward_build_result(
        walk_decisions=walk_decisions,
        lookup=_janus_reward_event_lookup(event_car.records),
        reward_config=resolved_config,
    )
    manifest = hash_payload([item.to_payload() for item in build_result.rewards])
    return JanusHgrmRewardArtifactV1(
        schema_version="janus-hgrm-reward-v1",
        run_id=run_id,
        candidate_id=candidate_id,
        generated_at=generated_at or datetime.now(timezone.utc),
        reward_version="janus-hgrm-v1",
        reward_config=resolved_config.to_payload(),
        lineage=_janus_reward_lineage(
            event_car=event_car,
            walk_decisions=walk_decisions,
            reward_config=resolved_config,
        ),
        rewards=build_result.rewards,
        summary=_janus_reward_summary(build_result, resolved_config),
        manifest_hash=manifest,
        artifact_authority=janus_scaffold_authority(
            notes="Janus HGRM reward artifact is currently deterministic scaffold output."
        )
        | {"blocking_reason": JANUS_SCAFFOLD_BLOCKED_REASON},
    )


def _janus_reward_event_lookup(
    records: list[JanusEventCarRecordV1],
) -> _JanusRewardEventLookup:
    by_seq: dict[tuple[str, str, int], JanusEventCarRecordV1] = {}
    by_symbol_ts: dict[tuple[str, str], list[JanusEventCarRecordV1]] = {}
    for record in records:
        ts_key = to_utc_iso(record.event_ts)
        by_seq.setdefault((ts_key, record.symbol, record.seq), record)
        by_symbol_ts.setdefault((ts_key, record.symbol), []).append(record)
    return _JanusRewardEventLookup(by_seq=by_seq, by_symbol_ts=by_symbol_ts)


def _janus_reward_build_result(
    *,
    walk_decisions: list[WalkForwardDecision],
    lookup: _JanusRewardEventLookup,
    reward_config: JanusHgrmRewardConfigV1,
) -> _JanusRewardBuildResult:
    rewards: list[JanusHgrmRewardRecordV1] = []
    ambiguous_unmapped_count = 0
    for item in sorted(walk_decisions, key=_walk_decision_sort_key):
        decision = item.decision
        resolved_event = _resolve_janus_reward_event(decision, lookup)
        if resolved_event.ambiguous_unmapped:
            ambiguous_unmapped_count += 1
        rewards.append(
            _janus_hgrm_reward_record(
                decision=decision,
                resolved_event=resolved_event,
                reward_config=reward_config,
            )
        )
    return _JanusRewardBuildResult(
        rewards=rewards,
        ambiguous_unmapped_count=ambiguous_unmapped_count,
    )


def _walk_decision_sort_key(item: WalkForwardDecision) -> tuple[datetime, str, str]:
    return (
        item.decision.event_ts,
        item.decision.symbol,
        item.decision.strategy_id,
    )


def _resolve_janus_reward_event(
    decision: Any,
    lookup: _JanusRewardEventLookup,
) -> _ResolvedJanusRewardEvent:
    lookup_key = (to_utc_iso(decision.event_ts), decision.symbol)
    candidates = lookup.by_symbol_ts.get(lookup_key, [])
    event = _janus_reward_event_for_decision(decision, lookup, lookup_key, candidates)
    ambiguous = resolve_decision_signal_seq(decision) is None and len(candidates) > 1
    if event is None:
        return _ResolvedJanusRewardEvent(
            record=None,
            ambiguous_unmapped=ambiguous,
            expected_direction="neutral",
            event_type="unclassified_event",
            car=Decimal("0"),
            event_id="unmapped",
        )
    return _ResolvedJanusRewardEvent(
        record=event,
        ambiguous_unmapped=False,
        expected_direction=event.semantic_direction,
        event_type=event.event_type,
        car=safe_decimal(event.car),
        event_id=event.event_id,
    )


def _janus_reward_event_for_decision(
    decision: Any,
    lookup: _JanusRewardEventLookup,
    lookup_key: tuple[str, str],
    candidates: list[JanusEventCarRecordV1],
) -> JanusEventCarRecordV1 | None:
    decision_seq = resolve_decision_signal_seq(decision)
    if decision_seq is not None:
        return lookup.by_seq.get((lookup_key[0], lookup_key[1], decision_seq))
    if len(candidates) == 1:
        return candidates[0]
    return None


def _janus_hgrm_reward_record(
    *,
    decision: Any,
    resolved_event: _ResolvedJanusRewardEvent,
    reward_config: JanusHgrmRewardConfigV1,
) -> JanusHgrmRewardRecordV1:
    gates = _janus_reward_gates(
        decision=decision,
        expected_direction=resolved_event.expected_direction,
        event_type=resolved_event.event_type,
        reward_config=reward_config,
    )
    components = _janus_reward_components(
        decision=decision,
        event=resolved_event,
        gates=gates,
        reward_config=reward_config,
    )
    payload = _janus_reward_payload(
        decision=decision,
        event_id=resolved_event.event_id,
        gates=gates,
        components=components,
    )
    return JanusHgrmRewardRecordV1(
        reward_id=hash_payload(payload)[:24],
        event_id=resolved_event.event_id,
        event_ts=decision.event_ts,
        symbol=decision.symbol,
        strategy_id=decision.strategy_id,
        action=decision.action,
        expected_direction=resolved_event.expected_direction,
        event_type=resolved_event.event_type,
        predicted_event_type=gates.predicted_event_type,
        direction_gate=decimal_str(gates.direction_gate),
        event_type_gate=decimal_str(gates.event_type_gate),
        pnl_reward=decimal_str(components.pnl_reward),
        magnitude_reward=decimal_str(components.magnitude_reward),
        process_reward=decimal_str(components.process_reward),
        final_reward_unclipped=decimal_str(components.unclipped_final_reward),
        final_reward=decimal_str(components.final_reward),
        clipped=components.was_clipped,
    )


def _janus_reward_gates(
    *,
    decision: Any,
    expected_direction: str,
    event_type: str,
    reward_config: JanusHgrmRewardConfigV1,
) -> _JanusRewardGates:
    action_direction = _janus_action_direction(decision.action)
    predicted_event_type = _janus_predicted_event_type(
        decision.params.get("event_type")
    )
    return _JanusRewardGates(
        action_direction=action_direction,
        predicted_event_type=predicted_event_type,
        direction_gate=_janus_direction_gate(
            action_direction=action_direction,
            expected_direction=expected_direction,
            reward_config=reward_config,
        ),
        event_type_gate=_janus_event_type_gate(
            predicted_event_type=predicted_event_type,
            event_type=event_type,
            reward_config=reward_config,
        ),
    )


def _janus_action_direction(action: str) -> str:
    return "long" if action == "buy" else "short"


def _janus_predicted_event_type(raw: object) -> str | None:
    if isinstance(raw, str) and raw.strip():
        return raw.strip().lower()
    return None


def _janus_direction_gate(
    *,
    action_direction: str,
    expected_direction: str,
    reward_config: JanusHgrmRewardConfigV1,
) -> Decimal:
    if expected_direction == "neutral":
        return reward_config.direction_gate_neutral
    if action_direction == expected_direction:
        return reward_config.direction_gate_match
    return reward_config.direction_gate_mismatch


def _janus_event_type_gate(
    *,
    predicted_event_type: str | None,
    event_type: str,
    reward_config: JanusHgrmRewardConfigV1,
) -> Decimal:
    if predicted_event_type is None:
        return reward_config.event_type_gate_unknown
    if predicted_event_type == event_type:
        return reward_config.event_type_gate_match
    return reward_config.event_type_gate_mismatch


def _janus_reward_components(
    *,
    decision: Any,
    event: _ResolvedJanusRewardEvent,
    gates: _JanusRewardGates,
    reward_config: JanusHgrmRewardConfigV1,
) -> _JanusRewardComponents:
    pnl_reward = _janus_pnl_reward(
        car=event.car,
        action_direction=gates.action_direction,
        reward_config=reward_config,
    )
    magnitude_reward = _janus_magnitude_reward(
        car=event.car,
        action_direction=gates.action_direction,
        expected_direction=event.expected_direction,
        reward_config=reward_config,
    )
    process_reward = _janus_process_reward(decision, reward_config)
    unclipped_final_reward = (
        (gates.direction_gate * gates.event_type_gate * pnl_reward)
        + magnitude_reward
        + process_reward
    )
    final_reward, was_clipped = clip_decimal(
        unclipped_final_reward,
        floor=reward_config.final_reward_clip_floor,
        ceil=reward_config.final_reward_clip_ceil,
    )
    return _JanusRewardComponents(
        pnl_reward=pnl_reward,
        magnitude_reward=magnitude_reward,
        process_reward=process_reward,
        unclipped_final_reward=unclipped_final_reward,
        final_reward=final_reward,
        was_clipped=was_clipped,
    )


def _janus_pnl_reward(
    *,
    car: Decimal,
    action_direction: str,
    reward_config: JanusHgrmRewardConfigV1,
) -> Decimal:
    position_sign = Decimal("1") if action_direction == "long" else Decimal("-1")
    transaction_cost = reward_config.transaction_cost_bps / Decimal("10000")
    return (car * position_sign) - transaction_cost


def _janus_magnitude_reward(
    *,
    car: Decimal,
    action_direction: str,
    expected_direction: str,
    reward_config: JanusHgrmRewardConfigV1,
) -> Decimal:
    if action_direction == expected_direction:
        return abs(car) * reward_config.magnitude_match_weight
    return -abs(car) * reward_config.magnitude_mismatch_weight


def _janus_process_reward(
    decision: Any,
    reward_config: JanusHgrmRewardConfigV1,
) -> Decimal:
    has_rationale = (
        decision.rationale or str(decision.params.get("rationale", "")).strip()
    )
    if has_rationale:
        return reward_config.process_reward_bonus
    return Decimal("0")


def _janus_reward_payload(
    *,
    decision: Any,
    event_id: str,
    gates: _JanusRewardGates,
    components: _JanusRewardComponents,
) -> dict[str, object]:
    return {
        "event_id": event_id,
        "strategy_id": decision.strategy_id,
        "symbol": decision.symbol,
        "event_ts": to_utc_iso(decision.event_ts),
        "action": decision.action,
        "direction_gate": decimal_str(gates.direction_gate),
        "event_type_gate": decimal_str(gates.event_type_gate),
        "pnl_reward": decimal_str(components.pnl_reward),
        "magnitude_reward": decimal_str(components.magnitude_reward),
        "process_reward": decimal_str(components.process_reward),
        "final_reward_unclipped": decimal_str(components.unclipped_final_reward),
        "final_reward": decimal_str(components.final_reward),
        "clipped": components.was_clipped,
    }


def _janus_reward_summary(
    result: _JanusRewardBuildResult,
    reward_config: JanusHgrmRewardConfigV1,
) -> dict[str, object]:
    rewards = result.rewards
    reward_count = len(rewards)
    return {
        "reward_count": reward_count,
        "event_mapped_count": sum(
            1 for reward in rewards if reward.event_id != "unmapped"
        ),
        "event_ambiguous_unmapped_count": result.ambiguous_unmapped_count,
        "hard_gate_fail_count": _janus_reward_gate_count(
            rewards,
            reward_config.direction_gate_mismatch,
            field_name="direction_gate",
        ),
        "clipped_final_reward_count": sum(1 for reward in rewards if reward.clipped),
        "direction_gate_pass_ratio": decimal_str(
            _janus_reward_ratio(
                _janus_reward_gate_count(
                    rewards,
                    reward_config.direction_gate_match,
                    field_name="direction_gate",
                ),
                reward_count,
            )
        ),
        "event_type_match_ratio": decimal_str(
            _janus_reward_ratio(
                _janus_reward_gate_count(
                    rewards,
                    reward_config.event_type_gate_match,
                    field_name="event_type_gate",
                ),
                reward_count,
            )
        ),
        "mean_final_reward": decimal_str(
            _janus_reward_mean(rewards, field_name="final_reward")
        ),
        "mean_pnl_reward": decimal_str(
            _janus_reward_mean(rewards, field_name="pnl_reward")
        ),
    }


def _janus_reward_gate_count(
    rewards: list[JanusHgrmRewardRecordV1],
    expected: Decimal,
    *,
    field_name: str,
) -> int:
    expected_value = decimal_str(expected)
    return sum(1 for reward in rewards if getattr(reward, field_name) == expected_value)


def _janus_reward_ratio(numerator: int, denominator: int) -> Decimal:
    if denominator:
        return Decimal(numerator) / Decimal(denominator)
    return Decimal("0")


def _janus_reward_mean(
    rewards: list[JanusHgrmRewardRecordV1],
    *,
    field_name: str,
) -> Decimal:
    if not rewards:
        return Decimal("0")
    total = sum(
        (safe_decimal(getattr(reward, field_name)) for reward in rewards),
        Decimal("0"),
    )
    return total / Decimal(len(rewards))


def _janus_reward_lineage(
    *,
    event_car: JanusEventCarArtifactV1,
    walk_decisions: list[WalkForwardDecision],
    reward_config: JanusHgrmRewardConfigV1,
) -> dict[str, object]:
    return {
        "event_manifest_hash": event_car.manifest_hash,
        "decision_snapshot_hash": decision_snapshot_hash(walk_decisions),
        "schema_hash": reward_schema_hash(),
        "generation_code_hash": hash_payload(
            {
                "impl_version": JANUS_HGRM_REWARD_IMPL_VERSION,
                "function": "build_janus_hgrm_reward_artifact_v1",
            }
        ),
        "run_config_hash": hash_payload(reward_config.to_payload()),
    }


__all__ = ["build_janus_hgrm_reward_artifact_v1_impl"]
