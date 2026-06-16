# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Protocol, cast

from ...models import Strategy
from ..decisions import DecisionEngine
from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from ..features import SignalFeatures, extract_signal_features
from ..models import SignalEnvelope, StrategyDecision

# ruff: noqa: F401,F403,F405,F811,F821

from .signal_source import (
    FillPriceErrorBudgetReportV1,
    FixtureSignalSource,
    FoldResult,
    ProfitabilityBenchmarkSliceV4,
    ProfitabilityBenchmarkV4,
    ProfitabilityEvidenceThresholdsV4,
    ProfitabilityEvidenceV4,
    ProfitabilityEvidenceValidationResultV4,
    ShadowLiveDeviationReportV1,
    SignalSource,
    SimulationCalibrationReportV1,
    WalkForwardDecision,
    WalkForwardFold,
    WalkForwardResults,
    _decimal_str,
    _empty_decisions,
    _fold_payload,
    _fold_regime_payload,
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    generate_walk_forward_folds,
    run_walk_forward,
    validate_profitability_evidence_v4,
    write_walk_forward_results,
)


def build_simulation_calibration_report_v1(
    *,
    run_id: str,
    candidate_id: str,
    profitability_evidence: ProfitabilityEvidenceV4,
    tca_metrics: dict[str, object],
    min_order_count: int = 1,
    min_expected_shortfall_coverage: Decimal = Decimal("0.50"),
    max_avg_calibration_error_bps: Decimal = Decimal("25"),
    generated_at: datetime | None = None,
) -> SimulationCalibrationReportV1:
    order_count = _as_int(tca_metrics.get("order_count")) or 0
    expected_shortfall_sample_count = (
        _as_int(tca_metrics.get("expected_shortfall_sample_count")) or 0
    )
    expected_shortfall_coverage = _decimal(
        tca_metrics.get("expected_shortfall_coverage")
    ) or Decimal("0")
    avg_expected_shortfall_bps_p50 = _decimal(
        tca_metrics.get("avg_expected_shortfall_bps_p50")
    ) or Decimal("0")
    avg_expected_shortfall_bps_p95 = _decimal(
        tca_metrics.get("avg_expected_shortfall_bps_p95")
    ) or Decimal("0")
    avg_realized_shortfall_bps = _decimal(
        tca_metrics.get("avg_realized_shortfall_bps")
    ) or Decimal("0")
    avg_calibration_error_bps = _decimal(
        tca_metrics.get("avg_calibration_error_bps")
    ) or Decimal("0")
    confidence_payload = _as_dict(profitability_evidence.confidence_calibration)
    confidence_sample_count = _as_int(confidence_payload.get("sample_count")) or 0
    confidence_calibration_error = _decimal(
        confidence_payload.get("calibration_error")
    ) or Decimal("0")
    confidence_coverage_error = _decimal(
        confidence_payload.get("coverage_error")
    ) or Decimal("0")
    confidence_shift_score = _decimal(confidence_payload.get("shift_score")) or Decimal(
        "0"
    )
    confidence_gate_action = (
        str(confidence_payload.get("gate_action", "abstain")).strip() or "abstain"
    )
    thresholds: dict[str, object] = {
        "min_order_count": min_order_count,
        "min_expected_shortfall_coverage": str(min_expected_shortfall_coverage),
        "max_avg_calibration_error_bps": str(max_avg_calibration_error_bps),
    }
    calibrated = (
        order_count >= min_order_count
        and expected_shortfall_coverage >= min_expected_shortfall_coverage
        and avg_calibration_error_bps <= max_avg_calibration_error_bps
        and confidence_gate_action == "pass"
    )
    status = (
        "calibrated"
        if calibrated
        else (
            "pending_runtime_observation"
            if order_count < min_order_count
            else "uncalibrated"
        )
    )
    maturity = (
        EvidenceMaturity.CALIBRATED if calibrated else EvidenceMaturity.UNCALIBRATED
    )
    provenance = (
        ArtifactProvenance.PAPER_RUNTIME_OBSERVED
        if order_count > 0
        else ArtifactProvenance.HISTORICAL_MARKET_REPLAY
    )
    artifact_authority = evidence_contract_payload(
        provenance=provenance,
        maturity=maturity,
        calibration_summary={
            "status": status,
            "order_count": order_count,
            "expected_shortfall_coverage": str(expected_shortfall_coverage),
            "avg_calibration_error_bps": str(avg_calibration_error_bps),
            "confidence_gate_action": confidence_gate_action,
        },
    )
    return SimulationCalibrationReportV1(
        schema_version="simulation-calibration-report-v1",
        generated_at=generated_at or datetime.now(timezone.utc),
        run_id=run_id,
        candidate_id=candidate_id,
        order_count=order_count,
        expected_shortfall_sample_count=expected_shortfall_sample_count,
        expected_shortfall_coverage=expected_shortfall_coverage,
        avg_expected_shortfall_bps_p50=avg_expected_shortfall_bps_p50,
        avg_expected_shortfall_bps_p95=avg_expected_shortfall_bps_p95,
        avg_realized_shortfall_bps=avg_realized_shortfall_bps,
        avg_calibration_error_bps=avg_calibration_error_bps,
        confidence_sample_count=confidence_sample_count,
        confidence_calibration_error=confidence_calibration_error,
        confidence_coverage_error=confidence_coverage_error,
        confidence_shift_score=confidence_shift_score,
        confidence_gate_action=confidence_gate_action,
        thresholds=thresholds,
        status=status,
        artifact_authority=artifact_authority,
    )


