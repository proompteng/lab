from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from scripts.import_hypothesis_runtime_windows import (
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    _load_json_artifact,
    _load_report_post_cost_expectancy_bps,
    _nonnegative_int,
    _parse_args,
    _query_timestamps,
    _strategy_name_candidates,
    main,
)


class _FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self._results = [
            [(datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),)],
            [(datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),)],
            [
                (
                    datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    Decimal("1.25"),
                    Decimal("0.50"),
                )
            ],
        ]

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: tuple[object, ...]) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._results.pop(0)


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


class _FakeSession:
    def __init__(self) -> None:
        self.committed = False

    def __enter__(self) -> _FakeSession:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def commit(self) -> None:
        self.committed = True


class TestImportHypothesisRuntimeWindows(TestCase):
    def test_parse_args_accepts_dataset_snapshot_ref(self) -> None:
        with patch(
            "sys.argv",
            [
                "import_hypothesis_runtime_windows.py",
                "--run-id",
                "run-1",
                "--candidate-id",
                "cand-1",
                "--hypothesis-id",
                "H-CONT-01",
                "--observed-stage",
                "paper",
                "--source-dsn",
                "postgresql://example",
                "--strategy-name",
                "intraday-tsmom-profit-v2",
                "--account-label",
                "TORGHUT_SIM",
                "--window-start",
                "2026-03-06T14:30:00Z",
                "--window-end",
                "2026-03-06T15:00:00Z",
                "--dataset-snapshot-ref",
                "torghut-runtime-window-cand-1",
                "--artifact-ref",
                "s3://torghut-runtime/cand-1/report.json",
                "--json",
            ],
        ):
            args = _parse_args()

        self.assertEqual(args.run_id, "run-1")
        self.assertEqual(args.dataset_snapshot_ref, "torghut-runtime-window-cand-1")
        self.assertEqual(args.artifact_ref, ["s3://torghut-runtime/cand-1/report.json"])
        self.assertEqual(args.json, True)

    def test_main_requires_source_dsn(self) -> None:
        args = SimpleNamespace(
            source_dsn="",
            source_dsn_env="TORGHUT_TEST_MISSING_DSN",
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch.dict("os.environ", {}, clear=True),
        ):
            with self.assertRaisesRegex(RuntimeError, "source_dsn_not_configured"):
                main()

    def test_load_report_post_cost_expectancy_bps_uses_simulation_report(self) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "simulation-report.json"
            report_path.write_text(
                '{"pnl":{"net_pnl_estimated":"66.16","execution_notional_total":"200061.4"}}',
                encoding="utf-8",
            )

            value = _load_report_post_cost_expectancy_bps([str(report_path)])

        self.assertEqual(value, Decimal("3.306984755680006238084907933"))

    def test_json_artifact_and_nonnegative_int_helpers_fail_closed(self) -> None:
        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.json"
            invalid_path = Path(temp_dir) / "invalid.json"
            valid_path = Path(temp_dir) / "valid.json"
            invalid_path.write_text("{", encoding="utf-8")
            valid_path.write_text('{"case_count": 2}', encoding="utf-8")

            self.assertEqual(_load_json_artifact(""), {})
            self.assertEqual(_load_json_artifact(str(missing_path)), {})
            self.assertEqual(_load_json_artifact(str(invalid_path)), {})
            self.assertEqual(_load_json_artifact(str(valid_path)), {"case_count": 2})

        self.assertEqual(_nonnegative_int("3.9"), 3)
        self.assertEqual(_nonnegative_int("-2"), 0)
        self.assertEqual(_nonnegative_int("bad"), 0)

    def test_strategy_name_candidates_include_catalog_aliases(self) -> None:
        candidates = _strategy_name_candidates(
            "microbar_volume_continuation_long_top2_chip_v1@paper",
            "microbar-volume-continuation-long-top2-chip-v1",
            "",
            None,
        )

        self.assertEqual(
            candidates,
            [
                "microbar_volume_continuation_long_top2_chip_v1@paper",
                "microbar_volume_continuation_long_top2_chip_v1",
                "microbar-volume-continuation-long-top2-chip-v1@paper",
                "microbar-volume-continuation-long-top2-chip-v1",
            ],
        )

    def test_strategy_name_candidates_drop_blank_values(self) -> None:
        self.assertEqual(_strategy_name_candidates("", "   ", None), [])

    def test_query_timestamps_filters_to_execution_eligible_decisions(self) -> None:
        cursor = _FakeCursor()
        connection = _FakeConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            decisions, executions, tca_rows = _query_timestamps(
                dsn="postgresql://example",
                strategy_names=["intraday_tsmom_v1@paper", "intraday-tsmom-profit-v2"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(decisions, [datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)])
        self.assertEqual(
            executions, [datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)]
        )
        self.assertEqual(len(tca_rows), 1)
        self.assertEqual(tca_rows[0]["abs_slippage_bps"], Decimal("1.25"))
        self.assertEqual(tca_rows[0]["post_cost_expectancy_bps"], Decimal("0.50"))
        self.assertEqual(len(cursor.executed), 3)
        decision_query, decision_params = cursor.executed[0]
        self.assertIn("s.name = any(%s)", decision_query)
        self.assertIn("d.status = any(%s)", decision_query)
        self.assertEqual(
            decision_params[0],
            ["intraday_tsmom_v1@paper", "intraday-tsmom-profit-v2"],
        )
        self.assertEqual(
            decision_params[2],
            list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
        )
        tca_query, _ = cursor.executed[2]
        execution_query, _ = cursor.executed[1]
        self.assertIn("select d.created_at", execution_query)
        self.assertIn("d.created_at >= %s", execution_query)
        self.assertIn("d.created_at < %s", execution_query)
        self.assertNotIn("e.created_at >= %s", execution_query)
        self.assertIn("select\n                    d.created_at", tca_query)
        self.assertIn("d.created_at >= %s", tca_query)
        self.assertIn("d.created_at < %s", tca_query)
        self.assertNotIn("e.created_at >= %s", tca_query)
        self.assertNotIn("t.computed_at >= %s", tca_query)

    def test_query_timestamps_requires_strategy_name_candidates(self) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with self.assertRaisesRegex(RuntimeError, "strategy_name_not_configured"):
            _query_timestamps(
                dsn="postgresql://example",
                strategy_names=[],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

    def test_main_preserves_registry_manifest_fallback_when_source_manifest_ref_missing(
        self,
    ) -> None:
        args = SimpleNamespace(
            run_id="run-1",
            candidate_id="cand-1",
            hypothesis_id="H-CONT-01",
            observed_stage="paper",
            strategy_family="",
            source_dsn="postgresql://example",
            source_dsn_env="DB_DSN",
            strategy_name="intraday-tsmom-profit-v2",
            account_label="TORGHUT_SIM",
            window_start="2026-03-06T14:30:00Z",
            window_end="2026-03-06T15:00:00Z",
            bucket_minutes=30,
            sample_minutes=5,
            source_manifest_ref="",
            source_kind="simulation_paper_runtime",
            artifact_ref=[],
            dependency_quorum_decision="allow",
            continuity_ok="true",
            drift_ok="true",
            json=False,
        )
        fake_session = _FakeSession()
        manifest = SimpleNamespace(
            strategy_family="intraday_continuation",
            strategy_id="intraday_tsmom_v1@paper",
            max_allowed_slippage_bps=Decimal("12"),
        )

        with (
            patch(
                "scripts.import_hypothesis_runtime_windows._parse_args",
                return_value=args,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                return_value=(
                    SimpleNamespace(path="config/trading/hypotheses/h-cont-01.json"),
                    manifest,
                ),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows._query_timestamps",
                return_value=([], [], []),
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                return_value=[],
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                return_value={"run_id": "run-1"},
            ) as persist_windows,
            patch(
                "scripts.import_hypothesis_runtime_windows.SessionLocal",
                return_value=fake_session,
            ),
            patch("builtins.print"),
        ):
            exit_code = main()

        self.assertEqual(exit_code, 0)
        self.assertTrue(fake_session.committed)
        self.assertEqual(persist_windows.call_args.kwargs["source_manifest_ref"], None)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(runtime_payload["dataset_snapshot_ref"], None)
        self.assertEqual(
            runtime_payload["strategy_name_candidates"],
            [
                "intraday-tsmom-profit-v2",
                "intraday_tsmom_v1@paper",
                "intraday_tsmom_v1",
                "intraday-tsmom-v1@paper",
                "intraday-tsmom-v1",
            ],
        )

    def test_main_attaches_delay_adjusted_depth_report_to_runtime_payload(
        self,
    ) -> None:
        with TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "delay-depth.json"
            report_path.write_text(
                '{"passed": true, "case_count": 2, "checked_at": "2026-03-06T15:20:00Z"}',
                encoding="utf-8",
            )
            args = SimpleNamespace(
                run_id="run-depth",
                candidate_id="chip-paper-microbar-composite@execution-proof",
                hypothesis_id="H-MICRO-01",
                observed_stage="paper",
                strategy_family="microstructure_breakout",
                source_dsn="postgresql://example",
                source_dsn_env="DB_DSN",
                strategy_name="microbar_volume_continuation_long_top2_chip_v1@paper",
                account_label="TORGHUT_SIM",
                window_start="2026-03-06T14:30:00Z",
                window_end="2026-03-06T15:00:00Z",
                bucket_minutes=30,
                sample_minutes=5,
                source_manifest_ref="config/trading/hypotheses/h-micro-01.json",
                source_kind="simulation_paper_runtime",
                dataset_snapshot_ref="runtime-depth-snapshot",
                artifact_ref=[],
                delay_adjusted_depth_stress_report_ref=str(report_path),
                dependency_quorum_decision="allow",
                continuity_ok="true",
                drift_ok="true",
                json=False,
            )
            fake_session = _FakeSession()
            manifest = SimpleNamespace(
                strategy_family="microstructure_breakout",
                strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
                max_allowed_slippage_bps=Decimal("12"),
            )

            with (
                patch(
                    "scripts.import_hypothesis_runtime_windows._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.resolve_hypothesis_manifest",
                    return_value=(
                        SimpleNamespace(path="config/trading/hypotheses/h-micro-01.json"),
                        manifest,
                    ),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows._query_timestamps",
                    return_value=([], [], []),
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_regular_session_buckets",
                    return_value=[],
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.build_observed_runtime_buckets",
                    return_value=[],
                ),
                patch(
                    "scripts.import_hypothesis_runtime_windows.persist_observed_runtime_windows",
                    return_value={"run_id": "run-depth"},
                ) as persist_windows,
                patch(
                    "scripts.import_hypothesis_runtime_windows.SessionLocal",
                    return_value=fake_session,
                ),
                patch("builtins.print"),
            ):
                exit_code = main()

        self.assertEqual(exit_code, 0)
        runtime_payload = persist_windows.call_args.kwargs[
            "runtime_observation_payload"
        ]
        self.assertEqual(
            runtime_payload["delay_adjusted_depth_stress_artifact_ref"],
            str(report_path),
        )
        self.assertEqual(runtime_payload["delay_adjusted_depth_stress_checks_total"], 2)
        self.assertEqual(runtime_payload["delay_adjusted_depth_stress_passed"], True)
        self.assertEqual(
            runtime_payload["delay_adjusted_depth_stress_checked_at"],
            "2026-03-06T15:20:00Z",
        )
        self.assertIn(str(report_path), runtime_payload["artifact_refs"])
