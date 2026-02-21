from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.autonomy.drift import (
    DriftThresholds,
    DriftTriggerPolicy,
    REASON_DATA_DUPLICATE_RATIO,
    REASON_DATA_NULL_RATE,
    REASON_DATA_SCHEMA_MISMATCH,
    REASON_DATA_STALENESS,
    REASON_MODEL_CALIBRATION_ERROR,
    REASON_MODEL_LLM_ERROR_RATIO,
    REASON_PERF_COST_BPS,
    REASON_PERF_DRAWDOWN,
    REASON_PERF_FALLBACK_RATIO,
    REASON_PERF_NET_PNL,
    decide_drift_action,
    detect_drift,
    evaluate_live_promotion_evidence,
)
from app.trading.feature_quality import FeatureQualityReport


class TestAutonomyDrift(TestCase):
    def test_detect_drift_emits_reason_codes_for_data_model_and_performance(
        self,
    ) -> None:
        report = FeatureQualityReport(
            accepted=False,
            rows_total=100,
            null_rate_by_field={"macd": 0.21},
            staleness_ms_p95=300_000,
            duplicate_ratio=0.15,
            schema_mismatch_total=2,
            reasons=[],
        )
        gate_payload = {
            "metrics": {
                "net_pnl": "-50",
                "max_drawdown": "0.20",
                "cost_bps": "65",
            },
            "llm_metrics": {"error_ratio": "0.30"},
            "profitability_evidence": {
                "confidence_calibration": {"calibration_error": "0.80"},
            },
        }
        detected = detect_drift(
            run_id="run-1",
            feature_quality_report=report,
            gate_report_payload=gate_payload,
            fallback_ratio=Decimal("0.90"),
            thresholds=DriftThresholds(),
            detected_at=datetime(2026, 2, 21, tzinfo=timezone.utc),
        )

        self.assertTrue(detected.drift_detected)
        for code in (
            REASON_DATA_NULL_RATE,
            REASON_DATA_STALENESS,
            REASON_DATA_DUPLICATE_RATIO,
            REASON_DATA_SCHEMA_MISMATCH,
            REASON_MODEL_CALIBRATION_ERROR,
            REASON_MODEL_LLM_ERROR_RATIO,
            REASON_PERF_NET_PNL,
            REASON_PERF_DRAWDOWN,
            REASON_PERF_COST_BPS,
            REASON_PERF_FALLBACK_RATIO,
        ):
            self.assertIn(code, detected.reason_codes)

    def test_drift_trigger_policy_respects_action_cooldown(self) -> None:
        report = FeatureQualityReport(
            accepted=False,
            rows_total=10,
            null_rate_by_field={"macd": 0.20},
            staleness_ms_p95=100,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=[],
        )
        detection = detect_drift(
            run_id="run-2",
            feature_quality_report=report,
            gate_report_payload={},
            fallback_ratio=Decimal("0"),
            thresholds=DriftThresholds(max_required_null_rate=Decimal("0.01")),
            detected_at=datetime(2026, 2, 21, 0, 0, tzinfo=timezone.utc),
        )
        now = datetime(2026, 2, 21, 0, 30, tzinfo=timezone.utc)
        policy = DriftTriggerPolicy(
            retrain_cooldown_seconds=3600, reselection_cooldown_seconds=10
        )

        decision = decide_drift_action(
            detection=detection,
            policy=policy,
            last_action_type="retrain",
            last_action_at=now - timedelta(minutes=10),
            now=now,
        )

        self.assertEqual(decision.action_type, "retrain")
        self.assertFalse(decision.triggered)
        self.assertTrue(decision.cooldown_active)
        self.assertGreater(decision.cooldown_remaining_seconds, 0)

    def test_live_promotion_evidence_blocks_when_drift_or_cooldown_active(self) -> None:
        report = FeatureQualityReport(
            accepted=False,
            rows_total=10,
            null_rate_by_field={"macd": 0.2},
            staleness_ms_p95=100,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=[],
        )
        detection = detect_drift(
            run_id="run-3",
            feature_quality_report=report,
            gate_report_payload={},
            fallback_ratio=Decimal("0"),
            thresholds=DriftThresholds(max_required_null_rate=Decimal("0.01")),
        )
        action = decide_drift_action(
            detection=detection,
            policy=DriftTriggerPolicy(),
            last_action_type="retrain",
            last_action_at=datetime.now(timezone.utc),
        )

        evidence = evaluate_live_promotion_evidence(
            detection=detection,
            action=action,
            evidence_refs=["/tmp/a.json", "/tmp/b.json"],
        )

        self.assertFalse(evidence.eligible_for_live_promotion)
        self.assertIn("drift_detected", evidence.reasons)
        self.assertGreaterEqual(len(evidence.evidence_artifact_refs), 2)