def build_shadow_live_deviation_report_v1(
    *,
    run_id: str,
    candidate_id: str,
    profitability_evidence: ProfitabilityEvidenceV4,
    tca_metrics: dict[str, object],
    min_order_count: int = 1,
    max_avg_abs_slippage_bps: Decimal = Decimal("20"),
    max_avg_abs_divergence_bps: Decimal = Decimal("15"),
    generated_at: datetime | None = None,
) -> ShadowLiveDeviationReportV1:
    order_count = _as_int(tca_metrics.get("order_count")) or 0
    decision_count = (
        _as_int(profitability_evidence.cost_fill_realism.get("decision_count")) or 0
    )
    trade_count = (
        _as_int(profitability_evidence.cost_fill_realism.get("trade_count")) or 0
    )
    trade_to_decision_ratio = _decimal(
        profitability_evidence.cost_fill_realism.get("trade_to_decision_ratio")
    ) or Decimal("0")
    avg_abs_slippage_bps = _decimal(tca_metrics.get("avg_abs_slippage_bps")) or Decimal(
        "0"
    )
    avg_abs_divergence_bps = _decimal(
        tca_metrics.get("avg_divergence_bps_abs")
    ) or Decimal("0")
    avg_realized_shortfall_bps_abs = _decimal(
        tca_metrics.get("avg_realized_shortfall_bps_abs")
    ) or Decimal("0")
    slippage_utilization = (
        avg_abs_slippage_bps / max_avg_abs_slippage_bps
        if max_avg_abs_slippage_bps > 0
        else Decimal("0")
    )
    divergence_utilization = (
        avg_abs_divergence_bps / max_avg_abs_divergence_bps
        if max_avg_abs_divergence_bps > 0
        else Decimal("0")
    )
    deviation_budget_utilization = max(slippage_utilization, divergence_utilization)
    within_budget = (
        order_count >= min_order_count
        and avg_abs_slippage_bps <= max_avg_abs_slippage_bps
        and avg_abs_divergence_bps <= max_avg_abs_divergence_bps
    )
    status = (
        "within_budget"
        if within_budget
        else (
            "pending_runtime_observation"
            if order_count < min_order_count
            else "out_of_budget"
        )
    )
    maturity = (
        EvidenceMaturity.CALIBRATED if within_budget else EvidenceMaturity.UNCALIBRATED
    )
    provenance = (
        ArtifactProvenance.PAPER_RUNTIME_OBSERVED
        if order_count > 0
        else ArtifactProvenance.HISTORICAL_MARKET_REPLAY
    )
    artifact_authority = evidence_contract_payload(
        provenance=provenance,
        maturity=maturity,
        deviation_summary={
            "status": status,
            "order_count": order_count,
            "avg_abs_slippage_bps": str(avg_abs_slippage_bps),
            "avg_abs_divergence_bps": str(avg_abs_divergence_bps),
            "deviation_budget_utilization": str(deviation_budget_utilization),
        },
    )
    return ShadowLiveDeviationReportV1(
        schema_version="shadow-live-deviation-report-v1",
        generated_at=generated_at or datetime.now(timezone.utc),
        run_id=run_id,
        candidate_id=candidate_id,
        order_count=order_count,
        decision_count=decision_count,
        trade_count=trade_count,
        trade_to_decision_ratio=trade_to_decision_ratio,
        avg_abs_slippage_bps=avg_abs_slippage_bps,
        avg_abs_divergence_bps=avg_abs_divergence_bps,
        avg_realized_shortfall_bps_abs=avg_realized_shortfall_bps_abs,
        deviation_budget_utilization=deviation_budget_utilization,
        thresholds={
            "min_order_count": min_order_count,
            "max_avg_abs_slippage_bps": str(max_avg_abs_slippage_bps),
            "max_avg_abs_divergence_bps": str(max_avg_abs_divergence_bps),
        },
        status=status,
        artifact_authority=artifact_authority,
    )


