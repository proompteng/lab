"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast


EVIDENCE_BUNDLE_SCHEMA_VERSION = "torghut.candidate-evidence-bundle.v1"
VALID_COST_CALIBRATION_STATUSES = frozenset({"calibrated", "provisional"})
MARKET_IMPACT_STRESS_COST_BPS = Decimal("1")
DELAY_ADJUSTED_DEPTH_STRESS_MS = Decimal("50")
DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS = (
    Decimal("50"),
    Decimal("150"),
    Decimal("250"),
)
DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS = Decimal("1")
REPLAY_ACTIVITY_SCORECARD_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
    "avg_filled_notional_per_day",
    "daily_filled_notional",
    "decision_count_by_order_type",
    "filled_count_by_order_type",
    "limit_fill_rate",
    "market_limit_order_mix_sample_count",
    "market_limit_order_mix_evidence_present",
    "market_limit_order_mix_passed",
    "limit_fill_probability_sample_count",
    "limit_fill_probability_evidence_present",
    "route_tca_artifact_ref",
    "route_tca_artifact_refs",
    "route_tca_evidence_present",
    "order_type_execution_artifact_ref",
    "order_type_execution_artifact_refs",
    "order_type_ablation_artifact_ref",
    "order_type_ablation_artifact_refs",
    "execution_shortfall_evidence_present",
    "price_improvement_evidence_present",
    "opportunity_cost_evidence_present",
)
MARKET_IMPACT_SCORECARD_KEYS = (
    "market_impact_stress_passed",
    "market_impact_stress_artifact_ref",
    "market_impact_stress_model",
    "market_impact_stress_cost_bps",
    "market_impact_stress_net_pnl_per_day",
    "market_impact_stress_components",
    "nonlinear_market_impact_stress_passed",
    "nonlinear_market_impact_stress_model",
    "nonlinear_market_impact_stress_cost_bps",
    "nonlinear_market_impact_stress_net_pnl_per_day",
    "permanent_impact_decay_model",
    "implementation_uncertainty_required",
    "implementation_uncertainty_model",
    "implementation_uncertainty_model_count",
    "implementation_uncertainty_stability_passed",
    "implementation_uncertainty_lower_net_pnl_per_day",
    "implementation_uncertainty_upper_net_pnl_per_day",
    "implementation_uncertainty_interval_width_per_day",
    "implementation_uncertainty_target_net_pnl_per_day",
    "implementation_uncertainty_scenarios",
    "implementation_uncertainty_source_markers",
    "conformal_tail_risk_required",
    "conformal_tail_risk_model",
    "conformal_tail_risk_alpha",
    "conformal_tail_risk_sample_count",
    "conformal_tail_risk_buffer_per_day",
    "conformal_tail_risk_adjusted_net_pnl_per_day",
    "conformal_tail_risk_target_net_pnl_per_day",
    "conformal_tail_risk_passed",
    "conformal_tail_risk_source_markers",
)
DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS = (
    "delay_adjusted_depth_stress_passed",
    "delay_adjusted_depth_stress_model",
    "delay_adjusted_depth_stress_ms",
    "delay_adjusted_depth_latency_grid_ms",
    "delay_adjusted_depth_grid_max_stress_ms",
    "delay_adjusted_depth_liquidity_evidence_present",
    "delay_adjusted_depth_liquidity_missing_day_count",
    "delay_adjusted_depth_fillable_notional_per_day",
    "delay_adjusted_depth_worst_grid_fillable_notional_per_day",
    "delay_adjusted_depth_worst_active_day_fillable_notional",
    "delay_adjusted_depth_p10_active_day_fillable_notional",
    "delay_adjusted_depth_tail_coverage_passed",
    "delay_adjusted_depth_fillable_ratio",
    "delay_adjusted_depth_survival_adjusted_fillable_ratio",
    "delay_adjusted_depth_unfillable_notional_per_day",
    "delay_adjusted_depth_stress_net_pnl_per_day",
    "delay_adjusted_depth_fill_survival_evidence_present",
    "delay_adjusted_depth_fill_survival_sample_count",
    "delay_adjusted_depth_fill_survival_rate",
    "delay_adjusted_depth_queue_ratio_p95",
    "delay_adjusted_depth_queue_ahead_depletion_evidence_present",
    "delay_adjusted_depth_queue_ahead_depletion_sample_count",
    "queue_position_survival_fill_curve_evidence_present",
    "queue_position_survival_sample_count",
    "queue_position_survival_fill_rate",
    "queue_position_survival_queue_ratio_p95",
    "queue_position_survival_queue_ahead_depletion_evidence_present",
    "queue_position_survival_queue_ahead_depletion_sample_count",
    "queue_position_survival_adjusted_fillable_ratio",
    "queue_position_survival_nonfill_opportunity_cost_per_day",
    "queue_position_survival_nonfill_opportunity_cost_bps",
    "queue_position_survival_stress_net_pnl_per_day",
    "post_cost_net_pnl_after_queue_position_survival_fill_stress",
    "queue_position_survival_source_marker",
)
FILL_SURVIVAL_SCORECARD_KEYS = (
    "order_lifecycle",
    "fill_survival_evidence_present",
    "fill_survival_sample_count",
    "fill_survival_fill_rate",
    "fill_time_ms_avg",
    "fill_time_ms_p50",
    "fill_time_ms_p95",
    "pending_age_ms_p95",
    "max_censored_pending_age_ms",
    "spread_bps_avg_at_order",
    "spread_bps_p95_at_order",
    "depth_notional_min_at_order",
    "depth_notional_avg_at_order",
    "queue_touch_qty_avg",
    "queue_touch_notional_avg",
    "order_qty_to_touch_qty_ratio_p95",
    "queue_ahead_depletion_evidence_present",
    "queue_ahead_depletion_sample_count",
    "queue_ahead_depletion_rate",
    "queue_ahead_qty_p95",
    "queue_ahead_depleted_qty_p50",
    "queue_ahead_depleted_qty_p95",
    "queue_ahead_depletion_time_ms_p50",
    "queue_ahead_depletion_time_ms_p95",
    "fill_probability_by_latency_bucket",
    "fill_probability_by_latency_threshold_ms",
    "post_cost_survivorship",
    "post_cost_survival_rate",
    "gross_positive_killed_by_cost_count",
)
RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS = (
    "runtime_ledger_lineage_materialization_handoff",
)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


def _int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, Decimal):
        return value != 0
    if isinstance(value, (int, float)):
        return value != 0
    normalized = str(value).strip().lower()
    if normalized in {"", "0", "false", "f", "no", "n", "off", "none", "null"}:
        return False
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    return bool(value)


def _decimal_mapping_total(mapping: Mapping[str, Any]) -> Decimal:
    total = Decimal("0")
    for value in mapping.values():
        total += _decimal(value)
    return total


def _int_mapping(value: Any) -> dict[str, int]:
    if not isinstance(value, Mapping):
        return {}
    counts: dict[str, int] = {}
    for key, item in cast(Mapping[Any, Any], value).items():
        count = _int(item)
        normalized_key = _string(key).lower()
        if normalized_key:
            counts[normalized_key] = count
    return counts


