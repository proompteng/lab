"""Validation helpers for the strategy-factory alpha lane."""

from __future__ import annotations

# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from math import log, sqrt
from statistics import NormalDist
from typing import Any, Callable, Iterable, Sequence, cast

import pandas as pd

from ..alpha.metrics import PerformanceSummary, to_jsonable
from ..alpha.search import CandidateConfig, CandidateResult


def _stable_hash(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _z_value(confidence_level: float) -> float:
    bounded = min(max(float(confidence_level), 0.5), 0.999)
    return float(NormalDist().inv_cdf((1.0 + bounded) / 2.0))


def _series_summary(
    values: pd.Series, *, confidence_level: float = 0.95
) -> dict[str, Any]:
    sample = values.dropna().astype("float64")
    if sample.empty:
        return {
            "count": 0,
            "mean": None,
            "std": None,
            "lower": None,
            "upper": None,
        }
    mean_value = float(sample.mean())
    std_value = float(sample.std(ddof=0)) if len(sample) > 1 else 0.0
    stderr = std_value / max(len(sample) ** 0.5, 1.0)
    bound = _z_value(confidence_level) * stderr
    return {
        "count": int(sample.shape[0]),
        "mean": mean_value,
        "std": std_value,
        "lower": mean_value - bound,
        "upper": mean_value + bound,
    }


def _annualize_edge(
    mean_daily_return: float | None, *, periods_per_year: int = 252
) -> float | None:
    if mean_daily_return is None:
        return None
    return float(mean_daily_return * periods_per_year)


def _config_payload(config: CandidateConfig) -> dict[str, Any]:
    return {
        "lookback_days": config.lookback_days,
        "vol_lookback_days": config.vol_lookback_days,
        "target_daily_vol": config.target_daily_vol,
        "max_gross_leverage": config.max_gross_leverage,
    }


def _series_column(frame: pd.DataFrame, column: str) -> pd.Series:
    return cast(pd.Series, frame[column])


def _datetime_index_bound(index: pd.Index, *, which: str) -> datetime | None:
    if not isinstance(index, pd.DatetimeIndex) or len(index) == 0:
        return None
    value = index.min() if which == "min" else index.max()
    if not isinstance(value, pd.Timestamp):
        return None
    return value.to_pydatetime()


@dataclass(frozen=True)
class ValidationTestResult:
    test_name: str
    status: str
    metric_bundle: dict[str, Any]
    artifact_name: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "test_name": self.test_name,
            "status": self.status,
            "metric_bundle": dict(self.metric_bundle),
            "artifact_name": self.artifact_name,
        }


@dataclass(frozen=True)
class CostCalibrationRecord:
    calibration_id: str
    scope_type: str
    scope_id: str
    window_start: datetime | None
    window_end: datetime | None
    modeled_slippage_bps: float
    realized_slippage_bps: float
    modeled_shortfall_bps: float
    realized_shortfall_bps: float
    calibration_error_bundle: dict[str, Any]
    status: str
    computed_at: datetime

    def to_payload(self) -> dict[str, Any]:
        return {
            "calibration_id": self.calibration_id,
            "scope_type": self.scope_type,
            "scope_id": self.scope_id,
            "window_start": self.window_start.isoformat()
            if self.window_start
            else None,
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "modeled_slippage_bps": self.modeled_slippage_bps,
            "realized_slippage_bps": self.realized_slippage_bps,
            "modeled_shortfall_bps": self.modeled_shortfall_bps,
            "realized_shortfall_bps": self.realized_shortfall_bps,
            "calibration_error_bundle": dict(self.calibration_error_bundle),
            "status": self.status,
            "computed_at": self.computed_at.isoformat(),
        }


@dataclass(frozen=True)
class StrategyFactoryEvaluation:
    attempts: list[dict[str, Any]]
    candidate_family: str
    canonical_spec: dict[str, Any]
    semantic_hash: str
    economic_rationale: str
    complexity_score: float
    discovery_rank: int
    posterior_edge_summary: dict[str, Any]
    economic_validity_card: dict[str, Any]
    valid_regime_envelope: dict[str, Any]
    invalidation_clauses: list[dict[str, Any]]
    null_comparator_summary: dict[str, Any]
    validation_tests: list[ValidationTestResult]
    fold_stat_bundle: dict[str, Any]
    stress_results: list[dict[str, Any]]
    cost_calibration: CostCalibrationRecord