def build_fill_price_error_budget_report_v1(
    *,
    run_id: str,
    venue: str,
    order_count: int,
    median_abs_slippage_bps: Decimal,
    p95_abs_slippage_bps: Decimal,
    max_abs_slippage_bps: Decimal,
    budget_median_abs_slippage_bps: Decimal = Decimal("12"),
    budget_p95_abs_slippage_bps: Decimal = Decimal("25"),
    metric_observation_complete: bool = True,
    generated_at: datetime | None = None,
) -> FillPriceErrorBudgetReportV1:
    within_budget = (
        order_count > 0
        and metric_observation_complete
        and median_abs_slippage_bps <= budget_median_abs_slippage_bps
        and p95_abs_slippage_bps <= budget_p95_abs_slippage_bps
    )
    status = (
        "within_budget"
        if within_budget
        else (
            "pending_runtime_observation"
            if order_count <= 0 or not metric_observation_complete
            else "out_of_budget"
        )
    )
    artifact_authority = evidence_contract_payload(
        provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
        maturity=EvidenceMaturity.CALIBRATED
        if within_budget
        else EvidenceMaturity.UNCALIBRATED,
        authoritative=within_budget,
        placeholder=False,
        calibration_summary={
            "status": status,
            "order_count": order_count,
            "metric_observation_complete": metric_observation_complete,
            "median_abs_slippage_bps": str(median_abs_slippage_bps),
            "p95_abs_slippage_bps": str(p95_abs_slippage_bps),
        },
        notes="Replay-derived fill-price error budget for paper promotion.",
    )
    return FillPriceErrorBudgetReportV1(
        schema_version="fill-price-error-budget-report-v1",
        generated_at=generated_at or datetime.now(timezone.utc),
        run_id=run_id,
        venue=venue,
        order_count=order_count,
        metric_observation_complete=metric_observation_complete,
        median_abs_slippage_bps=median_abs_slippage_bps,
        p95_abs_slippage_bps=p95_abs_slippage_bps,
        max_abs_slippage_bps=max_abs_slippage_bps,
        budget_median_abs_slippage_bps=budget_median_abs_slippage_bps,
        budget_p95_abs_slippage_bps=budget_p95_abs_slippage_bps,
        status=status,
        artifact_authority=artifact_authority,
    )