def _frontier_replay_config(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(candidate.get("replay_config"))


def _frontier_replay_params(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(_frontier_replay_config(candidate).get("params"))


def _frontier_strategy_overrides(candidate: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(_frontier_replay_config(candidate).get("strategy_overrides"))


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    return [
        normalized
        for normalized in (_string(item) for item in cast(Sequence[Any], value))
        if normalized
    ]


def _order_type_execution_metrics(source: Mapping[str, Any]) -> dict[str, Any]:
    decision_counts = _int_mapping(source.get("decision_count_by_order_type"))
    filled_counts = _int_mapping(source.get("filled_count_by_order_type"))
    market_decision_count = max(0, decision_counts.get("market", 0))
    limit_decision_count = max(0, decision_counts.get("limit", 0))
    market_limit_sample_count = market_decision_count + limit_decision_count
    metrics: dict[str, Any] = {}
    if decision_counts:
        metrics["decision_count_by_order_type"] = decision_counts
    if filled_counts:
        metrics["filled_count_by_order_type"] = filled_counts
    if "limit_fill_rate" in source:
        metrics["limit_fill_rate"] = _string(source.get("limit_fill_rate") or "0")
    if market_limit_sample_count > 0:
        metrics["market_limit_order_mix_sample_count"] = market_limit_sample_count
        metrics["market_limit_order_mix_evidence_present"] = True
    if market_decision_count > 0 and limit_decision_count > 0:
        metrics["market_limit_order_mix_passed"] = True
    if limit_decision_count > 0:
        metrics["limit_fill_probability_sample_count"] = limit_decision_count
        metrics["limit_fill_probability_evidence_present"] = (
            "limit_fill_rate" in source or filled_counts.get("limit", 0) > 0
        )
    return metrics


def _order_lifecycle_metrics(source: Mapping[str, Any]) -> dict[str, Any]:
    lifecycle = _mapping(source.get("order_lifecycle"))
    if not lifecycle:
        return {}

    sample_count = max(
        _int(lifecycle.get("fill_survival_sample_count")),
        _int(lifecycle.get("submitted_order_count")),
    )
    if "fill_survival_evidence_present" in lifecycle:
        evidence_present = _bool(lifecycle.get("fill_survival_evidence_present"))
    else:
        evidence_present = sample_count > 0
    fill_rate = lifecycle.get("fill_survival_fill_rate") or lifecycle.get("fill_rate")
    queue_ahead_depletion_sample_count = max(
        _int(lifecycle.get("queue_ahead_depletion_sample_count")),
        _int(lifecycle.get("queue_depletion_sample_count")),
    )
    queue_ahead_depletion_evidence_present = _bool(
        lifecycle.get("queue_ahead_depletion_evidence_present")
    ) or (
        queue_ahead_depletion_sample_count > 0
        and (
            lifecycle.get("queue_ahead_depletion_rate") is not None
            or lifecycle.get("queue_ahead_depleted_qty_p50") is not None
            or lifecycle.get("queue_ahead_depletion_time_ms_p50") is not None
        )
    )

    metrics: dict[str, Any] = {
        "order_lifecycle": lifecycle,
        "fill_survival_evidence_present": evidence_present,
        "fill_survival_sample_count": sample_count,
        "queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "queue_ahead_depletion_sample_count": queue_ahead_depletion_sample_count,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": (
            queue_ahead_depletion_evidence_present
        ),
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": (
            queue_ahead_depletion_sample_count
        ),
    }
    if fill_rate is not None:
        metrics["fill_survival_fill_rate"] = _string(fill_rate)
        metrics["delay_adjusted_depth_fill_survival_rate"] = _string(fill_rate)
    if sample_count > 0:
        metrics["delay_adjusted_depth_fill_survival_sample_count"] = sample_count
        metrics["delay_adjusted_depth_fill_survival_evidence_present"] = (
            evidence_present
        )

    for key in (
        "fill_time_ms_avg",
        "fill_time_ms_p50",
        "fill_time_ms_p95",
        "pending_age_ms_p95",
        "max_censored_pending_age_ms",
        "spread_bps_avg_at_order",
        "spread_bps_p95_at_order",
        "depth_notional_min_at_order",
        "depth_notional_avg_at_order",
        "queue_touch_qty_avg",
        "queue_touch_notional_avg",
        "order_qty_to_touch_qty_ratio_p95",
        "queue_ahead_depletion_rate",
        "queue_ahead_qty_p95",
        "queue_ahead_depleted_qty_p50",
        "queue_ahead_depleted_qty_p95",
        "queue_ahead_depletion_time_ms_p50",
        "queue_ahead_depletion_time_ms_p95",
        "fill_probability_by_latency_bucket",
        "fill_probability_by_latency_threshold_ms",
        "post_cost_survivorship",
    ):
        if key in lifecycle:
            metrics[key] = lifecycle[key]

    queue_ratio_p95 = _string(lifecycle.get("order_qty_to_touch_qty_ratio_p95"))
    if queue_ratio_p95:
        metrics["delay_adjusted_depth_queue_ratio_p95"] = queue_ratio_p95

    survivorship = _mapping(lifecycle.get("post_cost_survivorship"))
    if survivorship:
        survival_rate = _string(survivorship.get("post_cost_survival_rate"))
        if survival_rate:
            metrics["post_cost_survival_rate"] = survival_rate
        metrics["gross_positive_killed_by_cost_count"] = _int(
            survivorship.get("gross_positive_killed_by_cost_count")
        )

    return metrics


def _order_type_ablation_metrics(source: Mapping[str, Any]) -> dict[str, Any]:
    raw_ablation = source.get("order_type_ablation")
    if not isinstance(raw_ablation, Mapping):
        return {}
    ablation = cast(Mapping[str, Any], raw_ablation)
    metrics: dict[str, Any] = {}
    artifact_ref = _string(
        ablation.get("artifact_ref") or ablation.get("order_type_ablation_artifact_ref")
    )
    if artifact_ref:
        metrics["order_type_ablation_artifact_ref"] = artifact_ref
    sample_count = _int(
        ablation.get("sample_count") or ablation.get("order_type_ablation_sample_count")
    )
    if sample_count > 0:
        metrics["order_type_ablation_sample_count"] = sample_count
        metrics["market_limit_order_mix_sample_count"] = sample_count
        metrics["market_limit_order_mix_evidence_present"] = True
    if "passed" in ablation:
        passed = bool(ablation.get("passed"))
        metrics["order_type_ablation_passed"] = passed
        metrics["market_limit_execution_policy_passed"] = passed
    selected_order_type = _string(
        ablation.get("selected_order_type")
        or ablation.get("order_type_ablation_selected_order_type")
    )
    if selected_order_type:
        metrics["order_type_ablation_selected_order_type"] = selected_order_type
    opportunity_cost_bps = _string(
        ablation.get("opportunity_cost_bps")
        or ablation.get("order_type_opportunity_cost_bps")
    )
    if opportunity_cost_bps:
        metrics["order_type_opportunity_cost_bps"] = opportunity_cost_bps
        metrics["order_type_opportunity_cost_evidence_present"] = True
        metrics["opportunity_cost_evidence_present"] = True
    limit_sample_count = _int(
        ablation.get("limit_sample_count")
        or ablation.get("limit_fill_probability_sample_count")
    )
    if limit_sample_count > 0:
        metrics["limit_fill_probability_sample_count"] = limit_sample_count
        metrics["limit_fill_probability_evidence_present"] = True
    return metrics


def _artifact_refs_from_scorecard(scorecard: Mapping[str, Any]) -> tuple[str, ...]:
    refs: list[str] = []
    for key in (
        "route_tca_artifact_ref",
        "order_type_execution_artifact_ref",
        "market_limit_order_mix_artifact_ref",
        "order_type_ablation_artifact_ref",
        "market_impact_stress_artifact_ref",
        "delay_adjusted_depth_stress_artifact_ref",
        "exact_replay_ledger_artifact_ref",
    ):
        ref = _string(scorecard.get(key))
        if ref:
            refs.append(ref)
    for key in (
        "route_tca_artifact_refs",
        "order_type_execution_artifact_refs",
        "market_limit_order_mix_artifact_refs",
        "order_type_ablation_artifact_refs",
        "exact_replay_ledger_artifact_refs",
    ):
        raw_refs = scorecard.get(key)
        if isinstance(raw_refs, str):
            ref = _string(raw_refs)
            if ref:
                refs.append(ref)
            continue
        for raw_ref in cast(Sequence[Any], raw_refs or ()):
            ref = _string(raw_ref)
            if ref:
                refs.append(ref)
    return tuple(dict.fromkeys(refs))


def _runtime_ledger_lineage_handoff(
    *,
    scorecard: Mapping[str, Any],
    promotion_readiness: Mapping[str, Any],
) -> dict[str, Any]:
    return _mapping(
        scorecard.get("runtime_ledger_lineage_materialization_handoff")
    ) or _mapping(
        promotion_readiness.get("runtime_ledger_lineage_materialization_handoff")
    )


def _runtime_ledger_lineage_handoff_blockers(
    *,
    scorecard: Mapping[str, Any],
    promotion_readiness: Mapping[str, Any],
) -> list[str]:
    handoff = _runtime_ledger_lineage_handoff(
        scorecard=scorecard,
        promotion_readiness=promotion_readiness,
    )
    if not handoff:
        return []

    blockers: list[str] = []
    if _bool(handoff.get("zero_authoritative_daily_pnl_until_materialized")):
        blockers.append("authoritative_daily_pnl_missing")

    requires_runtime_ledger = (
        _bool(handoff.get("runtime_ledger_required"))
        or _bool(handoff.get("source_backed_runtime_ledger_required"))
        or _string(handoff.get("status"))
        == "requires_runtime_ledger_materialization_before_authoritative_pnl"
    )
    materialized = (
        _bool(handoff.get("runtime_ledger_materialized"))
        or _string(handoff.get("status")) == "runtime_ledger_materialized"
    )
    if requires_runtime_ledger and not materialized:
        blockers.append("runtime_ledger_lineage_materialization_missing")

    for key, blocker in (
        ("proof_authority", "runtime_ledger_handoff_not_proof_authority"),
        ("promotion_allowed", "runtime_ledger_handoff_not_promotion_authority"),
        ("final_authority_ok", "runtime_ledger_handoff_final_authority_blocked"),
    ):
        if key in handoff and not _bool(handoff.get(key)):
            blockers.append(blocker)

    required_artifacts = handoff.get("required_materialized_artifacts")
    if (
        isinstance(required_artifacts, Sequence)
        and not isinstance(required_artifacts, (str, bytes, bytearray))
        and not materialized
    ):
        blockers.append("runtime_ledger_required_artifacts_unmaterialized")

    return blockers


def _p10(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    ordered = sorted(values)
    index = int((len(ordered) - 1) * 0.10)
    return ordered[index]


def _delay_depth_fillability(
    *,
    daily_filled_notional: Mapping[str, Any],
    daily_liquidity_notional: Mapping[str, Any],
    stress_ms: Decimal,
) -> tuple[Decimal, int, list[Decimal]]:
    haircut_rate = min(Decimal("0.50"), stress_ms / Decimal("1000"))
    total_fillable_notional = Decimal("0")
    missing_liquidity_day_count = 0
    active_day_fillable: list[Decimal] = []
    for day, raw_filled_notional in daily_filled_notional.items():
        filled_notional = _decimal(raw_filled_notional)
        if filled_notional <= 0:
            continue
        liquidity_notional = _decimal(daily_liquidity_notional.get(day))
        if liquidity_notional <= 0:
            missing_liquidity_day_count += 1
            active_day_fillable.append(Decimal("0"))
            continue
        fillable_notional = min(
            filled_notional,
            liquidity_notional * (Decimal("1") - haircut_rate),
        )
        active_day_fillable.append(fillable_notional)
        total_fillable_notional += fillable_notional
    return total_fillable_notional, missing_liquidity_day_count, active_day_fillable


def _sum_mapping_int_values(mapping: Mapping[str, Any], key: str) -> int:
    total = 0
    for payload in mapping.values():
        total += _int(_mapping(payload).get(key))
    return total


def _is_synthetic_dataset_snapshot(dataset_snapshot_id: str) -> bool:
    normalized = dataset_snapshot_id.strip().lower()
    return any(
        token in normalized
        for token in (
            "synthetic",
            "simulated",
            "pre-replay",
            "proposal-prior",
            "placeholder",
        )
    )


def _freshness_status_from_validation_status(status: str) -> str:
    normalized = status.strip().lower()
    if normalized == "valid":
        return "fresh"
    if normalized in {"stale_override", "stale", "expired", "not_fresh"}:
        return "stale"
    return normalized


def _scorecard_with_freshness_lineage(
    *,
    scorecard: Mapping[str, Any],
    candidate: Mapping[str, Any],
) -> dict[str, Any]:
    enriched = dict(scorecard)
    replay_tape = _mapping(candidate.get("replay_tape"))
    if replay_tape and "replay_tape" not in enriched:
        enriched["replay_tape"] = replay_tape

    replay_status = _string(
        replay_tape.get("status") or replay_tape.get("validation_status")
    )
    if replay_status and "tape_freshness_status" not in enriched:
        enriched["tape_freshness_status"] = _freshness_status_from_validation_status(
            replay_status
        )
    if _bool(replay_tape.get("stale_override_used")) or replay_status.lower() in {
        "stale_override",
        "stale",
    }:
        enriched["stale_override_used"] = True

    dataset_receipt = _mapping(
        candidate.get("dataset_snapshot_receipt")
        or candidate.get("dataset_snapshot")
        or candidate.get("dataset_receipt")
    )
    if dataset_receipt and "dataset_snapshot_receipt" not in enriched:
        enriched["dataset_snapshot_receipt"] = dataset_receipt
    if dataset_receipt:
        if _bool(dataset_receipt.get("stale_override_used")):
            enriched["stale_override_used"] = True
        is_fresh = dataset_receipt.get("is_fresh")
        if is_fresh is not None and "dataset_freshness_status" not in enriched:
            enriched["dataset_freshness_status"] = (
                "fresh" if _bool(is_fresh) else "stale"
            )
    return enriched


def _decomposition_symbol_contribution_shares(
    candidate: Mapping[str, Any],
) -> dict[str, str]:
    decomposition = _mapping(candidate.get("decomposition"))
    raw_symbols = _mapping(decomposition.get("symbols"))
    shares: dict[str, str] = {}
    for raw_symbol, raw_payload in raw_symbols.items():
        symbol = _string(raw_symbol).upper()
        payload = _mapping(raw_payload)
        share = _string(payload.get("positive_pnl_share"))
        if symbol and share:
            shares[symbol] = share
    return shares


def _decomposition_activity_counts(candidate: Mapping[str, Any]) -> dict[str, int]:
    decomposition = _mapping(candidate.get("decomposition"))
    families = _mapping(decomposition.get("families"))
    symbols = _mapping(decomposition.get("symbols"))
    decision_count = _sum_mapping_int_values(families, "evaluations")
    filled_count = max(
        _sum_mapping_int_values(families, "fills"),
        _sum_mapping_int_values(symbols, "filled_count"),
    )
    counts: dict[str, int] = {}
    if decision_count > 0:
        counts["decision_count"] = decision_count
    if filled_count > 0:
        counts["filled_count"] = filled_count
        counts["filled_order_count"] = filled_count
    return counts


def _enrich_scorecard_with_replay_stress_metrics(
    *,
    scorecard: Mapping[str, Any],
    full_window: Mapping[str, Any],
    result_path: str,
) -> dict[str, Any]:
    enriched = dict(scorecard)
    net_pnl_per_day = _decimal(
        enriched.get("net_pnl_per_day") or full_window.get("net_per_day")
    )
    avg_filled_notional_per_day = _decimal(
        enriched.get("avg_filled_notional_per_day")
        or full_window.get("avg_filled_notional_per_day")
    )
    trading_day_count = _decimal(
        enriched.get("trading_day_count") or full_window.get("trading_day_count")
    )
    daily_filled_notional = _mapping(full_window.get("daily_filled_notional"))
    daily_liquidity_notional = _mapping(full_window.get("daily_liquidity_notional"))
    if daily_liquidity_notional and "daily_liquidity_notional" not in enriched:
        enriched["daily_liquidity_notional"] = daily_liquidity_notional
    if (
        daily_liquidity_notional
        and "market_impact_liquidity_evidence_present" not in enriched
    ):
        enriched["market_impact_liquidity_evidence_present"] = True
    if daily_liquidity_notional and "market_impact_liquidity_day_count" not in enriched:
        enriched["market_impact_liquidity_day_count"] = len(daily_liquidity_notional)
    avg_liquidity_notional_per_day = _decimal(
        enriched.get("avg_liquidity_notional_per_day")
        or full_window.get("avg_liquidity_notional_per_day")
    )
    if (
        avg_liquidity_notional_per_day <= 0
        and daily_liquidity_notional
        and trading_day_count > 0
    ):
        avg_liquidity_notional_per_day = (
            _decimal_mapping_total(daily_liquidity_notional) / trading_day_count
        )
    if (
        avg_liquidity_notional_per_day > 0
        and "avg_liquidity_notional_per_day" not in enriched
    ):
        enriched["avg_liquidity_notional_per_day"] = str(avg_liquidity_notional_per_day)

    market_impact_components = _mapping(enriched.get("market_impact_stress_components"))
    has_nonlinear_market_impact_proof = bool(
        market_impact_components.get("source_marker")
        and _string(
            enriched.get("nonlinear_market_impact_stress_model")
            or enriched.get("market_impact_stress_model")
        )
        and _decimal(
            enriched.get("nonlinear_market_impact_stress_cost_bps")
            or enriched.get("market_impact_stress_cost_bps")
        )
        > 0
        and _string(
            enriched.get("nonlinear_market_impact_stress_net_pnl_per_day")
            or enriched.get("market_impact_stress_net_pnl_per_day")
        )
    )
    if (
        has_nonlinear_market_impact_proof
        and "market_impact_stress_artifact_ref" not in enriched
    ):
        enriched["market_impact_stress_artifact_ref"] = result_path
    if has_nonlinear_market_impact_proof:
        if "nonlinear_market_impact_stress_model" not in enriched:
            enriched["nonlinear_market_impact_stress_model"] = enriched.get(
                "market_impact_stress_model"
            )
        if "nonlinear_market_impact_stress_cost_bps" not in enriched:
            enriched["nonlinear_market_impact_stress_cost_bps"] = enriched.get(
                "market_impact_stress_cost_bps"
            )
        if "nonlinear_market_impact_stress_net_pnl_per_day" not in enriched:
            enriched["nonlinear_market_impact_stress_net_pnl_per_day"] = enriched.get(
                "market_impact_stress_net_pnl_per_day"
            )
        if "nonlinear_market_impact_stress_passed" not in enriched:
            enriched["nonlinear_market_impact_stress_passed"] = bool(
                enriched.get("market_impact_stress_passed")
            )
    else:
        enriched["market_impact_stress_passed"] = False
        enriched["nonlinear_market_impact_stress_passed"] = False
        enriched["nonlinear_market_impact_stress_missing"] = True

    delay_depth_total_filled_notional = _decimal_mapping_total(daily_filled_notional)
    if delay_depth_total_filled_notional <= 0 and trading_day_count > 0:
        delay_depth_total_filled_notional = (
            avg_filled_notional_per_day * trading_day_count
        )
    (
        delay_depth_total_fillable_notional,
        delay_depth_missing_liquidity_day_count,
        _active_day_fillable,
    ) = _delay_depth_fillability(
        daily_filled_notional=daily_filled_notional,
        daily_liquidity_notional=daily_liquidity_notional,
        stress_ms=DELAY_ADJUSTED_DEPTH_STRESS_MS,
    )
    grid_fillability = {
        str(stress_ms): _delay_depth_fillability(
            daily_filled_notional=daily_filled_notional,
            daily_liquidity_notional=daily_liquidity_notional,
            stress_ms=stress_ms,
        )
        for stress_ms in DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS
    }
    max_grid_stress_ms = max(DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS)
    (
        grid_worst_total_fillable_notional,
        grid_worst_missing_liquidity_day_count,
        grid_worst_active_day_fillable,
    ) = grid_fillability[str(max_grid_stress_ms)]
    p10_active_day_fillable = _p10(grid_worst_active_day_fillable)
    worst_active_day_fillable = (
        min(grid_worst_active_day_fillable)
        if grid_worst_active_day_fillable
        else Decimal("0")
    )
    tail_coverage_passed = (
        bool(grid_worst_active_day_fillable)
        and grid_worst_missing_liquidity_day_count == 0
        and p10_active_day_fillable > 0
        and worst_active_day_fillable > 0
    )
    delay_depth_fillable_notional_per_day = (
        delay_depth_total_fillable_notional / trading_day_count
        if trading_day_count > 0
        else Decimal("0")
    )
    delay_depth_cost_per_day = (
        delay_depth_fillable_notional_per_day
        * DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS
        / Decimal("10000")
    )
    delay_depth_fillable_ratio = (
        delay_depth_total_fillable_notional / delay_depth_total_filled_notional
        if delay_depth_total_filled_notional > 0
        else Decimal("1")
    )
    fill_survival_sample_count = max(
        _int(enriched.get("fill_survival_sample_count")),
        _int(enriched.get("delay_adjusted_depth_fill_survival_sample_count")),
    )
    fill_survival_rate_value = enriched.get(
        "delay_adjusted_depth_fill_survival_rate"
    ) or enriched.get("fill_survival_fill_rate")
    fill_survival_rate = _decimal(fill_survival_rate_value)
    has_fill_survival_evidence = (
        _bool(enriched.get("fill_survival_evidence_present"))
        or _bool(enriched.get("delay_adjusted_depth_fill_survival_evidence_present"))
    ) and fill_survival_sample_count > 0
    survival_adjusted_fillable_ratio = delay_depth_fillable_ratio
    if fill_survival_sample_count > 0 or has_fill_survival_evidence:
        survival_adjusted_fillable_ratio *= max(
            Decimal("0"), min(Decimal("1"), fill_survival_rate)
        )
    delay_depth_net_pnl_per_day = (
        net_pnl_per_day * survival_adjusted_fillable_ratio
    ) - delay_depth_cost_per_day
    if "delay_adjusted_depth_stress_model" not in enriched:
        enriched["delay_adjusted_depth_stress_model"] = "latency_depth_haircut"
    if "delay_adjusted_depth_stress_ms" not in enriched:
        enriched["delay_adjusted_depth_stress_ms"] = str(DELAY_ADJUSTED_DEPTH_STRESS_MS)
    if "delay_adjusted_depth_latency_grid_ms" not in enriched:
        enriched["delay_adjusted_depth_latency_grid_ms"] = [
            str(stress_ms) for stress_ms in DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS
        ]
    if "delay_adjusted_depth_grid_max_stress_ms" not in enriched:
        enriched["delay_adjusted_depth_grid_max_stress_ms"] = str(max_grid_stress_ms)
    if "delay_adjusted_depth_fillable_notional_per_day" not in enriched:
        enriched["delay_adjusted_depth_fillable_notional_per_day"] = str(
            delay_depth_fillable_notional_per_day
        )
    if "delay_adjusted_depth_worst_grid_fillable_notional_per_day" not in enriched:
        enriched["delay_adjusted_depth_worst_grid_fillable_notional_per_day"] = str(
            grid_worst_total_fillable_notional / trading_day_count
            if trading_day_count > 0
            else Decimal("0")
        )
    if "delay_adjusted_depth_worst_active_day_fillable_notional" not in enriched:
        enriched["delay_adjusted_depth_worst_active_day_fillable_notional"] = str(
            worst_active_day_fillable
        )
    if "delay_adjusted_depth_p10_active_day_fillable_notional" not in enriched:
        enriched["delay_adjusted_depth_p10_active_day_fillable_notional"] = str(
            p10_active_day_fillable
        )
    if "delay_adjusted_depth_tail_coverage_passed" not in enriched:
        enriched["delay_adjusted_depth_tail_coverage_passed"] = tail_coverage_passed
    if "delay_adjusted_depth_liquidity_evidence_present" not in enriched:
        enriched["delay_adjusted_depth_liquidity_evidence_present"] = (
            bool(daily_liquidity_notional)
            and grid_worst_missing_liquidity_day_count == 0
            and (
                delay_depth_total_fillable_notional > 0
                or delay_depth_total_filled_notional <= 0
            )
        )
    if "delay_adjusted_depth_liquidity_missing_day_count" not in enriched:
        enriched["delay_adjusted_depth_liquidity_missing_day_count"] = max(
            delay_depth_missing_liquidity_day_count,
            grid_worst_missing_liquidity_day_count,
        )
    if "delay_adjusted_depth_fillable_ratio" not in enriched:
        enriched["delay_adjusted_depth_fillable_ratio"] = str(
            delay_depth_fillable_ratio
        )
    if "delay_adjusted_depth_survival_adjusted_fillable_ratio" not in enriched:
        enriched["delay_adjusted_depth_survival_adjusted_fillable_ratio"] = str(
            survival_adjusted_fillable_ratio
        )
    if "delay_adjusted_depth_fill_survival_sample_count" not in enriched:
        enriched["delay_adjusted_depth_fill_survival_sample_count"] = (
            fill_survival_sample_count
        )
    if "delay_adjusted_depth_fill_survival_evidence_present" not in enriched:
        enriched["delay_adjusted_depth_fill_survival_evidence_present"] = (
            has_fill_survival_evidence
        )
    if "delay_adjusted_depth_fill_survival_rate" not in enriched and _string(
        fill_survival_rate_value
    ):
        enriched["delay_adjusted_depth_fill_survival_rate"] = str(fill_survival_rate)
    if "delay_adjusted_depth_unfillable_notional_per_day" not in enriched:
        enriched["delay_adjusted_depth_unfillable_notional_per_day"] = str(
            max(
                Decimal("0"),
                (
                    delay_depth_total_filled_notional
                    - delay_depth_total_fillable_notional
                )
                / trading_day_count
                if trading_day_count > 0
                else Decimal("0"),
            )
        )
    if "delay_adjusted_depth_stress_net_pnl_per_day" not in enriched:
        enriched["delay_adjusted_depth_stress_net_pnl_per_day"] = str(
            delay_depth_net_pnl_per_day
        )
    if "delay_adjusted_depth_stress_artifact_ref" not in enriched:
        enriched["delay_adjusted_depth_stress_artifact_ref"] = result_path
    if "delay_adjusted_depth_stress_passed" not in enriched:
        enriched["delay_adjusted_depth_stress_passed"] = (
            _bool(enriched.get("delay_adjusted_depth_liquidity_evidence_present"))
            and _bool(enriched.get("delay_adjusted_depth_tail_coverage_passed"))
            and delay_depth_fillable_notional_per_day > 0
            and delay_depth_net_pnl_per_day > 0
        )
    return enriched


@dataclass(frozen=True)
class CandidateEvidenceBundle:
    schema_version: Literal["torghut.candidate-evidence-bundle.v1"]
    evidence_bundle_id: str
    candidate_id: str
    candidate_spec_id: str
    dataset_snapshot_id: str
    feature_spec_hash: str
    code_commit: str
    replay_artifact_refs: tuple[str, ...]
    objective_scorecard: Mapping[str, Any]
    fold_metrics: tuple[Mapping[str, Any], ...]
    stress_metrics: tuple[Mapping[str, Any], ...]
    cost_calibration: Mapping[str, Any]
    null_comparator: Mapping[str, Any]
    promotion_readiness: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "evidence_bundle_id": self.evidence_bundle_id,
            "candidate_id": self.candidate_id,
            "candidate_spec_id": self.candidate_spec_id,
            "dataset_snapshot_id": self.dataset_snapshot_id,
            "feature_spec_hash": self.feature_spec_hash,
            "code_commit": self.code_commit,
            "replay_artifact_refs": list(self.replay_artifact_refs),
            "objective_scorecard": dict(self.objective_scorecard),
            "fold_metrics": [dict(item) for item in self.fold_metrics],
            "stress_metrics": [dict(item) for item in self.stress_metrics],
            "cost_calibration": dict(self.cost_calibration),
            "null_comparator": dict(self.null_comparator),
            "promotion_readiness": dict(self.promotion_readiness),
        }


def evidence_bundle_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"ev-{_stable_hash(payload)[:24]}"


def evidence_bundle_from_frontier_candidate(
    *,
    candidate_spec_id: str,
    candidate: Mapping[str, Any],
    dataset_snapshot_id: str,
    result_path: str,
    code_commit: str = "unknown",
) -> CandidateEvidenceBundle:
    candidate_id = _string(candidate.get("candidate_id")) or candidate_spec_id
    scorecard = _mapping(candidate.get("objective_scorecard"))
    full_window = _mapping(candidate.get("full_window"))
    summary = _mapping(candidate.get("summary"))
    if not scorecard:
        scorecard = {
            "net_pnl_per_day": _string(full_window.get("net_per_day")),
            "active_day_ratio": _string(full_window.get("active_day_ratio")),
            "positive_day_ratio": _string(full_window.get("positive_day_ratio")),
            "best_day_share": _string(full_window.get("best_day_share")),
            "max_drawdown": _string(full_window.get("max_drawdown")),
        }
    for key in REPLAY_ACTIVITY_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in MARKET_IMPACT_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in (*DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS, *FILL_SURVIVAL_SCORECARD_KEYS):
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for source in (candidate, summary, full_window):
        for key, value in _order_type_execution_metrics(source).items():
            if key not in scorecard:
                scorecard = {**scorecard, key: value}
    for source in (candidate, summary, full_window):
        for key, value in _order_lifecycle_metrics(source).items():
            if key not in scorecard:
                scorecard = {**scorecard, key: value}
    for source in (candidate, summary, full_window):
        for key, value in _order_type_ablation_metrics(source).items():
            if key not in scorecard or key in {
                "order_type_ablation_artifact_ref",
                "order_type_ablation_sample_count",
                "order_type_ablation_passed",
                "order_type_ablation_selected_order_type",
                "order_type_opportunity_cost_bps",
                "order_type_opportunity_cost_evidence_present",
                "opportunity_cost_evidence_present",
                "limit_fill_probability_sample_count",
                "limit_fill_probability_evidence_present",
            }:
                scorecard = {**scorecard, key: value}
    if (
        scorecard.get("market_limit_order_mix_evidence_present")
        and "order_type_execution_artifact_ref" not in scorecard
    ):
        scorecard = {**scorecard, "order_type_execution_artifact_ref": result_path}
    if (
        scorecard.get("market_limit_order_mix_evidence_present")
        and "market_limit_order_mix_artifact_ref" not in scorecard
    ):
        scorecard = {**scorecard, "market_limit_order_mix_artifact_ref": result_path}
    for key, value in _decomposition_activity_counts(candidate).items():
        if key not in scorecard:
            scorecard = {**scorecard, key: value}
    daily_net = _mapping(full_window.get("daily_net"))
    if daily_net and "daily_net" not in scorecard:
        scorecard = {**scorecard, "daily_net": daily_net}
    daily_filled_notional = _mapping(full_window.get("daily_filled_notional"))
    if daily_filled_notional and "daily_filled_notional" not in scorecard:
        scorecard = {**scorecard, "daily_filled_notional": daily_filled_notional}
    if "trading_day_count" in full_window and "trading_day_count" not in scorecard:
        scorecard = {**scorecard, "trading_day_count": full_window["trading_day_count"]}
    raw_candidate_hard_vetoes = candidate.get("hard_vetoes")
    if isinstance(raw_candidate_hard_vetoes, str):
        raw_hard_vetoes: Sequence[Any] = (raw_candidate_hard_vetoes,)
    else:
        raw_hard_vetoes = cast(Sequence[Any], raw_candidate_hard_vetoes or ())
    hard_vetoes = tuple(
        item for item in (_string(value) for value in raw_hard_vetoes) if item
    )
    if hard_vetoes and "hard_vetoes" not in scorecard:
        scorecard = {**scorecard, "hard_vetoes": list(hard_vetoes)}
    replay_params = _frontier_replay_params(candidate)
    if replay_params and "runtime_params" not in scorecard:
        scorecard = {**scorecard, "runtime_params": replay_params}
    strategy_overrides = _frontier_strategy_overrides(candidate)
    if strategy_overrides and "candidate_strategy_overrides" not in scorecard:
        scorecard = {**scorecard, "candidate_strategy_overrides": strategy_overrides}
    universe_symbols = _string_list(strategy_overrides.get("universe_symbols"))
    if universe_symbols and "universe_symbols" not in scorecard:
        scorecard = {**scorecard, "universe_symbols": universe_symbols}
    for key in ("max_notional_per_trade", "max_position_pct_equity"):
        if key in scorecard:
            continue
        value = strategy_overrides.get(key)
        if value is not None:
            scorecard = {**scorecard, key: value}
    if "symbol_contribution_shares" not in scorecard and "symbol" not in scorecard:
        symbol_shares = _decomposition_symbol_contribution_shares(candidate)
        if symbol_shares:
            scorecard = {**scorecard, "symbol_contribution_shares": symbol_shares}
    runtime_identity_fallbacks = {
        "runtime_family": _string(candidate.get("family")),
        "runtime_strategy_name": _string(candidate.get("strategy_name")),
    }
    for key in (
        "family_template_id",
        "runtime_family",
        "runtime_strategy_name",
        "execution_signature",
        "execution_profile_id",
        "execution_profile_index",
        "feedback_risk_profile_key",
        "feedback_shape_key",
        "universe_key",
        "signal_key",
    ):
        value = _string(candidate.get(key)) or runtime_identity_fallbacks.get(key, "")
        if value and key not in scorecard:
            scorecard = {**scorecard, key: value}
    replay_lineage = _mapping(candidate.get("replay_lineage"))
    if replay_lineage and "replay_lineage" not in scorecard:
        scorecard = {**scorecard, "replay_lineage": replay_lineage}
    replay_window_coverage = _mapping(
        scorecard.get("replay_window_coverage")
        or candidate.get("replay_window_coverage")
        or replay_lineage.get("replay_window_coverage")
    )
    if replay_window_coverage and "replay_window_coverage" not in scorecard:
        scorecard = {**scorecard, "replay_window_coverage": replay_window_coverage}
    scorecard = _enrich_scorecard_with_replay_stress_metrics(
        scorecard=scorecard,
        full_window=full_window,
        result_path=result_path,
    )
    scorecard = _scorecard_with_freshness_lineage(
        scorecard=scorecard,
        candidate=candidate,
    )
    stress_metrics = tuple(
        cast(Sequence[Mapping[str, Any]], candidate.get("stress_metrics") or ())
    )
    if not stress_metrics:
        stress_metrics = (
            {
                "source": "frontier_replay",
                "stress_type": "market_impact",
                "model": scorecard.get("market_impact_stress_model"),
                "cost_bps": scorecard.get("market_impact_stress_cost_bps"),
                "net_pnl_per_day": scorecard.get(
                    "market_impact_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("market_impact_stress_passed"),
                "artifact_ref": scorecard.get("market_impact_stress_artifact_ref"),
            },
            {
                "source": "frontier_replay",
                "stress_type": "delay_adjusted_depth",
                "model": scorecard.get("delay_adjusted_depth_stress_model"),
                "stress_ms": scorecard.get("delay_adjusted_depth_stress_ms"),
                "latency_grid_ms": scorecard.get(
                    "delay_adjusted_depth_latency_grid_ms"
                ),
                "grid_max_stress_ms": scorecard.get(
                    "delay_adjusted_depth_grid_max_stress_ms"
                ),
                "fillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_fillable_notional_per_day"
                ),
                "worst_grid_fillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
                ),
                "worst_active_day_fillable_notional": scorecard.get(
                    "delay_adjusted_depth_worst_active_day_fillable_notional"
                ),
                "p10_active_day_fillable_notional": scorecard.get(
                    "delay_adjusted_depth_p10_active_day_fillable_notional"
                ),
                "tail_coverage_passed": scorecard.get(
                    "delay_adjusted_depth_tail_coverage_passed"
                ),
                "liquidity_missing_day_count": scorecard.get(
                    "delay_adjusted_depth_liquidity_missing_day_count"
                ),
                "fillable_ratio": scorecard.get("delay_adjusted_depth_fillable_ratio"),
                "survival_adjusted_fillable_ratio": scorecard.get(
                    "delay_adjusted_depth_survival_adjusted_fillable_ratio"
                ),
                "unfillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_unfillable_notional_per_day"
                ),
                "fill_survival_evidence_present": scorecard.get(
                    "delay_adjusted_depth_fill_survival_evidence_present"
                ),
                "fill_survival_sample_count": scorecard.get(
                    "delay_adjusted_depth_fill_survival_sample_count"
                ),
                "fill_survival_rate": scorecard.get(
                    "delay_adjusted_depth_fill_survival_rate"
                ),
                "queue_ratio_p95": scorecard.get(
                    "delay_adjusted_depth_queue_ratio_p95"
                ),
                "queue_ahead_depletion_evidence_present": scorecard.get(
                    "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
                ),
                "queue_ahead_depletion_sample_count": scorecard.get(
                    "delay_adjusted_depth_queue_ahead_depletion_sample_count"
                ),
                "net_pnl_per_day": scorecard.get(
                    "delay_adjusted_depth_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("delay_adjusted_depth_stress_passed"),
                "artifact_ref": scorecard.get(
                    "delay_adjusted_depth_stress_artifact_ref"
                ),
            },
            {
                "source": "frontier_replay",
                "stress_type": "implementation_uncertainty",
                "model": scorecard.get("implementation_uncertainty_model"),
                "model_count": scorecard.get("implementation_uncertainty_model_count"),
                "lower_net_pnl_per_day": scorecard.get(
                    "implementation_uncertainty_lower_net_pnl_per_day"
                ),
                "upper_net_pnl_per_day": scorecard.get(
                    "implementation_uncertainty_upper_net_pnl_per_day"
                ),
                "interval_width_per_day": scorecard.get(
                    "implementation_uncertainty_interval_width_per_day"
                ),
                "scenarios": scorecard.get("implementation_uncertainty_scenarios"),
                "passed": scorecard.get("implementation_uncertainty_stability_passed"),
            },
        )
    payload_seed = {
        "candidate_id": candidate_id,
        "candidate_spec_id": candidate_spec_id,
        "dataset_snapshot_id": dataset_snapshot_id,
        "objective_scorecard": scorecard,
    }
    promotion_readiness = _mapping(candidate.get("promotion_readiness")) or {
        "stage": "research_candidate",
        "status": "blocked_pending_runtime_parity",
        "promotable": False,
        "blockers": ["scheduler_v3_parity_missing", "shadow_validation_missing"],
    }
    replay_artifact_refs = tuple(
        dict.fromkeys(
            [
                result_path,
                *_artifact_refs_from_scorecard(scorecard),
            ]
        )
    )
    return CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id=evidence_bundle_id_for_payload(payload_seed),
        candidate_id=candidate_id,
        candidate_spec_id=candidate_spec_id,
        dataset_snapshot_id=dataset_snapshot_id,
        feature_spec_hash=_stable_hash(
            {"candidate_spec_id": candidate_spec_id, "scorecard": scorecard}
        ),
        code_commit=code_commit,
        replay_artifact_refs=replay_artifact_refs,
        objective_scorecard=scorecard,
        fold_metrics=tuple(
            cast(Sequence[Mapping[str, Any]], candidate.get("fold_metrics") or ())
        ),
        stress_metrics=stress_metrics,
        cost_calibration=_mapping(candidate.get("cost_calibration"))
        or {"status": "provisional", "source": "frontier_replay"},
        null_comparator=_mapping(candidate.get("null_comparator"))
        or {
            "baseline_outperformed": bool(
                float(str(scorecard.get("net_pnl_per_day") or 0)) > 0
            )
        },
        promotion_readiness=promotion_readiness,
    )


