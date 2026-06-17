# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast

# ruff: noqa: F401,F811,F821

from .shared_context import (
    ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS,
    ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS,
    BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS,
    CONFORMAL_COST_BUFFER_SCORECARD_KEYS,
    DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS,
    DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS,
    DELAY_ADJUSTED_DEPTH_STRESS_MS,
    DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS,
    EVIDENCE_BUNDLE_SCHEMA_VERSION,
    FILL_SURVIVAL_SCORECARD_KEYS,
    MARKET_IMPACT_SCORECARD_KEYS,
    MARKET_IMPACT_STRESS_COST_BPS,
    MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT,
    OFI_RESPONSE_HORIZON_SCORECARD_KEYS,
    REPLAY_ACTIVITY_SCORECARD_KEYS,
    RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS,
    STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS,
    VALID_COST_CALIBRATION_STATUSES,
    artifact_refs_from_scorecard as _artifact_refs_from_scorecard,
    bool_value as _bool,
    decimal as _decimal,
    decimal_mapping_total as _decimal_mapping_total,
    frontier_replay_config as _frontier_replay_config,
    frontier_replay_params as _frontier_replay_params,
    frontier_strategy_overrides as _frontier_strategy_overrides,
    int_value as _int,
    int_mapping as _int_mapping,
    mapping as _mapping,
    order_lifecycle_metrics as _order_lifecycle_metrics,
    order_type_ablation_metrics as _order_type_ablation_metrics,
    order_type_execution_metrics as _order_type_execution_metrics,
    runtime_ledger_lineage_handoff as _runtime_ledger_lineage_handoff,
    stable_hash as _stable_hash,
    string as _string,
    string_list as _string_list,
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


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
decomposition_activity_counts = _decomposition_activity_counts
decomposition_symbol_contribution_shares = _decomposition_symbol_contribution_shares
delay_depth_fillability = _delay_depth_fillability
enrich_scorecard_with_replay_stress_metrics = (
    _enrich_scorecard_with_replay_stress_metrics
)
freshness_status_from_validation_status = _freshness_status_from_validation_status
is_synthetic_dataset_snapshot = _is_synthetic_dataset_snapshot
p10 = _p10
runtime_ledger_lineage_handoff_blockers = _runtime_ledger_lineage_handoff_blockers
scorecard_with_freshness_lineage = _scorecard_with_freshness_lineage
sum_mapping_int_values = _sum_mapping_int_values