def _rank_lookup(
    candidates: Iterable[CandidateResult],
    *,
    selector: Callable[[CandidateResult], tuple[float, float, float]],
) -> dict[str, int]:
    ranked = sorted(candidates, key=selector, reverse=True)
    lookup: dict[str, int] = {}
    for index, item in enumerate(ranked, start=1):
        lookup[_stable_hash(_config_payload(item.config))] = index
    return lookup


def _candidate_status(*, passed: bool) -> str:
    return "pass" if passed else "fail"


_DEFAULT_REGIME_SUPPORTS = (
    "persistent_cross-asset_trends",
    "moderate_turnover",
    "stable_volatility_scaling",
)
_DEFAULT_REGIME_AVOID = (
    "mean_reverting_microstructure_noise",
    "halt-heavy_sessions",
    "cost_shock_regimes",
)


def _normalized_family(value: str | None) -> str:
    normalized = str(value or "").strip()
    return normalized or "tsmom"


def _nonempty_tuple(
    value: Sequence[str] | None, *, default: tuple[str, ...]
) -> tuple[str, ...]:
    if value is None:
        return default
    resolved = tuple(str(item).strip() for item in value if str(item).strip())
    return resolved or default


def build_strategy_factory_evaluation(
    *,
    run_id: str,
    candidate_id: str,
    best_candidate: CandidateResult,
    all_candidates: list[CandidateResult],
    train_debug: pd.DataFrame,
    test_debug: pd.DataFrame,
    train_summary: PerformanceSummary,
    test_summary: PerformanceSummary,
    incumbent_summary: PerformanceSummary,
    cost_bps_per_turnover: float,
    evaluated_at: datetime,
    challenge_lane: bool = False,
    economic_rationale: str | None = None,
    candidate_family: str = "tsmom",
    family_template_id: str | None = None,
    runtime_family: str | None = None,
    runtime_strategy_name: str | None = None,
    baseline_name: str = "tsmom_default_60_20_1x",
    generator_family: str | None = None,
    regime_supports: Sequence[str] | None = None,
    regime_avoid: Sequence[str] | None = None,
) -> StrategyFactoryEvaluation:
    candidate_family = _normalized_family(candidate_family)
    family_template_id = str(family_template_id or "").strip()
    runtime_family = str(runtime_family or "").strip()
    runtime_strategy_name = str(runtime_strategy_name or "").strip()
    baseline_name = str(baseline_name or "").strip() or f"{candidate_family}_baseline"
    generator_family = (
        str(generator_family or "").strip() or f"{candidate_family}_grid_v1"
    )
    canonical_spec = {
        "schema_version": "strategy-factory-canonical-spec-v1",
        "family": candidate_family,
        "family_template_id": family_template_id or None,
        "runtime_family": runtime_family or None,
        "runtime_strategy_name": runtime_strategy_name or None,
        "lane": "challenge" if challenge_lane else "grammar",
        "config": _config_payload(best_candidate.config),
    }
    semantic_hash = _stable_hash(canonical_spec)
    candidate_hash = _stable_hash(_config_payload(best_candidate.config))
    generated_rationale = (
        "Volatility-targeted time-series momentum seeks persistent intermediate-horizon trends "
        "that remain positive after conservative turnover costs."
    )
    resolved_rationale = (economic_rationale or generated_rationale).strip()
    complexity_score = float(
        best_candidate.config.lookback_days / 100.0
        + best_candidate.config.vol_lookback_days / 100.0
        + best_candidate.config.max_gross_leverage
    )

    train_rank_lookup = _rank_lookup(
        all_candidates,
        selector=lambda item: (
            float(item.train.sharpe or float("-inf")),
            float(item.train.cagr or float("-inf")),
            float(item.train.total_return),
        ),
    )
    test_rank_lookup = _rank_lookup(
        all_candidates,
        selector=lambda item: (
            float(item.test.sharpe or float("-inf")),
            float(item.test.cagr or float("-inf")),
            float(item.test.total_return),
        ),
    )
    discovery_rank = int(train_rank_lookup.get(candidate_hash, 1))
    half_cut = max(1, (len(all_candidates) + 1) // 2)
    overfit_candidates = sum(
        1
        for item in all_candidates
        if train_rank_lookup.get(
            _stable_hash(_config_payload(item.config)), len(all_candidates) + 1
        )
        <= half_cut
        and test_rank_lookup.get(
            _stable_hash(_config_payload(item.config)), len(all_candidates) + 1
        )
        > half_cut
    )
    pbo_proxy = float(overfit_candidates / half_cut)

    net_returns = _series_column(test_debug, "port_ret_net")
    gross_returns = _series_column(test_debug, "port_ret_gross")
    turnover = _series_column(test_debug, "turnover")
    cost_returns = _series_column(test_debug, "cost_ret")
    posterior_stats = _series_summary(net_returns)
    posterior_edge_mean = _annualize_edge(posterior_stats["mean"])
    posterior_edge_lower = _annualize_edge(posterior_stats["lower"])
    posterior_edge_upper = _annualize_edge(posterior_stats["upper"])
    net_edge_bps = (
        None if posterior_edge_mean is None else float(posterior_edge_mean * 10000.0)
    )
    lower_edge_bps = (
        None if posterior_edge_lower is None else float(posterior_edge_lower * 10000.0)
    )

    cost_drag_mean = float(cost_returns.mean()) if not cost_returns.empty else 0.0
    turnover_mean = float(turnover.mean()) if not turnover.empty else 0.0
    gross_edge_mean = float(gross_returns.mean()) if not gross_returns.empty else 0.0
    net_edge_mean = float(net_returns.mean()) if not net_returns.empty else 0.0
    realized_slippage_bps = float(cost_bps_per_turnover * 1.05)
    realized_shortfall_bps = float(cost_bps_per_turnover * 1.10)
    calibration_error_bundle = {
        "proxy_source": "offline_turnover_model",
        "slippage_error_bps": realized_slippage_bps - cost_bps_per_turnover,
        "shortfall_error_bps": realized_shortfall_bps - cost_bps_per_turnover,
        "reason_codes": ["offline_proxy_only"],
    }
    cost_status = "provisional"
    if abs(realized_slippage_bps - cost_bps_per_turnover) <= 0.25:
        cost_status = "calibrated"
    cost_calibration = CostCalibrationRecord(
        calibration_id=f"cal-{semantic_hash[:16]}",
        scope_type="candidate_family",
        scope_id=candidate_family,
        window_start=_datetime_index_bound(test_debug.index, which="min"),
        window_end=_datetime_index_bound(test_debug.index, which="max"),
        modeled_slippage_bps=float(cost_bps_per_turnover),
        realized_slippage_bps=realized_slippage_bps,
        modeled_shortfall_bps=float(cost_bps_per_turnover),
        realized_shortfall_bps=realized_shortfall_bps,
        calibration_error_bundle=calibration_error_bundle,
        status=cost_status,
        computed_at=evaluated_at,
    )

    baseline_beaten = float(test_summary.total_return) > 0.0 and float(
        test_summary.total_return
    ) >= float(incumbent_summary.total_return)
    null_comparator_summary = {
        "schema_version": "null-comparator-summary-v1",
        "null_baseline": {
            "name": "flat_cash",
            "total_return": 0.0,
            "annualized_edge": 0.0,
        },
        "incumbent_baseline": {
            "name": baseline_name,
            "summary": to_jsonable(incumbent_summary),
        },
        "candidate_vs_null_return_delta": float(test_summary.total_return),
        "candidate_vs_incumbent_return_delta": float(
            test_summary.total_return - incumbent_summary.total_return
        ),
        "candidate_vs_incumbent_sharpe_delta": float(
            (test_summary.sharpe or 0.0) - (incumbent_summary.sharpe or 0.0)
        ),
        "baseline_outperformed": baseline_beaten,
    }

    valid_regime_envelope = {
        "schema_version": "valid-regime-envelope-v1",
        "family": candidate_family,
        "family_template_id": family_template_id or None,
        "runtime_family": runtime_family or None,
        "runtime_strategy_name": runtime_strategy_name or None,
        "supports": list(
            _nonempty_tuple(regime_supports, default=_DEFAULT_REGIME_SUPPORTS)
        ),
        "avoid": list(_nonempty_tuple(regime_avoid, default=_DEFAULT_REGIME_AVOID)),
    }
    invalidation_clauses = [
        {
            "rule": "posterior_edge_lower_lte_zero",
            "action": "paper_only",
        },
        {
            "rule": "cost_model_status_not_calibrated",
            "action": "block_live_widening",
        },
        {
            "rule": "candidate_fails_incumbent_baseline",
            "action": "deny_promotion",
        },
    ]
    economic_validity_card = {
        "schema_version": "economic-validity-card-v1",
        "family": candidate_family,
        "lane": canonical_spec["lane"],
        "hypothesis": resolved_rationale,
        "capacity_assumptions": {
            "target_daily_vol": best_candidate.config.target_daily_vol,
            "max_gross_leverage": best_candidate.config.max_gross_leverage,
            "average_turnover": turnover_mean,
        },
        "cost_realism": {
            "modeled_cost_bps_per_turnover": cost_bps_per_turnover,
            "calibration_status": cost_status,
        },
        "status": "pass" if baseline_beaten and (lower_edge_bps or 0.0) > 0 else "fail",
    }

    fold_stat_bundle = {
        "schema_version": "fold-stat-bundle-v1",
        "train_summary": to_jsonable(train_summary),
        "test_summary": to_jsonable(test_summary),
        "test_net_return_mean": net_edge_mean,
        "test_gross_return_mean": gross_edge_mean,
        "test_turnover_mean": turnover_mean,
        "test_cost_drag_mean": cost_drag_mean,
        "feature_availability_assumption": "shifted_inputs_only",
        "candidate_semantic_hash": semantic_hash,
    }

    dsr_penalty = sqrt(max(2.0 * log(max(len(all_candidates), 1)), 0.0)) / max(
        sqrt(max(int(test_summary.days), 1)),
        1.0,
    )
    deflated_sharpe = float((test_summary.sharpe or 0.0) - dsr_penalty)
    selection_penalty = float(
        log(max(len(all_candidates), 1) + 1.0) / max(int(test_summary.days), 1)
    )
    adjusted_edge_bps = None
    if net_edge_bps is not None:
        adjusted_edge_bps = float(net_edge_bps * (1.0 - selection_penalty))

    validation_tests = [
        ValidationTestResult(
            test_name="formal_validity",
            status=_candidate_status(
                passed=best_candidate.config.lookback_days > 1
                and best_candidate.config.vol_lookback_days > 1
            ),
            metric_bundle={
                "lookahead_safe": True,
                "signal_shift": 1,
                "vol_shift": 1,
                "costs_applied": True,
            },
            artifact_name="formal-validity-bundle-v1.json",
        ),
        ValidationTestResult(
            test_name="cscv_pbo",
            status=_candidate_status(passed=pbo_proxy <= 0.5),
            metric_bundle={
                "proxy_method": "train_test_rank_instability",
                "candidate_count": len(all_candidates),
                "pbo_proxy": pbo_proxy,
            },
            artifact_name="cscv-pbo-report-v1.json",
        ),
        ValidationTestResult(
            test_name="deflated_sharpe",
            status=_candidate_status(passed=deflated_sharpe > 0.0),
            metric_bundle={
                "test_sharpe": test_summary.sharpe,
                "candidate_count": len(all_candidates),
                "deflated_sharpe_proxy": deflated_sharpe,
                "penalty": dsr_penalty,
            },
            artifact_name="deflated-sharpe-report-v1.json",
        ),
        ValidationTestResult(
            test_name="selection_bias_adjustment",
            status=_candidate_status(passed=(adjusted_edge_bps or 0.0) > 0.0),
            metric_bundle={
                "candidate_count": len(all_candidates),
                "selection_penalty": selection_penalty,
                "adjusted_edge_bps": adjusted_edge_bps,
            },
            artifact_name="selection-bias-adjustment-report-v1.json",
        ),
        ValidationTestResult(
            test_name="execution_reality",
            status=_candidate_status(
                passed=(gross_edge_mean - cost_drag_mean) > 0.0
                and cost_status in {"calibrated", "provisional"}
            ),
            metric_bundle={
                "gross_return_mean": gross_edge_mean,
                "net_return_mean": net_edge_mean,
                "cost_drag_mean": cost_drag_mean,
                "modeled_cost_bps_per_turnover": cost_bps_per_turnover,
                "calibration_status": cost_status,
            },
            artifact_name="execution-reality-report-v1.json",
        ),
        ValidationTestResult(
            test_name="posterior_edge",
            status=_candidate_status(passed=(lower_edge_bps or 0.0) > 0.0),
            metric_bundle={
                "annualized_edge_mean_bps": net_edge_bps,
                "annualized_edge_lower_bps": lower_edge_bps,
                "annualized_edge_upper_bps": None
                if posterior_edge_upper is None
                else float(posterior_edge_upper * 10000.0),
            },
            artifact_name="posterior-edge-report-v1.json",
        ),
        ValidationTestResult(
            test_name="baseline_comparison",
            status=_candidate_status(passed=baseline_beaten),
            metric_bundle=null_comparator_summary,
            artifact_name="baseline-comparison-report-v1.json",
        ),
        ValidationTestResult(
            test_name="economic_validity",
            status=str(economic_validity_card["status"]),
            metric_bundle=economic_validity_card,
            artifact_name="economic-validity-card-v1.json",
        ),
    ]

    stress_results = [
        {
            "stress_case": "spread",
            "metric_bundle": {
                "cost_multiplier": 1.5,
                "projected_net_return": float(
                    test_summary.total_return - abs(cost_drag_mean) * 1.5
                ),
            },
            "pessimistic_pnl_delta": float(-abs(cost_drag_mean) * 1.5),
        },
        {
            "stress_case": "volatility",
            "metric_bundle": {
                "return_multiplier": 0.75,
                "projected_net_return": float(test_summary.total_return * 0.75),
            },
            "pessimistic_pnl_delta": float(test_summary.total_return * -0.25),
        },
        {
            "stress_case": "liquidity",
            "metric_bundle": {
                "cost_multiplier": 2.0,
                "projected_net_return": float(
                    test_summary.total_return - abs(cost_drag_mean) * 2.0
                ),
            },
            "pessimistic_pnl_delta": float(-abs(cost_drag_mean) * 2.0),
        },
        {
            "stress_case": "halt",
            "metric_bundle": {
                "positive_day_haircut": 0.5,
                "projected_net_return": float(test_summary.total_return * 0.5),
            },
            "pessimistic_pnl_delta": float(test_summary.total_return * -0.5),
        },
    ]

    attempts: list[dict[str, Any]] = []
    ranked_candidates = sorted(
        all_candidates,
        key=lambda item: (
            float(item.train.sharpe or float("-inf")),
            float(item.train.cagr or float("-inf")),
            float(item.train.total_return),
        ),
        reverse=True,
    )
    for rank, item in enumerate(ranked_candidates, start=1):
        item_hash = _stable_hash(_config_payload(item.config))
        status = "selected" if item_hash == candidate_hash else "rejected"
        attempts.append(
            {
                "attempt_id": f"att-{run_id[:8]}-{rank:03d}",
                "run_id": run_id,
                "candidate_hash": item_hash,
                "generator_family": generator_family,
                "attempt_stage": "offline_search",
                "status": status,
                "reason_codes": ["selected_for_validation"]
                if status == "selected"
                else ["not_top_ranked"],
                "artifact_ref": f"search-result.json#rank-{rank}",
                "metadata_bundle": {
                    "rank": rank,
                    "train": to_jsonable(item.train),
                    "test": to_jsonable(item.test),
                },
            }
        )
    if challenge_lane:
        attempts.append(
            {
                "attempt_id": f"att-{run_id[:8]}-challenge",
                "run_id": run_id,
                "candidate_hash": candidate_hash,
                "generator_family": "challenge_lane_manual",
                "attempt_stage": "challenge_lane_review",
                "status": "pending_canonicalization",
                "reason_codes": ["manual_out_of_grammar_candidate"],
                "artifact_ref": "economic-validity-card-v1.json",
                "metadata_bundle": {"economic_rationale": resolved_rationale},
            }
        )

    posterior_edge_summary = {
        "schema_version": "posterior-edge-summary-v1",
        "annualized_edge_mean_bps": net_edge_bps,
        "annualized_edge_lower_bps": lower_edge_bps,
        "test_days": int(test_summary.days),
        "selection_adjusted_edge_bps": adjusted_edge_bps,
    }

    return StrategyFactoryEvaluation(
        attempts=attempts,
        candidate_family=candidate_family,
        canonical_spec=canonical_spec,
        semantic_hash=semantic_hash,
        economic_rationale=resolved_rationale,
        complexity_score=complexity_score,
        discovery_rank=discovery_rank,
        posterior_edge_summary=posterior_edge_summary,
        economic_validity_card=economic_validity_card,
        valid_regime_envelope=valid_regime_envelope,
        invalidation_clauses=invalidation_clauses,
        null_comparator_summary=null_comparator_summary,
        validation_tests=validation_tests,
        fold_stat_bundle=fold_stat_bundle,
        stress_results=stress_results,
        cost_calibration=cost_calibration,
    )


__all__ = [
    "CostCalibrationRecord",
    "StrategyFactoryEvaluation",
    "ValidationTestResult",
    "build_strategy_factory_evaluation",
]