def evidence_bundle_from_payload(payload: Mapping[str, Any]) -> CandidateEvidenceBundle:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != EVIDENCE_BUNDLE_SCHEMA_VERSION:
        raise ValueError(f"evidence_bundle_schema_invalid:{schema_version}")
    return CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id=_string(payload.get("evidence_bundle_id")),
        candidate_id=_string(payload.get("candidate_id")),
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        dataset_snapshot_id=_string(payload.get("dataset_snapshot_id")),
        feature_spec_hash=_string(payload.get("feature_spec_hash")),
        code_commit=_string(payload.get("code_commit")),
        replay_artifact_refs=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("replay_artifact_refs") or [])
        ),
        objective_scorecard=_mapping(payload.get("objective_scorecard")),
        fold_metrics=tuple(
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[Any], payload.get("fold_metrics") or [])
            if isinstance(item, Mapping)
        ),
        stress_metrics=tuple(
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[Any], payload.get("stress_metrics") or [])
            if isinstance(item, Mapping)
        ),
        cost_calibration=_mapping(payload.get("cost_calibration")),
        null_comparator=_mapping(payload.get("null_comparator")),
        promotion_readiness=_mapping(payload.get("promotion_readiness")),
    )


def _requires_promotion_proof(bundle: CandidateEvidenceBundle) -> bool:
    readiness = bundle.promotion_readiness
    if _bool(readiness.get("promotable")):
        return True
    stage = _string(readiness.get("stage")).lower()
    status = _string(readiness.get("status")).lower()
    if stage and stage not in {"research_candidate", "research"}:
        return True
    return status in {
        "promotion_ready",
        "ready_for_promotion",
        "paper_probation",
        "paper_canary",
        "live_canary",
    }