def _append_profitability_reason(
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


def _validate_profitability_schema_versions(
    *,
    evidence: ProfitabilityEvidenceV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    if evidence.schema_version != "profitability-evidence-v4":
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="profitability_evidence_schema_invalid",
            payload={"expected": "profitability-evidence-v4"},
        )
    if evidence.benchmark.schema_version != "profitability-benchmark-v4":
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="profitability_benchmark_schema_invalid",
            payload={"expected": "profitability-benchmark-v4"},
        )


def _validate_profitability_risk_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    market_delta = _decimal(
        evidence.risk_adjusted_metrics.get("market_net_pnl_delta")
    ) or Decimal("0")
    if market_delta < policy.min_market_net_pnl_delta:
        _append_profitability_reason(
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
        _append_profitability_reason(
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
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="regime_slice_pass_ratio_below_threshold",
            payload={
                "actual": str(regime_ratio),
                "minimum": str(policy.min_regime_slice_pass_ratio),
            },
        )


def _validate_profitability_cost_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    cost_bps = _decimal(evidence.cost_fill_realism.get("cost_bps")) or Decimal("0")
    if cost_bps <= policy.max_cost_bps:
        return
    _append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="cost_bps_exceeds_threshold",
        payload={
            "actual": str(cost_bps),
            "maximum": str(policy.max_cost_bps),
        },
    )


def _validate_profitability_confidence_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    confidence_samples = (
        _as_int(evidence.confidence_calibration.get("sample_count")) or 0
    )
    if confidence_samples < policy.min_confidence_samples:
        _append_profitability_reason(
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
    _append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="calibration_error_exceeds_threshold",
        payload={
            "actual": str(calibration_error),
            "maximum": str(policy.max_calibration_error),
        },
    )


def _validate_profitability_significance_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    significance = _as_dict(evidence.significance)
    schema_version = str(significance.get("schema_version", "")).strip()
    if schema_version != "significance_snapshot_v1":
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="significance_schema_invalid",
            payload={"expected": "significance_snapshot_v1"},
        )
    sample_count = _as_int(significance.get("sample_count")) or 0
    if sample_count < policy.min_significance_samples:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="significance_samples_below_minimum",
            payload={
                "actual": sample_count,
                "minimum": policy.min_significance_samples,
            },
        )


def _validate_profitability_reproducibility(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
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
        _append_profitability_reason(
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
    _append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="reproducibility_hash_keys_missing",
        payload={"missing_keys": missing_hash_keys},
    )


def _extract_report_slices(report_payload: dict[str, Any]) -> dict[str, dict[str, str]]:
    metrics = _as_dict(report_payload.get("metrics"))
    slices: dict[str, dict[str, str]] = {
        "market:all": _slice_metrics(
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
            slices[f"regime:{regime}"] = _slice_metrics(
                net_pnl=net_pnl,
                max_drawdown=max_drawdown,
                cost_bps=_decimal_mean(cost_values),
                turnover_ratio=_decimal_mean(turnover_values),
                trade_count=trade_count,
            )
    return slices


def _slice_metrics(
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


def _empty_slice_metrics() -> dict[str, str]:
    return _slice_metrics(
        net_pnl=Decimal("0"),
        max_drawdown=Decimal("0"),
        cost_bps=Decimal("0"),
        turnover_ratio=Decimal("0"),
        trade_count=0,
    )


def _slice_deltas(
    candidate: dict[str, str], baseline: dict[str, str]
) -> dict[str, str]:
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


def _benchmark_summary(benchmark: ProfitabilityBenchmarkV4) -> dict[str, Decimal]:
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


def _confidence_summary(
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


def _significance_summary(benchmark: ProfitabilityBenchmarkV4) -> dict[str, object]:
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


__all__ = [name for name in globals() if not name.startswith("__")]
