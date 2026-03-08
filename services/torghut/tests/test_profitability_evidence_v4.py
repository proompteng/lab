from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.evaluation import (
    ProfitabilityEvidenceThresholdsV4,
    build_fill_price_error_budget_report_v1,
    build_profitability_evidence_v4,
    build_shadow_live_deviation_report_v1,
    build_simulation_calibration_report_v1,
    execute_profitability_benchmark_v4,
    validate_profitability_evidence_v4,
)


class TestProfitabilityEvidenceV4(TestCase):
    def test_benchmark_and_validation_emit_expected_schema(self) -> None:
        candidate_report = _report_payload(
            net_pnl="12",
            max_drawdown="6",
            cost_bps="4",
            regime_label="bullish",
            regime_net_pnl="12",
        )
        baseline_report = _report_payload(
            net_pnl="10",
            max_drawdown="8",
            cost_bps="5",
            regime_label="bullish",
            regime_net_pnl="8",
        )

        benchmark = execute_profitability_benchmark_v4(
            candidate_id="cand-1",
            baseline_id="baseline-legacy",
            candidate_report_payload=candidate_report,
            baseline_report_payload=baseline_report,
            required_slice_keys=["market:all", "regime:bullish"],
            executed_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
        )
        evidence = build_profitability_evidence_v4(
            run_id="run-1",
            candidate_id="cand-1",
            baseline_id="baseline-legacy",
            candidate_report_payload=candidate_report,
            benchmark=benchmark,
            confidence_values=[Decimal("0.7"), Decimal("0.8")],
            reproducibility_hashes={
                "signals": "a",
                "strategy_config": "b",
                "gate_policy": "c",
                "candidate_report": "d",
                "baseline_report": "e",
            },
            artifact_refs=["/tmp/a.json", "/tmp/b.json"],
            generated_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
        )
        validation = validate_profitability_evidence_v4(evidence)

        benchmark_payload = benchmark.to_payload()
        self.assertEqual(
            benchmark_payload["schema_version"], "profitability-benchmark-v4"
        )
        self.assertEqual(len(benchmark_payload["slices"]), 2)
        self.assertEqual(
            evidence.to_payload()["schema_version"], "profitability-evidence-v4"
        )
        confidence = evidence.to_payload()["confidence_calibration"]
        self.assertEqual(confidence["schema_version"], "calibration_snapshot_v1")
        self.assertIn("coverage_error", confidence)
        self.assertIn("shift_score", confidence)
        self.assertIn("gate_action", confidence)
        significance = evidence.to_payload()["significance"]
        self.assertEqual(significance["schema_version"], "significance_snapshot_v1")
        self.assertIn("ci_95_low", significance)
        self.assertIn("ci_95_high", significance)
        self.assertIn("p_value_two_sided", significance)
        self.assertTrue(validation.passed)
        self.assertEqual(validation.reasons, [])

    def test_validation_fails_when_contract_is_incomplete(self) -> None:
        candidate_report = _report_payload(
            net_pnl="-2",
            max_drawdown="10",
            cost_bps="80",
            regime_label="volatile",
            regime_net_pnl="-2",
        )
        baseline_report = _report_payload(
            net_pnl="3",
            max_drawdown="6",
            cost_bps="5",
            regime_label="volatile",
            regime_net_pnl="3",
        )
        benchmark = execute_profitability_benchmark_v4(
            candidate_id="cand-2",
            baseline_id="baseline-legacy",
            candidate_report_payload=candidate_report,
            baseline_report_payload=baseline_report,
        )
        evidence = build_profitability_evidence_v4(
            run_id="run-2",
            candidate_id="cand-2",
            baseline_id="baseline-legacy",
            candidate_report_payload=candidate_report,
            benchmark=benchmark,
            confidence_values=[],
            reproducibility_hashes={"signals": "only-one-hash"},
            artifact_refs=["/tmp/c.json"],
        )
        validation = validate_profitability_evidence_v4(
            evidence,
            thresholds=ProfitabilityEvidenceThresholdsV4(),
        )

        self.assertFalse(validation.passed)
        self.assertIn("market_net_pnl_delta_below_threshold", validation.reasons)
        self.assertIn("cost_bps_exceeds_threshold", validation.reasons)
        self.assertIn("reproducibility_hash_keys_missing", validation.reasons)

    def test_bridge_reports_emit_calibration_and_deviation_status(self) -> None:
        candidate_report = _report_payload(
            net_pnl="12",
            max_drawdown="6",
            cost_bps="4",
            regime_label="bullish",
            regime_net_pnl="12",
        )
        baseline_report = _report_payload(
            net_pnl="10",
            max_drawdown="8",
            cost_bps="5",
            regime_label="bullish",
            regime_net_pnl="8",
        )
        benchmark = execute_profitability_benchmark_v4(
            candidate_id="cand-3",
            baseline_id="baseline-legacy",
            candidate_report_payload=candidate_report,
            baseline_report_payload=baseline_report,
        )
        evidence = build_profitability_evidence_v4(
            run_id="run-3",
            candidate_id="cand-3",
            baseline_id="baseline-legacy",
            candidate_report_payload=candidate_report,
            benchmark=benchmark,
            confidence_values=[Decimal("0.7"), Decimal("0.8"), Decimal("0.75")],
            reproducibility_hashes={
                "signals": "a",
                "strategy_config": "b",
                "gate_policy": "c",
                "candidate_report": "d",
                "baseline_report": "e",
            },
            artifact_refs=["/tmp/a.json"],
            generated_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
        )
        tca_metrics = {
            "order_count": 12,
            "expected_shortfall_sample_count": 12,
            "expected_shortfall_coverage": Decimal("1"),
            "avg_expected_shortfall_bps_p50": Decimal("4"),
            "avg_expected_shortfall_bps_p95": Decimal("8"),
            "avg_realized_shortfall_bps": Decimal("5"),
            "avg_realized_shortfall_bps_abs": Decimal("5"),
            "avg_abs_slippage_bps": Decimal("6"),
            "avg_divergence_bps_abs": Decimal("3"),
            "avg_calibration_error_bps": Decimal("2"),
        }

        simulation = build_simulation_calibration_report_v1(
            run_id="run-3",
            candidate_id="cand-3",
            profitability_evidence=evidence,
            tca_metrics=tca_metrics,
            generated_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
        )
        deviation = build_shadow_live_deviation_report_v1(
            run_id="run-3",
            candidate_id="cand-3",
            profitability_evidence=evidence,
            tca_metrics=tca_metrics,
            generated_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
        )

        self.assertEqual(simulation.to_payload()["status"], "calibrated")
        self.assertEqual(
            simulation.to_payload()["artifact_authority"]["maturity"], "calibrated"
        )
        self.assertEqual(deviation.to_payload()["status"], "within_budget")
        self.assertEqual(
            deviation.to_payload()["artifact_authority"]["provenance"],
            "paper_runtime_observed",
        )

    def test_fill_price_error_budget_report_emits_calibrated_contract_when_within_budget(self) -> None:
        report = build_fill_price_error_budget_report_v1(
            run_id='run-4',
            venue='us_equities',
            order_count=24,
            median_abs_slippage_bps=Decimal('6'),
            p95_abs_slippage_bps=Decimal('14'),
            max_abs_slippage_bps=Decimal('19'),
            budget_median_abs_slippage_bps=Decimal('8'),
            budget_p95_abs_slippage_bps=Decimal('18'),
            generated_at=datetime(2026, 2, 20, tzinfo=timezone.utc),
        )

        payload = report.to_payload()
        self.assertEqual(payload['schema_version'], 'fill-price-error-budget-report-v1')
        self.assertEqual(payload['status'], 'within_budget')
        self.assertEqual(payload['artifact_authority']['maturity'], 'calibrated')
        self.assertTrue(payload['artifact_authority']['authoritative'])


def _report_payload(
    *,
    net_pnl: str,
    max_drawdown: str,
    cost_bps: str,
    regime_label: str,
    regime_net_pnl: str,
) -> dict[str, object]:
    return {
        "metrics": {
            "net_pnl": net_pnl,
            "max_drawdown": max_drawdown,
            "cost_bps": cost_bps,
            "trade_count": 4,
            "decision_count": 8,
            "turnover_ratio": "1.1",
        },
        "robustness": {
            "folds": [
                {
                    "fold_name": "fold_1",
                    "trade_count": 4,
                    "net_pnl": regime_net_pnl,
                    "max_drawdown": max_drawdown,
                    "cost_bps": cost_bps,
                    "turnover_ratio": "1.1",
                    "regime_label": regime_label,
                }
            ]
        },
        "impact_assumptions": {
            "decisions_with_spread": 4,
            "decisions_with_volatility": 4,
            "decisions_with_adv": 4,
            "assumptions": {
                "recorded_inputs_count": "4",
                "fallback_inputs_count": "0",
            },
        },
    }
