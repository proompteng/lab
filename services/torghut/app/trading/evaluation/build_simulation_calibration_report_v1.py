"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)


from .signal_source import (
    FillPriceErrorBudgetReportV1,
    ProfitabilityEvidenceV4,
    ShadowLiveDeviationReportV1,
    SimulationCalibrationReportV1,
)
from .numeric_helpers import (
    as_dict as _as_dict,
    as_int as _as_int,
    decimal as _decimal,
)
from .profitability_metrics_helpers import (
    append_profitability_reason,
    benchmark_summary,
    confidence_summary,
    empty_slice_metrics,
    extract_report_slices,
    significance_summary,
    slice_deltas,
    slice_metrics,
    validate_profitability_confidence_metrics,
    validate_profitability_cost_metrics,
    validate_profitability_reproducibility,
    validate_profitability_risk_metrics,
    validate_profitability_schema_versions,
    validate_profitability_significance_metrics,
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


__all__ = (
    "build_simulation_calibration_report_v1",
    "build_shadow_live_deviation_report_v1",
    "build_fill_price_error_budget_report_v1",
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
)
