from __future__ import annotations


import json
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.trading.autonomy.gates import (
    GateInputs,
    GatePolicyMatrix,
    evaluate_gate_matrix,
)


class _TestAutonomyGatesBase(TestCase):
    pass


def _healthy_gate_inputs(*, symbol_coverage: int = 2) -> GateInputs:
    return GateInputs(
        feature_schema_version="3.0.0",
        required_feature_null_rate=Decimal("0.00"),
        staleness_ms_p95=0,
        symbol_coverage=symbol_coverage,
        tca_metrics={
            "order_count": 12,
            "avg_slippage_bps": "18",
            "avg_shortfall_notional": "7",
            "avg_churn_ratio": "0.45",
            "avg_realized_shortfall_bps": "7",
            "avg_divergence_bps": "1",
            "avg_calibration_error_bps": "0",
            "expected_shortfall_coverage": "0.50",
            "expected_shortfall_sample_count": 12,
        },
        llm_metrics={"error_ratio": "0.00"},
        metrics={
            "decision_count": 20,
            "trade_count": 10,
            "net_pnl": "50",
            "max_drawdown": "100",
            "turnover_ratio": "1.5",
            "cost_bps": "5",
        },
        robustness={
            "fold_count": 4,
            "negative_fold_count": 1,
            "net_pnl_cv": "0.3",
        },
        forecast_metrics=_healthy_forecast_metrics_payload(),
        profitability_evidence=_profitability_evidence_payload(),
    )


def _profitability_evidence_payload(
    *,
    coverage_error: str = "0.02",
    shift_score: str = "0.20",
    gate_action: str = "pass",
    recalibration_run_id: str | None = None,
    recalibration_artifact_ref: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "profitability-evidence-v4",
        "risk_adjusted_metrics": {
            "market_net_pnl_delta": "0",
            "regime_slice_pass_ratio": "1",
            "return_over_drawdown": "0.5",
        },
        "cost_fill_realism": {"cost_bps": "5"},
        "confidence_calibration": {
            "calibration_error": "0.2",
            "target_coverage": "0.90",
            "observed_coverage": str(Decimal("0.90") - Decimal(coverage_error)),
            "coverage_error": coverage_error,
            "avg_interval_width": "0.75",
            "shift_score": shift_score,
            "gate_action": gate_action,
            "recalibration_run_id": recalibration_run_id,
            "recalibration_artifact_ref": recalibration_artifact_ref,
        },
        "reproducibility": {
            "artifact_hashes": {
                "signals": "a",
                "strategy_config": "b",
                "gate_policy": "c",
                "candidate_report": "d",
                "baseline_report": "e",
            }
        },
        "benchmark": {"schema_version": "profitability-benchmark-v4"},
        "validation": {"passed": True},
        "janus_q": {
            "schema_version": "janus-q-evidence-v1",
            "evidence_complete": True,
            "reasons": [],
            "event_car": {
                "schema_version": "janus-event-car-v1",
                "event_count": 3,
                "artifact_ref": "/tmp/janus-event-car-v1.json",
            },
            "hgrm_reward": {
                "schema_version": "janus-hgrm-reward-v1",
                "reward_count": 3,
                "artifact_ref": "/tmp/janus-hgrm-reward-v1.json",
            },
        },
    }


def _healthy_forecast_metrics_payload() -> dict[str, str]:
    return {
        "fallback_rate": "0.01",
        "inference_latency_ms_p95": "50",
        "calibration_score_min": "0.95",
    }


__all__: tuple[str, ...] = (
    "Decimal",
    "GateInputs",
    "GatePolicyMatrix",
    "Path",
    "TestCase",
    "_TestAutonomyGatesBase",
    "_healthy_forecast_metrics_payload",
    "_healthy_gate_inputs",
    "_profitability_evidence_payload",
    "evaluate_gate_matrix",
    "json",
    "tempfile",
)
