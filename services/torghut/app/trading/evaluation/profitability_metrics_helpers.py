"""Profitability evidence helpers without evaluation module import cycles."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any, Protocol, cast

from .numeric_helpers import (
    as_dict as _as_dict,
    as_int as _as_int,
    bootstrap_mean_samples as _bootstrap_mean_samples,
    decimal as _decimal,
    decimal_mean as _decimal_mean,
    decimal_std as _decimal_std,
    quantile_decimal as _quantile_decimal,
    safe_ratio as _safe_ratio,
)


class ProfitabilityBenchmarkSliceLike(Protocol):
    @property
    def slice_key(self) -> str: ...

    @property
    def slice_type(self) -> str: ...

    @property
    def deltas(self) -> Mapping[str, str]: ...


class ProfitabilityBenchmarkLike(Protocol):
    @property
    def schema_version(self) -> str: ...

    @property
    def slices(self) -> Sequence[ProfitabilityBenchmarkSliceLike]: ...


class ProfitabilityEvidenceLike(Protocol):
    @property
    def schema_version(self) -> str: ...

    @property
    def benchmark(self) -> ProfitabilityBenchmarkLike: ...

    @property
    def risk_adjusted_metrics(self) -> Mapping[str, Any]: ...

    @property
    def cost_fill_realism(self) -> Mapping[str, Any]: ...

    @property
    def confidence_calibration(self) -> Mapping[str, Any]: ...

    @property
    def significance(self) -> Mapping[str, Any]: ...

    @property
    def reproducibility(self) -> Mapping[str, Any]: ...


class ProfitabilityThresholdsLike(Protocol):
    @property
    def min_market_net_pnl_delta(self) -> Decimal: ...

    @property
    def min_risk_adjusted_return_over_drawdown(self) -> Decimal: ...

    @property
    def min_regime_slice_pass_ratio(self) -> Decimal: ...

    @property
    def max_cost_bps(self) -> Decimal: ...

    @property
    def min_confidence_samples(self) -> int: ...

    @property
    def max_calibration_error(self) -> Decimal: ...

    @property
    def min_significance_samples(self) -> int: ...

    @property
    def min_reproducibility_hashes(self) -> int: ...

    @property
    def required_hash_keys(self) -> Sequence[str]: ...


def append_profitability_reason(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    reason: str,
    payload: dict[str, object],
) -> None:
    reasons.append(reason)
    detail_payload: dict[str, object] = {"reason": reason}
    detail_payload.update(payload)
    details.append(detail_payload)


def validate_profitability_schema_versions(
    *,
    evidence: ProfitabilityEvidenceLike,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    if evidence.schema_version != "profitability-evidence-v4":
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="profitability_evidence_schema_invalid",
            payload={"expected": "profitability-evidence-v4"},
        )
    if evidence.benchmark.schema_version != "profitability-benchmark-v4":
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="profitability_benchmark_schema_invalid",
            payload={"expected": "profitability-benchmark-v4"},
        )


def validate_profitability_risk_metrics(
    *,
    evidence: ProfitabilityEvidenceLike,
    policy: ProfitabilityThresholdsLike,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    market_delta = _decimal(
        evidence.risk_adjusted_metrics.get("market_net_pnl_delta")
    ) or Decimal("0")
    if market_delta < policy.min_market_net_pnl_delta:
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="market_net_pnl_delta_below_threshold",
            payload={
                "actual": str(market_delta),
                "minimum": str(policy.min_market_net_pnl_delta),
            },
        )

    return_over_drawdown = _decimal(
        evidence.risk_adjusted_metrics.get("return_over_drawdown")
    ) or Decimal("0")
    if return_over_drawdown < policy.min_risk_adjusted_return_over_drawdown:
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="risk_adjusted_return_over_drawdown_below_threshold",
            payload={
                "actual": str(return_over_drawdown),
                "minimum": str(policy.min_risk_adjusted_return_over_drawdown),
            },
        )

    regime_ratio = _decimal(
        evidence.risk_adjusted_metrics.get("regime_slice_pass_ratio")
    ) or Decimal("0")
    if regime_ratio < policy.min_regime_slice_pass_ratio:
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="regime_slice_pass_ratio_below_threshold",
            payload={
                "actual": str(regime_ratio),
                "minimum": str(policy.min_regime_slice_pass_ratio),
            },
        )


def validate_profitability_cost_metrics(
    *,
    evidence: ProfitabilityEvidenceLike,
    policy: ProfitabilityThresholdsLike,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    cost_bps = _decimal(evidence.cost_fill_realism.get("cost_bps")) or Decimal("0")
    if cost_bps <= policy.max_cost_bps:
        return
    append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="cost_bps_exceeds_threshold",
        payload={
            "actual": str(cost_bps),
            "maximum": str(policy.max_cost_bps),
        },
    )


def validate_profitability_confidence_metrics(
    *,
    evidence: ProfitabilityEvidenceLike,
    policy: ProfitabilityThresholdsLike,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    confidence_samples = (
        _as_int(evidence.confidence_calibration.get("sample_count")) or 0
    )
    if confidence_samples < policy.min_confidence_samples:
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="confidence_samples_below_minimum",
            payload={
                "actual": confidence_samples,
                "minimum": policy.min_confidence_samples,
            },
        )

    calibration_error = _decimal(
        evidence.confidence_calibration.get("calibration_error")
    ) or Decimal("1")
    if calibration_error <= policy.max_calibration_error:
        return
    append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="calibration_error_exceeds_threshold",
        payload={
            "actual": str(calibration_error),
            "maximum": str(policy.max_calibration_error),
        },
    )


def validate_profitability_significance_metrics(
    *,
    evidence: ProfitabilityEvidenceLike,
    policy: ProfitabilityThresholdsLike,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    significance = _as_dict(evidence.significance)
    schema_version = str(significance.get("schema_version", "")).strip()
    if schema_version != "significance_snapshot_v1":
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="significance_schema_invalid",
            payload={"expected": "significance_snapshot_v1"},
        )
    sample_count = _as_int(significance.get("sample_count")) or 0
    if sample_count < policy.min_significance_samples:
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="significance_samples_below_minimum",
            payload={
                "actual": sample_count,
                "minimum": policy.min_significance_samples,
            },
        )


def validate_profitability_reproducibility(
    *,
    evidence: ProfitabilityEvidenceLike,
    policy: ProfitabilityThresholdsLike,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    reproducibility = _as_dict(evidence.reproducibility)
    hashes = {
        str(key): str(value)
        for key, value in _as_dict(reproducibility.get("artifact_hashes")).items()
        if str(key).strip() and str(value).strip()
    }
    if len(hashes) < policy.min_reproducibility_hashes:
        append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="reproducibility_hash_count_below_minimum",
            payload={
                "actual": len(hashes),
                "minimum": policy.min_reproducibility_hashes,
            },
        )

    missing_hash_keys = sorted(
        [key for key in policy.required_hash_keys if key not in hashes]
    )
    if not missing_hash_keys:
        return
    append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="reproducibility_hash_keys_missing",
        payload={"missing_keys": missing_hash_keys},
    )


def _extract_report_slices(report_payload: dict[str, Any]) -> dict[str, dict[str, str]]:
    metrics = _as_dict(report_payload.get("metrics"))
    slices: dict[str, dict[str, str]] = {
        "market:all": slice_metrics(
            net_pnl=_decimal(metrics.get("net_pnl")),
            max_drawdown=_decimal(metrics.get("max_drawdown")),
            cost_bps=_decimal(metrics.get("cost_bps")),
            turnover_ratio=_decimal(metrics.get("turnover_ratio")),
            trade_count=_as_int(metrics.get("trade_count")),
        )
    }
    robustness = _as_dict(report_payload.get("robustness"))
    folds = robustness.get("folds")
    if isinstance(folds, list):
        grouped: dict[str, list[dict[str, Any]]] = {}
        for raw in cast(list[object], folds):
            if not isinstance(raw, dict):
                continue
            fold = cast(dict[str, Any], raw)
            regime = str(fold.get("regime_label", "")).strip() or "unknown"
            grouped.setdefault(regime, []).append(fold)
        for regime, entries in grouped.items():
            net_pnl = sum(
                ((_decimal(item.get("net_pnl")) or Decimal("0")) for item in entries),
                Decimal("0"),
            )
            max_drawdown = max(
                (_decimal(item.get("max_drawdown")) or Decimal("0")) for item in entries
            )
            cost_values = [
                (_decimal(item.get("cost_bps")) or Decimal("0")) for item in entries
            ]
            turnover_values = [
                (_decimal(item.get("turnover_ratio")) or Decimal("0"))
                for item in entries
            ]
            trade_count = sum(
                (_as_int(item.get("trade_count")) or 0) for item in entries
            )
            slices[f"regime:{regime}"] = slice_metrics(
                net_pnl=net_pnl,
                max_drawdown=max_drawdown,
                cost_bps=_decimal_mean(cost_values),
                turnover_ratio=_decimal_mean(turnover_values),
                trade_count=trade_count,
            )
    return slices


def slice_metrics(
    *,
    net_pnl: Decimal | None,
    max_drawdown: Decimal | None,
    cost_bps: Decimal | None,
    turnover_ratio: Decimal | None,
    trade_count: int | None,
) -> dict[str, str]:
    return {
        "net_pnl": str(net_pnl or Decimal("0")),
        "max_drawdown": str(max_drawdown or Decimal("0")),
        "cost_bps": str(cost_bps or Decimal("0")),
        "turnover_ratio": str(turnover_ratio or Decimal("0")),
        "trade_count": str(trade_count or 0),
    }


def empty_slice_metrics() -> dict[str, str]:
    return slice_metrics(
        net_pnl=Decimal("0"),
        max_drawdown=Decimal("0"),
        cost_bps=Decimal("0"),
        turnover_ratio=Decimal("0"),
        trade_count=0,
    )


def slice_deltas(candidate: dict[str, str], baseline: dict[str, str]) -> dict[str, str]:
    candidate_net = _decimal(candidate.get("net_pnl")) or Decimal("0")
    baseline_net = _decimal(baseline.get("net_pnl")) or Decimal("0")
    candidate_dd = _decimal(candidate.get("max_drawdown")) or Decimal("0")
    baseline_dd = _decimal(baseline.get("max_drawdown")) or Decimal("0")
    candidate_cost = _decimal(candidate.get("cost_bps")) or Decimal("0")
    baseline_cost = _decimal(baseline.get("cost_bps")) or Decimal("0")
    candidate_trades = _as_int(candidate.get("trade_count")) or 0
    baseline_trades = _as_int(baseline.get("trade_count")) or 0
    return {
        "net_pnl_delta": str(candidate_net - baseline_net),
        "max_drawdown_delta": str(candidate_dd - baseline_dd),
        "cost_bps_delta": str(candidate_cost - baseline_cost),
        "trade_count_delta": str(candidate_trades - baseline_trades),
    }


def benchmark_summary(benchmark: ProfitabilityBenchmarkLike) -> dict[str, Decimal]:
    market_delta = Decimal("0")
    regime_total = 0
    regime_pass = 0
    for slice_item in benchmark.slices:
        net_delta = _decimal(slice_item.deltas.get("net_pnl_delta")) or Decimal("0")
        if slice_item.slice_key == "market:all":
            market_delta = net_delta
        if slice_item.slice_type == "regime":
            regime_total += 1
            if net_delta >= 0:
                regime_pass += 1
    pass_ratio = _safe_ratio(Decimal(regime_pass), Decimal(regime_total))
    return {
        "market_net_pnl_delta": market_delta,
        "regime_slice_pass_ratio": pass_ratio,
    }


def confidence_summary(
    confidence_values: list[Decimal], net_pnl: Decimal
) -> dict[str, object]:
    target_coverage = Decimal("0.90")
    calibration_target = Decimal("1") if net_pnl > 0 else Decimal("0")
    if not confidence_values:
        return {
            "sample_count": 0,
            "mean_confidence": "0",
            "std_confidence": "0",
            "calibration_target": str(calibration_target),
            "calibration_error": "1",
            "target_coverage": str(target_coverage),
            "observed_coverage": "0",
            "coverage_error": "1",
            "avg_interval_width": "0",
            "shift_state": "unknown",
            "shift_score": "1",
            "gate_action": "abstain",
            "schema_version": "calibration_snapshot_v1",
            "recalibration_run_id": None,
            "recalibration_artifact_ref": None,
        }
    mean_confidence = _decimal_mean(confidence_values)
    std_confidence = _decimal_std(confidence_values, mean_confidence)
    calibration_error = abs(mean_confidence - calibration_target)
    coverage_error = min(
        Decimal("1"),
        (calibration_error * Decimal("0.08")) + (std_confidence * Decimal("0.02")),
    )
    observed_coverage = max(Decimal("0"), target_coverage - coverage_error)
    avg_interval_width = min(
        Decimal("2"),
        Decimal("0.5") + (std_confidence * Decimal("2")) + calibration_error,
    )
    shift_score = min(
        Decimal("1"),
        abs(mean_confidence - calibration_target) + std_confidence,
    )
    if shift_score >= Decimal("0.95"):
        shift_state = "severe"
    elif shift_score >= Decimal("0.80"):
        shift_state = "high"
    elif shift_score >= Decimal("0.60"):
        shift_state = "elevated"
    else:
        shift_state = "stable"
    gate_action = "pass"
    if shift_score >= Decimal("0.95"):
        gate_action = "fail"
    elif coverage_error > Decimal("0.08") or shift_score >= Decimal("0.80"):
        gate_action = "abstain"
    elif coverage_error > Decimal("0.05") or shift_score >= Decimal("0.60"):
        gate_action = "degrade"
    return {
        "sample_count": len(confidence_values),
        "mean_confidence": str(mean_confidence),
        "std_confidence": str(std_confidence),
        "calibration_target": str(calibration_target),
        "calibration_error": str(calibration_error),
        "target_coverage": str(target_coverage),
        "observed_coverage": str(observed_coverage),
        "coverage_error": str(coverage_error),
        "avg_interval_width": str(avg_interval_width),
        "shift_state": shift_state,
        "shift_score": str(shift_score),
        "gate_action": gate_action,
        "schema_version": "calibration_snapshot_v1",
        "recalibration_run_id": None,
        "recalibration_artifact_ref": None,
    }


def significance_summary(benchmark: ProfitabilityBenchmarkLike) -> dict[str, object]:
    deltas = [
        _decimal(item.deltas.get("net_pnl_delta")) or Decimal("0")
        for item in benchmark.slices
        if item.slice_type in {"market", "regime"}
    ]
    if not deltas:
        return {
            "schema_version": "significance_snapshot_v1",
            "sample_count": 0,
            "net_pnl_delta_mean": "0",
            "net_pnl_delta_std": "0",
            "ci_95_low": "0",
            "ci_95_high": "0",
            "p_value_two_sided": "1",
            "statistically_positive": False,
            "statistically_negative": False,
            "bootstrap_samples": 0,
        }

    mean_delta = _decimal_mean(deltas)
    std_delta = _decimal_std(deltas, mean_delta)
    bootstrap_samples = _bootstrap_mean_samples(deltas, sample_count=512)
    sorted_samples = sorted(bootstrap_samples)
    ci_low = _quantile_decimal(sorted_samples, Decimal("0.025"))
    ci_high = _quantile_decimal(sorted_samples, Decimal("0.975"))
    non_positive_count = sum(1 for value in sorted_samples if value <= 0)
    non_negative_count = sum(1 for value in sorted_samples if value >= 0)
    sample_size = max(len(sorted_samples), 1)
    p_two_sided = min(
        Decimal("1"),
        Decimal("2")
        * min(
            Decimal(non_positive_count) / Decimal(sample_size),
            Decimal(non_negative_count) / Decimal(sample_size),
        ),
    )
    return {
        "schema_version": "significance_snapshot_v1",
        "sample_count": len(deltas),
        "net_pnl_delta_mean": str(mean_delta),
        "net_pnl_delta_std": str(std_delta),
        "ci_95_low": str(ci_low),
        "ci_95_high": str(ci_high),
        "p_value_two_sided": str(p_two_sided),
        "statistically_positive": bool(ci_low > 0),
        "statistically_negative": bool(ci_high < 0),
        "bootstrap_samples": len(sorted_samples),
    }


extract_report_slices = _extract_report_slices

__all__ = [
    "append_profitability_reason",
    "benchmark_summary",
    "confidence_summary",
    "empty_slice_metrics",
    "extract_report_slices",
    "significance_summary",
    "slice_deltas",
    "slice_metrics",
    "validate_profitability_confidence_metrics",
    "validate_profitability_cost_metrics",
    "validate_profitability_reproducibility",
    "validate_profitability_risk_metrics",
    "validate_profitability_schema_versions",
    "validate_profitability_significance_metrics",
]
