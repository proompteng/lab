from __future__ import annotations

import contextlib
import io
import json
import runpy
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

from scripts.build_historical_profitability_proof import (
    build_historical_profitability_bundle,
    main,
)
from scripts.historical_profitability_proof.proof_core import (
    _load_json,
    _load_yaml,
)


class TestBuildHistoricalProfitabilityProof(TestCase):
    def test_cli_entrypoint_delegates_to_main(self) -> None:
        with patch(
            "scripts.historical_profitability_proof.main",
            return_value=7,
        ) as mocked_main:
            with self.assertRaises(SystemExit) as raised:
                runpy.run_path(
                    "scripts/build_historical_profitability_proof.py",
                    run_name="__main__",
                )

        self.assertEqual(raised.exception.code, 7)
        mocked_main.assert_called_once_with()

    def test_builds_profitable_bundle_from_historical_runs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name="sim-a",
                trading_day="2026-03-02",
                net_pnl="10",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="dump-a",
            )
            run_b = _write_run(
                root=root,
                run_name="sim-b",
                trading_day="2026-03-03",
                net_pnl="5",
                decision_count=7,
                execution_count=3,
                avg_confidence="0.85",
                dump_hash="dump-b",
            )
            output_dir = root / "out"

            summary = build_historical_profitability_bundle(
                run_dirs=[run_a, run_b],
                output_dir=output_dir,
                hypothesis="intraday_tsmom_v1 is profitable over the OOS replay window",
                target_net_pnl_per_day="5",
                min_sample_size=2,
                max_best_day_share="1.0",
            )

            self.assertTrue(summary["passed"])
            proof_payload = json.loads(
                (output_dir / "profitability-proof.json").read_text(encoding="utf-8")
            )
            self.assertTrue(proof_payload["passed"])
            self.assertEqual(proof_payload["sample_size"], 2)
            self.assertEqual(proof_payload["window_days"], 2)
            self.assertEqual(
                proof_payload["proof_gates"]["target_net_pnl_per_day"], "5"
            )
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["average_daily_net_pnl"], "7.5"
            )

            candidate_report = json.loads(
                (output_dir / "candidate-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual(candidate_report["metrics"]["net_pnl"], "15")
            self.assertEqual(candidate_report["metrics"]["trade_count"], 7)
            self.assertEqual(len(candidate_report["robustness"]["folds"]), 2)

            validation_payload = json.loads(
                (output_dir / "profitability-evidence-validation.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertTrue(validation_payload["passed"])

    def test_loader_rejects_non_mapping_payloads(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            json_path = root / "payload.json"
            json_path.write_text(json.dumps(["not", "a", "mapping"]), encoding="utf-8")
            yaml_path = root / "payload.yaml"
            yaml_path.write_text("- not\n- a\n- mapping\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "json_mapping_required"):
                _load_json(json_path)
            with self.assertRaisesRegex(RuntimeError, "yaml_mapping_required"):
                _load_yaml(yaml_path)

    def test_cli_parser_threads_fail_closed_gate_overrides_into_bundle(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name="sim-a",
                trading_day="2026-03-02",
                net_pnl="750",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="dump-a",
            )
            run_b = _write_run(
                root=root,
                run_name="sim-b",
                trading_day="2026-03-03",
                net_pnl="700",
                decision_count=7,
                execution_count=3,
                avg_confidence="0.85",
                dump_hash="dump-b",
            )
            output_dir = root / "out"
            argv = [
                "build_historical_profitability_proof.py",
                "--run-dir",
                str(run_a),
                "--run-dir",
                str(run_b),
                "--output-dir",
                str(output_dir),
                "--hypothesis",
                "candidate clears fail-closed gates",
                "--baseline-id",
                "cash-flat@baseline",
                "--target-net-pnl-per-day",
                "500",
                "--min-sample-size",
                "2",
                "--min-active-day-ratio",
                "0.90",
                "--min-positive-day-ratio",
                "0.60",
                "--max-best-day-share",
                "1.0",
                "--min-daily-notional",
                "500",
                "--start-equity",
                "10000",
                "--max-drawdown-pct-equity",
                "0.10",
                "--extended-max-drawdown-pct-equity",
                "0.15",
                "--min-total-net-pnl-to-drawdown-ratio",
                "2.0",
                "--json",
            ]

            stdout = io.StringIO()
            with patch.object(sys, "argv", argv), contextlib.redirect_stdout(stdout):
                exit_code = main()

            self.assertEqual(exit_code, 0)
            summary = json.loads(stdout.getvalue())
            self.assertTrue(summary["passed"])
            proof_payload = json.loads(
                (output_dir / "profitability-proof.json").read_text(encoding="utf-8")
            )
            self.assertEqual(proof_payload["proof_gates"]["min_daily_notional"], "500")
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["avg_daily_notional"], "1000"
            )

    def test_positive_but_below_target_daily_net_fails_proof_gate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            runs = [
                _write_run(
                    root=root,
                    run_name=f"sim-{index}",
                    trading_day=f"2026-03-0{index + 2}",
                    net_pnl=str(net_pnl),
                    decision_count=8,
                    execution_count=4,
                    avg_confidence="0.9",
                    dump_hash=f"dump-{index}",
                )
                for index, net_pnl in enumerate((100, 200, 150))
            ]
            output_dir = root / "out"

            summary = build_historical_profitability_bundle(
                run_dirs=runs,
                output_dir=output_dir,
                target_net_pnl_per_day="500",
                min_sample_size=3,
                max_best_day_share="1.0",
            )

            self.assertFalse(summary["passed"])
            self.assertIn(
                "average_daily_net_pnl_below_target", summary["failed_reasons"]
            )
            proof_payload = json.loads(
                (output_dir / "profitability-proof.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["average_daily_net_pnl"], "150"
            )
            self.assertIn(
                "average_daily_net_pnl_below_target", proof_payload["failed_reasons"]
            )

    def test_inactive_days_fail_active_day_ratio_gate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name="sim-a",
                trading_day="2026-03-02",
                net_pnl="750",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="dump-a",
            )
            run_b = _write_run(
                root=root,
                run_name="sim-b",
                trading_day="2026-03-03",
                net_pnl="750",
                decision_count=0,
                execution_count=0,
                avg_confidence="0.9",
                dump_hash="dump-b",
            )
            output_dir = root / "out"

            summary = build_historical_profitability_bundle(
                run_dirs=[run_a, run_b],
                output_dir=output_dir,
                target_net_pnl_per_day="500",
                min_sample_size=2,
                min_active_day_ratio="0.90",
                max_best_day_share="1.0",
            )

            self.assertFalse(summary["passed"])
            self.assertIn("active_day_ratio_below_minimum", summary["failed_reasons"])
            proof_payload = json.loads(
                (output_dir / "profitability-proof.json").read_text(encoding="utf-8")
            )
            self.assertEqual(proof_payload["proof_gates"]["observed"]["active_days"], 1)
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["active_day_ratio"], "0.5"
            )

    def test_source_dump_hash_fallback_and_notional_gate_are_recorded(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name="sim-a",
                trading_day="2026-03-02",
                net_pnl="750",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="",
            )
            (run_a / "replay-report.json").unlink()
            (run_a / "source-dump.jsonl.zst.manifest.json").write_text(
                json.dumps({"chunks": [{"payload_sha256": "chunk-a"}]}),
                encoding="utf-8",
            )
            run_b = _write_run(
                root=root,
                run_name="sim-b",
                trading_day="2026-03-03",
                net_pnl="700",
                decision_count=7,
                execution_count=3,
                avg_confidence="0.85",
                dump_hash="",
            )
            (run_b / "replay-report.json").unlink()
            (run_b / "source-dump.jsonl.zst").write_bytes(b"source-dump-b")
            output_dir = root / "out"

            summary = build_historical_profitability_bundle(
                run_dirs=[run_a, run_b],
                output_dir=output_dir,
                target_net_pnl_per_day="500",
                min_sample_size=2,
                max_best_day_share="1.0",
                min_daily_notional="2000",
            )

            self.assertFalse(summary["passed"])
            self.assertIn("avg_daily_notional_below_minimum", summary["failed_reasons"])
            proof_payload = json.loads(
                (output_dir / "profitability-proof.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["avg_daily_notional"], "1000"
            )
            self.assertTrue((output_dir / "profitability-evidence-v4.json").exists())

    def test_excessive_drawdown_fails_proof_gate_even_when_average_target_passes(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            runs = [
                _write_run(
                    root=root,
                    run_name=f"sim-{index}",
                    trading_day=f"2026-03-0{index + 2}",
                    net_pnl=str(net_pnl),
                    decision_count=8,
                    execution_count=4,
                    avg_confidence="0.9",
                    dump_hash=f"dump-{index}",
                )
                for index, net_pnl in enumerate((2000, -4500, 3000, 3000))
            ]
            output_dir = root / "out"

            summary = build_historical_profitability_bundle(
                run_dirs=runs,
                output_dir=output_dir,
                target_net_pnl_per_day="500",
                min_sample_size=4,
                min_positive_day_ratio="0.60",
                max_best_day_share="1.0",
                start_equity="10000",
                max_drawdown_pct_equity="0.10",
                extended_max_drawdown_pct_equity="0.15",
            )

            self.assertFalse(summary["passed"])
            self.assertIn("max_drawdown_above_limit", summary["failed_reasons"])
            proof_payload = json.loads(
                (output_dir / "profitability-proof.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["average_daily_net_pnl"], "875"
            )
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["max_drawdown"], "4500"
            )
            self.assertEqual(
                proof_payload["proof_gates"]["observed"]["drawdown_passed"], False
            )

    def test_rejects_inconsistent_candidate_lineage(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name="sim-a",
                trading_day="2026-03-02",
                net_pnl="10",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="dump-a",
                candidate_id="intraday_tsmom_v1@prod",
            )
            run_b = _write_run(
                root=root,
                run_name="sim-b",
                trading_day="2026-03-03",
                net_pnl="5",
                decision_count=7,
                execution_count=3,
                avg_confidence="0.85",
                dump_hash="dump-b",
                candidate_id="other_candidate@prod",
            )

            with self.assertRaises(RuntimeError):
                build_historical_profitability_bundle(
                    run_dirs=[run_a, run_b],
                    output_dir=root / "out",
                )

    def test_rejects_duplicate_trading_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            run_a = _write_run(
                root=root,
                run_name="sim-a",
                trading_day="2026-03-02",
                net_pnl="10",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="dump-a",
            )
            run_b = _write_run(
                root=root,
                run_name="sim-b",
                trading_day="2026-03-02",
                net_pnl="5",
                decision_count=7,
                execution_count=3,
                avg_confidence="0.85",
                dump_hash="dump-b",
            )

            with self.assertRaises(RuntimeError):
                build_historical_profitability_bundle(
                    run_dirs=[run_a, run_b],
                    output_dir=root / "out",
                )

    def test_rejects_baseline_with_different_trading_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_a = _write_run(
                root=root,
                run_name="candidate-a",
                trading_day="2026-03-02",
                net_pnl="10",
                decision_count=8,
                execution_count=4,
                avg_confidence="0.9",
                dump_hash="dump-a",
            )
            candidate_b = _write_run(
                root=root,
                run_name="candidate-b",
                trading_day="2026-03-03",
                net_pnl="5",
                decision_count=7,
                execution_count=3,
                avg_confidence="0.85",
                dump_hash="dump-b",
            )
            baseline_a = _write_run(
                root=root,
                run_name="baseline-a",
                trading_day="2026-03-02",
                net_pnl="0",
                decision_count=1,
                execution_count=1,
                avg_confidence="0.8",
                dump_hash="baseline-a",
                candidate_id="cash-flat@baseline",
            )
            baseline_b = _write_run(
                root=root,
                run_name="baseline-b",
                trading_day="2026-03-04",
                net_pnl="0",
                decision_count=1,
                execution_count=1,
                avg_confidence="0.8",
                dump_hash="baseline-b",
                candidate_id="cash-flat@baseline",
            )

            with self.assertRaisesRegex(
                RuntimeError,
                "baseline_trading_days_mismatch",
            ):
                build_historical_profitability_bundle(
                    run_dirs=[candidate_a, candidate_b],
                    baseline_run_dirs=[baseline_a, baseline_b],
                    output_dir=root / "out",
                )


def _write_run(
    *,
    root: Path,
    run_name: str,
    trading_day: str,
    net_pnl: str,
    decision_count: int,
    execution_count: int,
    avg_confidence: str,
    dump_hash: str,
    candidate_id: str = "intraday_tsmom_v1@prod",
) -> Path:
    run_dir = root / run_name
    report_dir = run_dir / "report"
    report_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = root / f"{run_name}.yaml"
    manifest_path.write_text(
        yaml.safe_dump(
            {
                "window": {
                    "trading_day": trading_day,
                },
                "candidate_id": candidate_id,
                "baseline_candidate_id": "cash-flat@baseline",
                "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
                "model_refs": ["rules/intraday_tsmom_v1"],
                "runtime_version_refs": ["services/torghut@sha256:test"],
                "monitor": {
                    "min_trade_decisions": 1,
                    "min_executions": 1,
                },
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )

    (run_dir / "run-manifest.json").write_text(
        json.dumps(
            {
                "run_id": run_name,
                "evidence_lineage": {
                    "candidate_id": candidate_id,
                    "baseline_candidate_id": "cash-flat@baseline",
                    "strategy_spec_ref": "strategy-specs/intraday_tsmom_v1@1.1.0.json",
                    "model_refs": ["rules/intraday_tsmom_v1"],
                    "runtime_version_refs": ["services/torghut@sha256:test"],
                },
            }
        ),
        encoding="utf-8",
    )
    (run_dir / "replay-report.json").write_text(
        json.dumps(
            {
                "dump_sha256": dump_hash,
            }
        ),
        encoding="utf-8",
    )
    (report_dir / "trade-pnl.csv").write_text(
        "avg_fill_price,created_at,execution_id,filled_qty,realized_pnl_contribution,side,symbol,trade_decision_id\n"
        f"100,2026-03-16T12:00:00Z,exec-1,1,0,buy,AAPL,td-1\n"
        f"100,2026-03-16T12:01:00Z,exec-2,1,{net_pnl},sell,AAPL,td-2\n",
        encoding="utf-8",
    )
    (report_dir / "simulation-report.json").write_text(
        json.dumps(
            {
                "run_metadata": {
                    "run_id": run_name,
                    "manifest_path": str(manifest_path),
                },
                "coverage": {
                    "window_start": f"{trading_day}T13:30:00+00:00",
                },
                "funnel": {
                    "trade_decisions": decision_count,
                    "executions": execution_count,
                },
                "pnl": {
                    "net_pnl_estimated": net_pnl,
                    "estimated_cost_total": "0",
                    "execution_notional_total": "1000",
                },
                "llm": {
                    "avg_confidence": avg_confidence,
                },
                "verdict": {
                    "status": "PASS",
                },
            }
        ),
        encoding="utf-8",
    )
    return run_dir