def _delay_depth_survival_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _bool(scorecard.get("delay_adjusted_depth_stress_passed")):
        blockers.append("delay_adjusted_depth_stress_failed")
    if not _string(scorecard.get("delay_adjusted_depth_stress_model")):
        blockers.append("delay_adjusted_depth_stress_model_missing")
    if _decimal(scorecard.get("delay_adjusted_depth_stress_ms")) <= 0:
        blockers.append("delay_adjusted_depth_stress_ms_missing")
    if not _string(scorecard.get("delay_adjusted_depth_stress_artifact_ref")):
        blockers.append("delay_adjusted_depth_stress_artifact_missing")
    if not _bool(scorecard.get("delay_adjusted_depth_tail_coverage_passed")):
        blockers.append("delay_adjusted_depth_tail_coverage_missing")
    if (
        _decimal(scorecard.get("delay_adjusted_depth_p10_active_day_fillable_notional"))
        <= 0
    ):
        blockers.append("delay_adjusted_depth_p10_fillable_non_positive")
    if (
        _decimal(
            scorecard.get("delay_adjusted_depth_worst_active_day_fillable_notional")
        )
        <= 0
    ):
        blockers.append("delay_adjusted_depth_worst_fillable_non_positive")
    if _decimal(scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")) <= 0:
        blockers.append("delay_adjusted_depth_stress_net_pnl_non_positive")
    if not (
        _bool(scorecard.get("fill_survival_evidence_present"))
        or _bool(scorecard.get("delay_adjusted_depth_fill_survival_evidence_present"))
    ):
        blockers.append("fill_survival_evidence_missing")
    if (
        max(
            _int(scorecard.get("fill_survival_sample_count")),
            _int(scorecard.get("delay_adjusted_depth_fill_survival_sample_count")),
        )
        <= 0
    ):
        blockers.append("fill_survival_sample_count_zero")
    if not (
        _bool(scorecard.get("queue_ahead_depletion_evidence_present"))
        or _bool(
            scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        )
        or _bool(
            scorecard.get(
                "queue_position_survival_queue_ahead_depletion_evidence_present"
            )
        )
    ):
        blockers.append("queue_ahead_depletion_evidence_missing")
    if (
        max(
            _int(scorecard.get("queue_ahead_depletion_sample_count")),
            _int(
                scorecard.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
            ),
            _int(
                scorecard.get(
                    "queue_position_survival_queue_ahead_depletion_sample_count"
                )
            ),
        )
        <= 0
    ):
        blockers.append("queue_ahead_depletion_sample_count_zero")
    return blockers


def _has_artifact_ref(scorecard: Mapping[str, Any], *keys: str) -> bool:
    for key in keys:
        raw_value = scorecard.get(key)
        if isinstance(raw_value, Sequence) and not isinstance(
            raw_value, (str, bytes, bytearray)
        ):
            if any(_string(item) for item in cast(Sequence[Any], raw_value)):
                return True
            continue
        if _string(raw_value):
            return True
    return False


def _market_impact_stress_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    market_impact_passed = _bool(
        scorecard.get("nonlinear_market_impact_stress_passed")
    ) or _bool(scorecard.get("market_impact_stress_passed"))
    if not market_impact_passed:
        blockers.append("market_impact_stress_failed")
    if not _has_artifact_ref(
        scorecard,
        "market_impact_stress_artifact_ref",
        "market_impact_stress_artifact_refs",
        "nonlinear_market_impact_stress_artifact_ref",
        "nonlinear_market_impact_stress_artifact_refs",
    ):
        blockers.append("market_impact_stress_artifact_missing")
    if not _string(
        scorecard.get("nonlinear_market_impact_stress_model")
        or scorecard.get("market_impact_stress_model")
        or scorecard.get("market_impact_cost_model")
    ):
        blockers.append("market_impact_stress_model_missing")
    if (
        _decimal(
            scorecard.get("nonlinear_market_impact_stress_cost_bps")
            or scorecard.get("market_impact_stress_cost_bps")
            or scorecard.get("market_impact_cost_bps")
        )
        < MARKET_IMPACT_STRESS_COST_BPS
    ):
        blockers.append("market_impact_stress_cost_bps_below_min")
    if (
        _decimal(
            scorecard.get("nonlinear_market_impact_stress_net_pnl_per_day")
            or scorecard.get("market_impact_stress_net_pnl_per_day")
        )
        <= 0
    ):
        blockers.append("market_impact_stress_net_pnl_non_positive")
    if not _bool(scorecard.get("market_impact_liquidity_evidence_present")):
        blockers.append("market_impact_liquidity_evidence_missing")
    return blockers


def _implementation_uncertainty_blockers(
    scorecard: Mapping[str, Any],
) -> list[str]:
    requires_implementation_uncertainty = _bool(
        scorecard.get("implementation_uncertainty_required")
    ) or _bool(scorecard.get("requires_implementation_uncertainty_stability"))
    if not requires_implementation_uncertainty:
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("implementation_uncertainty_stability_passed")):
        blockers.append("implementation_uncertainty_stability_failed")
    if _int(scorecard.get("implementation_uncertainty_model_count")) < 2:
        blockers.append("implementation_uncertainty_model_count_below_min")
    if _decimal(scorecard.get("implementation_uncertainty_lower_net_pnl_per_day")) <= 0:
        blockers.append("implementation_uncertainty_lower_net_pnl_non_positive")
    return blockers


