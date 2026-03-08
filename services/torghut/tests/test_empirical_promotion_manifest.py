from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

import yaml

from app.trading.empirical_manifest import (
    EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
    normalize_empirical_promotion_manifest,
    validate_empirical_promotion_manifest,
)
from scripts.build_empirical_promotion_manifest import (
    build_empirical_promotion_manifest,
)


class TestEmpiricalPromotionManifest(TestCase):
    def test_normalize_manifest_builds_janus_q_from_top_level_fields(self) -> None:
        normalized = normalize_empirical_promotion_manifest(
            {
                "schema_version": EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
                "run_id": "sim-1",
                "candidate_id": "legacy_macd_rsi@prod",
                "dataset_snapshot_ref": "dataset-1",
                "artifact_prefix": "empirical/sim-1",
                "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                "benchmark_parity": {"scorecards": {}},
                "foundation_router_parity": {"slice_metrics": {}},
                "janus_event_car": {"schema_version": "janus-event-car-v1"},
                "janus_hgrm_reward": {"schema_version": "janus-hgrm-reward-v1"},
                "model_refs": ["rules/legacy_macd_rsi"],
                "runtime_version_refs": ["services/torghut@sha256:abc"],
                "authority": {"generated_from_simulation_outputs": True},
                "promotion_authority_eligible": True,
            }
        )

        self.assertIn("janus_q", normalized)
        self.assertEqual(
            normalized["janus_q"]["event_car"]["schema_version"],
            "janus-event-car-v1",
        )
        self.assertEqual(
            normalized["janus_q"]["hgrm_reward"]["schema_version"],
            "janus-hgrm-reward-v1",
        )

    def test_validate_manifest_rejects_missing_authority_contract(self) -> None:
        reasons = validate_empirical_promotion_manifest(
            {
                "schema_version": EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
                "run_id": "sim-1",
                "candidate_id": "legacy_macd_rsi@prod",
                "dataset_snapshot_ref": "dataset-1",
                "artifact_prefix": "empirical/sim-1",
                "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                "benchmark_parity": {"scorecards": {}},
                "foundation_router_parity": {"slice_metrics": {}},
                "janus_event_car": {"schema_version": "janus-event-car-v1"},
                "janus_hgrm_reward": {"schema_version": "janus-hgrm-reward-v1"},
                "model_refs": ["rules/legacy_macd_rsi"],
                "runtime_version_refs": ["services/torghut@sha256:abc"],
                "promotion_authority_eligible": True,
            }
        )

        self.assertIn("authority_missing", reasons)

    def test_build_manifest_from_simulation_outputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            run_dir = Path(tmpdir) / "sim_1"
            report_dir = run_dir / "report"
            report_dir.mkdir(parents=True, exist_ok=True)

            source_manifest_path = Path(tmpdir) / "simulation-manifest.yaml"
            source_manifest_path.write_text(
                yaml.safe_dump(
                    {
                        "dataset_id": "dataset-1",
                        "dataset_snapshot_ref": "dataset-1",
                        "candidate_id": "legacy_macd_rsi@prod",
                        "baseline_candidate_id": "legacy_macd_rsi@baseline",
                        "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                        "model_refs": ["rules/legacy_macd_rsi"],
                        "runtime_version_refs": ["services/torghut@sha256:abc"],
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            (run_dir / "run-manifest.json").write_text(
                json.dumps(
                    {
                        "run_id": "sim-1",
                        "dataset_id": "dataset-1",
                        "evidence_lineage": {
                            "dataset_snapshot_ref": "dataset-1",
                            "candidate_id": "legacy_macd_rsi@prod",
                            "baseline_candidate_id": "legacy_macd_rsi@baseline",
                            "strategy_spec_ref": "strategy-specs/legacy_macd_rsi@1.0.0.json",
                            "model_refs": ["rules/legacy_macd_rsi"],
                            "runtime_version_refs": ["services/torghut@sha256:abc"],
                        },
                    }
                ),
                encoding="utf-8",
            )
            (report_dir / "simulation-report.json").write_text(
                json.dumps(
                    {
                        "run_metadata": {
                            "run_id": "sim-1",
                            "dataset_id": "dataset-1",
                            "manifest_path": str(source_manifest_path),
                        },
                        "coverage": {
                            "window_start": "2026-03-06T14:30:00+00:00",
                            "window_end": "2026-03-06T15:30:00+00:00",
                            "window_coverage_ratio_from_dump": 1.0,
                        },
                        "funnel": {
                            "trade_decisions": 12,
                            "executions": 8,
                            "decision_strategy_symbol_counts": [
                                {"symbol": "AAPL", "count": 8}
                            ],
                        },
                        "execution_quality": {
                            "fallback_ratio": 0.0,
                            "adapter_mismatch_ratio": 0.0,
                            "latency_ms": {"signal_to_decision_p95": 55},
                            "slippage_bps": {"p95_abs": 4.0},
                            "divergence_bps": {"p95_abs": 2.0},
                        },
                        "llm": {
                            "error_rate": 0.0,
                            "error_count": 0,
                            "calibration": {"mean_confidence_gap": 0.01},
                        },
                        "pnl": {
                            "net_pnl_estimated": "12.5",
                            "gross_pnl": "13.0",
                        },
                        "verdict": {"status": "PASS"},
                    }
                ),
                encoding="utf-8",
            )

            manifest = build_empirical_promotion_manifest(run_dir=run_dir)

        self.assertEqual(
            manifest["schema_version"],
            EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
        )
        self.assertEqual(manifest["dataset_snapshot_ref"], "dataset-1")
        self.assertEqual(manifest["candidate_id"], "legacy_macd_rsi@prod")
        self.assertTrue(manifest["promotion_authority_eligible"])
        self.assertEqual(validate_empirical_promotion_manifest(manifest), [])
