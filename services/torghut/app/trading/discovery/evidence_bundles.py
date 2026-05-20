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
    ):
        ref = _string(scorecard.get(key))
        if ref:
            refs.append(ref)
    for key in (
        "route_tca_artifact_refs",
        "order_type_execution_artifact_refs",
        "market_limit_order_mix_artifact_refs",
        "order_type_ablation_artifact_refs",
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

    market_impact_cost_per_day = (
        avg_filled_notional_per_day * MARKET_IMPACT_STRESS_COST_BPS / Decimal("10000")
    )
    market_impact_net_pnl_per_day = net_pnl_per_day - market_impact_cost_per_day
    if "market_impact_stress_model" not in enriched:
        enriched["market_impact_stress_model"] = "square_root"
    if "market_impact_stress_cost_bps" not in enriched:
        enriched["market_impact_stress_cost_bps"] = str(MARKET_IMPACT_STRESS_COST_BPS)
    if "market_impact_stress_net_pnl_per_day" not in enriched:
        enriched["market_impact_stress_net_pnl_per_day"] = str(
            market_impact_net_pnl_per_day
        )
    if "market_impact_stress_artifact_ref" not in enriched:
        enriched["market_impact_stress_artifact_ref"] = result_path
    if "market_impact_stress_passed" not in enriched:
        enriched["market_impact_stress_passed"] = (
            bool(enriched.get("market_impact_liquidity_evidence_present"))
            and avg_filled_notional_per_day > 0
            and market_impact_net_pnl_per_day > 0
        )

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
    delay_depth_net_pnl_per_day = (
        net_pnl_per_day * delay_depth_fillable_ratio
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
            bool(enriched.get("delay_adjusted_depth_liquidity_evidence_present"))
            and bool(enriched.get("delay_adjusted_depth_tail_coverage_passed"))
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
    for source in (candidate, summary, full_window):
        for key, value in _order_type_execution_metrics(source).items():
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
    if "symbol_contribution_shares" not in scorecard and "symbol" not in scorecard:
        symbol_shares = _decomposition_symbol_contribution_shares(candidate)
        if symbol_shares:
            scorecard = {**scorecard, "symbol_contribution_shares": symbol_shares}
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
        value = _string(candidate.get(key))
        if value and key not in scorecard:
            scorecard = {**scorecard, key: value}
    scorecard = _enrich_scorecard_with_replay_stress_metrics(
        scorecard=scorecard,
        full_window=full_window,
        result_path=result_path,
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
                "fillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_fillable_notional_per_day"
                ),
                "net_pnl_per_day": scorecard.get(
                    "delay_adjusted_depth_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("delay_adjusted_depth_stress_passed"),
                "artifact_ref": scorecard.get(
                    "delay_adjusted_depth_stress_artifact_ref"
                ),
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
    return tuple(dict.fromkeys(blockers))


def evidence_bundle_is_valid(bundle: CandidateEvidenceBundle) -> bool:
    return not evidence_bundle_blockers(bundle)