def _conformal_tail_risk_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    requires_conformal_tail_risk = _bool(
        scorecard.get("conformal_tail_risk_required")
    ) or _bool(scorecard.get("requires_conformal_tail_risk"))
    if not requires_conformal_tail_risk:
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("conformal_tail_risk_passed")):
        blockers.append("conformal_tail_risk_failed")
    if _int(scorecard.get("conformal_tail_risk_sample_count")) <= 0:
        blockers.append("conformal_tail_risk_sample_count_zero")
    if _decimal(scorecard.get("conformal_tail_risk_adjusted_net_pnl_per_day")) <= 0:
        blockers.append("conformal_tail_risk_adjusted_net_pnl_non_positive")
    return blockers


def evidence_bundle_blockers(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    blockers: list[str] = []
    if not _string(bundle.dataset_snapshot_id):
        blockers.append("dataset_snapshot_missing")
    if not bundle.replay_artifact_refs or not any(
        _string(item) for item in bundle.replay_artifact_refs
    ):
        blockers.append("replay_artifact_missing")

    cost_status = _string(bundle.cost_calibration.get("status")).lower()
    cost_source = _string(bundle.cost_calibration.get("source"))
    if not bundle.cost_calibration:
        blockers.append("cost_calibration_missing")
    elif cost_status not in VALID_COST_CALIBRATION_STATUSES:
        blockers.append("cost_calibration_status_invalid")
    elif not cost_source:
        blockers.append("cost_calibration_source_missing")

    scorecard = bundle.objective_scorecard
    if bool(scorecard.get("stale_tape")) or bool(scorecard.get("stale_override_used")):
        blockers.append("stale_tape")
    freshness = _string(
        scorecard.get("dataset_freshness_status")
        or scorecard.get("tape_freshness_status")
        or scorecard.get("freshness_status")
    ).lower()
    if freshness in {"stale", "expired", "not_fresh"}:
        blockers.append("stale_tape")
    replay_tape = _mapping(scorecard.get("replay_tape"))
    replay_status = _string(
        replay_tape.get("status") or replay_tape.get("validation_status")
    ).lower()
    if _bool(replay_tape.get("stale_override_used")) or replay_status in {
        "stale_override",
        "stale",
    }:
        blockers.append("stale_tape")
    dataset_receipt = _mapping(scorecard.get("dataset_snapshot_receipt"))
    if _bool(dataset_receipt.get("stale_override_used")):
        blockers.append("stale_tape")
    receipt_is_fresh = dataset_receipt.get("is_fresh")
    if receipt_is_fresh is not None and not _bool(receipt_is_fresh):
        blockers.append("stale_tape")
    validation_contract = _mapping(
        scorecard.get("validation_contract")
        or bundle.promotion_readiness.get("validation_contract")
    )
    if _string(
        validation_contract.get("synthetic_evidence_policy")
    ) == "validation_only_not_promotion_proof" and _is_synthetic_dataset_snapshot(
        bundle.dataset_snapshot_id
    ):
        blockers.append("synthetic_evidence_not_promotion_proof")
    if _requires_promotion_proof(bundle):
        blockers.extend(
            _runtime_ledger_lineage_handoff_blockers(
                scorecard=scorecard,
                promotion_readiness=bundle.promotion_readiness,
            )
        )
        blockers.extend(_market_impact_stress_blockers(scorecard))
        blockers.extend(_implementation_uncertainty_blockers(scorecard))
        blockers.extend(_conformal_tail_risk_blockers(scorecard))
        blockers.extend(_delay_depth_survival_blockers(scorecard))
    return tuple(dict.fromkeys(blockers))


def evidence_bundle_is_valid(bundle: CandidateEvidenceBundle) -> bool:
    return not evidence_bundle_blockers(bundle)
