from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from scripts.analyze_historical_simulation import (
    _build_last_price_map,
    _build_report,
    _extract_run_scope_decisions,
    _fifo_trade_pnl,
    _query_rows,
)
from scripts.start_historical_simulation import ClickHouseRuntimeConfig


class TestAnalyzeHistoricalSimulation(TestCase):
    def test_query_rows_executes_literal_query_and_normalizes_keys(self) -> None:
        class FakeCursor:
            def __init__(self) -> None:
                self.executed_queries: list[object] = []

            def __enter__(self) -> "FakeCursor":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def execute(self, query: object) -> None:
                self.executed_queries.append(query)

            def fetchall(self) -> list[dict[object, object]]:
                return [{"id": "decision-1", 2: Decimal("1.25")}]

        class FakeConnection:
            def __init__(self) -> None:
                self.cursor_instance = FakeCursor()
                self.row_factory: object | None = None

            def cursor(self, *, row_factory: object) -> FakeCursor:
                self.row_factory = row_factory
                return self.cursor_instance

        conn = FakeConnection()

        rows = _query_rows(cast(Any, conn), "SELECT id, value FROM trade_decisions")

        self.assertEqual(
            conn.cursor_instance.executed_queries,
            ["SELECT id, value FROM trade_decisions"],
        )
        self.assertIsNotNone(conn.row_factory)
        self.assertEqual(rows, [{"id": "decision-1", "2": Decimal("1.25")}])

    def test_build_last_price_map_uses_lane_specific_price_table(self) -> None:
        captured_queries: list[str] = []

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            _ = config
            captured_queries.append(query)
            return 200, "AAPL250321C00200000\t1.55\n"

        with patch(
            "scripts.analyze_historical_simulation_modules.report_helpers._http_clickhouse_query",
            side_effect=_fake_clickhouse_query,
        ):
            prices = _build_last_price_map(
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username=None,
                    password=None,
                ),
                price_table="torghut_sim_options.sim_options_contract_bars_1s",
                tca_rows=[],
                execution_rows=[],
            )

        self.assertEqual(prices["AAPL250321C00200000"], Decimal("1.55"))
        self.assertIn(
            "FROM torghut_sim_options.sim_options_contract_bars_1s",
            captured_queries[0],
        )

    def test_build_last_price_map_falls_back_to_c_field_for_microbars(self) -> None:
        captured_queries: list[str] = []

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            _ = config
            captured_queries.append(query)
            if "argMax(close, event_ts)" in query:
                return 404, "UNKNOWN_IDENTIFIER"
            return 200, "NVDA\t205.55\nAMD\t350.02\n"

        with patch(
            "scripts.analyze_historical_simulation_modules.report_helpers._http_clickhouse_query",
            side_effect=_fake_clickhouse_query,
        ):
            prices = _build_last_price_map(
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username=None,
                    password=None,
                ),
                price_table="torghut_sim_equity.ta_microbars",
                tca_rows=[],
                execution_rows=[],
            )

        self.assertEqual(prices["NVDA"], Decimal("205.55"))
        self.assertEqual(prices["AMD"], Decimal("350.02"))
        self.assertEqual(len(captured_queries), 2)
        self.assertIn("argMax(close, event_ts)", captured_queries[0])
        self.assertIn("argMax(c, event_ts)", captured_queries[1])

    def test_build_last_price_map_continues_after_clickhouse_error(self) -> None:
        captured_queries: list[str] = []

        def _fake_clickhouse_query(
            *, config: ClickHouseRuntimeConfig, query: str
        ) -> tuple[int, str]:
            _ = config
            captured_queries.append(query)
            if "argMax(close, event_ts)" in query:
                raise TimeoutError("clickhouse timeout")
            return 200, "NVDA\t205.55\n"

        with patch(
            "scripts.analyze_historical_simulation_modules.report_helpers._http_clickhouse_query",
            side_effect=_fake_clickhouse_query,
        ):
            prices = _build_last_price_map(
                clickhouse_config=ClickHouseRuntimeConfig(
                    http_url="http://clickhouse:8123",
                    username=None,
                    password=None,
                ),
                price_table="torghut_sim_equity.ta_microbars",
                tca_rows=[],
                execution_rows=[],
            )

        self.assertEqual(prices["NVDA"], Decimal("205.55"))
        self.assertEqual(len(captured_queries), 2)

    def test_extract_run_scope_decisions_prefers_matching_simulation_context(
        self,
    ) -> None:
        decisions = [
            {
                "id": "d1",
                "decision_json": {
                    "params": {
                        "simulation_context": {
                            "simulation_run_id": "run-a",
                        }
                    }
                },
            },
            {
                "id": "d2",
                "decision_json": {
                    "params": {
                        "simulation_context": {
                            "simulation_run_id": "run-b",
                        }
                    }
                },
            },
        ]

        scoped = _extract_run_scope_decisions(decisions, run_id="run-b")
        self.assertEqual(len(scoped), 1)
        self.assertEqual(scoped[0]["id"], "d2")

    def test_fifo_trade_pnl_computes_realized_and_unrealized(self) -> None:
        executions = [
            {
                "id": "e1",
                "trade_decision_id": "d1",
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("2"),
                "avg_fill_price": Decimal("10"),
                "created_at": "2026-02-27T20:00:00Z",
            },
            {
                "id": "e2",
                "trade_decision_id": "d2",
                "symbol": "AAPL",
                "side": "sell",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("13"),
                "created_at": "2026-02-27T20:01:00Z",
            },
        ]

        summary, rows = _fifo_trade_pnl(executions, last_prices={"AAPL": Decimal("12")})
        self.assertEqual(summary["realized_pnl"], Decimal("3"))
        self.assertEqual(summary["unrealized_pnl"], Decimal("2"))
        self.assertEqual(summary["gross_pnl"], Decimal("5"))
        self.assertEqual(len(rows), 2)

    def test_build_report_exports_aggregated_artifacts(self) -> None:
        class FakeConnection:
            def __enter__(self) -> object:
                return object()

            def __exit__(self, *args: object) -> None:
                return None

        observed = datetime(2026, 2, 27, 20, 0, tzinfo=timezone.utc)

        def _fake_query_rows(_conn: object, query: str) -> list[dict[str, object]]:
            if "FROM trade_decisions" in query:
                return [
                    {
                        "id": "d1",
                        "strategy_id": "strategy-a",
                        "symbol": "AAPL",
                        "status": "approved",
                        "created_at": observed,
                        "executed_at": observed,
                        "decision_json": {
                            "params": {
                                "simulation_context": {
                                    "simulation_run_id": "run-a",
                                    "signal_event_ts": "2026-02-27T19:59:00+00:00",
                                }
                            }
                        },
                    }
                ]
            if "FROM executions" in query:
                return [
                    {
                        "id": "e1",
                        "trade_decision_id": "d1",
                        "symbol": "AAPL",
                        "side": "buy",
                        "submitted_qty": Decimal("2"),
                        "filled_qty": Decimal("2"),
                        "avg_fill_price": Decimal("10"),
                        "status": "filled",
                        "created_at": observed,
                        "last_update_at": observed,
                        "order_feed_last_event_ts": observed,
                        "execution_expected_adapter": "simulation",
                        "execution_actual_adapter": "simulation",
                        "execution_fallback_reason": "",
                        "execution_fallback_count": 0,
                    },
                    {
                        "id": "e2",
                        "trade_decision_id": "d1",
                        "symbol": "AAPL",
                        "side": "sell",
                        "submitted_qty": Decimal("1"),
                        "filled_qty": Decimal("1"),
                        "avg_fill_price": Decimal("13"),
                        "status": "filled",
                        "created_at": observed,
                        "last_update_at": observed,
                        "order_feed_last_event_ts": observed,
                        "execution_expected_adapter": "simulation",
                        "execution_actual_adapter": "paper",
                        "execution_fallback_reason": "adapter_fallback",
                        "execution_fallback_count": 1,
                    },
                ]
            if "FROM execution_order_events" in query:
                return [
                    {
                        "execution_id": "e1",
                        "event_ts": observed,
                        "created_at": observed,
                        "status": "filled",
                        "event_type": "fill",
                    },
                    {
                        "execution_id": None,
                        "event_ts": observed,
                        "created_at": observed,
                        "status": "orphan",
                        "event_type": "fill",
                    },
                ]
            if "FROM execution_tca_metrics" in query:
                return [
                    {
                        "execution_id": "e1",
                        "trade_decision_id": "d1",
                        "strategy_id": "strategy-a",
                        "symbol": "AAPL",
                        "side": "buy",
                        "filled_qty": Decimal("2"),
                        "avg_fill_price": Decimal("10"),
                        "arrival_price": Decimal("9.5"),
                        "shortfall_notional": Decimal("0.5"),
                        "slippage_bps": Decimal("12"),
                        "realized_shortfall_bps": Decimal("8"),
                        "divergence_bps": Decimal("-3"),
                        "computed_at": observed,
                    }
                ]
            if "FROM llm_decision_reviews" in query:
                return [
                    {
                        "id": "r1",
                        "trade_decision_id": "d1",
                        "model": "model-a",
                        "prompt_version": "prompt-v1",
                        "verdict": "veto",
                        "confidence": Decimal("0.75"),
                        "tokens_prompt": 10,
                        "tokens_completion": 5,
                        "risk_flags": ["spread"],
                        "response_json": {
                            "policy_override": "risk_fallback_veto",
                            "fallback": "veto",
                            "deterministic_guardrails": ["max_loss"],
                            "calibrated_probabilities": {"veto": 0.8},
                        },
                        "created_at": observed,
                    }
                ]
            if "FROM trade_cursor" in query:
                return [{"source": "simulation", "cursor_at": observed}]
            return []

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_root = root / "outputs"
            run_dir = output_root / "run-a"
            run_dir.mkdir(parents=True)
            (run_dir / "run-manifest.json").write_text(
                '{"dump":{"min_source_timestamp_ms":1772222340000,"max_source_timestamp_ms":1772222400000}}',
                encoding="utf-8",
            )
            manifest_path = root / "dataset.json"
            manifest_path.write_text("{}", encoding="utf-8")
            report_dir = root / "report"
            resources = SimpleNamespace(
                output_root=output_root,
                run_token="run-a",
                dataset_id="dataset-a",
                lane="equity",
                clickhouse_db="sim_db",
                clickhouse_price_table="prices",
                clickhouse_signal_table="signals",
            )
            postgres_config = SimpleNamespace(
                admin_dsn="postgres://admin",
                simulation_dsn="postgres://simulation",
                simulation_db="simulation_db",
                migrations_command=("alembic", "upgrade", "head"),
            )

            with (
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._load_manifest",
                    return_value={
                        "reporting": {
                            "commission_bps": "10",
                            "per_trade_fee": "0.25",
                        },
                        "monitor": {
                            "min_trade_decisions": 1,
                            "min_executions": 1,
                        },
                    },
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._build_resources",
                    return_value=resources,
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._default_simulation_postgres_db",
                    return_value="simulation_db",
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._build_postgres_runtime_config",
                    return_value=postgres_config,
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._build_clickhouse_runtime_config",
                    return_value=ClickHouseRuntimeConfig(
                        http_url="",
                        username=None,
                        password=None,
                    ),
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._resolve_window_bounds",
                    return_value=(
                        datetime(2026, 2, 27, 19, 59, tzinfo=timezone.utc),
                        datetime(2026, 2, 27, 20, 1, tzinfo=timezone.utc),
                    ),
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._validate_window_policy",
                    return_value={"strict_coverage_ratio": 0.4},
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder.psycopg.connect",
                    return_value=FakeConnection(),
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._query_rows",
                    side_effect=_fake_query_rows,
                ),
                patch(
                    "scripts.analyze_historical_simulation_modules.report_builder._collect_clickhouse_stats",
                    return_value={"status": "skipped"},
                ),
            ):
                report = _build_report(
                    argparse.Namespace(
                        dataset_manifest=str(manifest_path),
                        run_id="run-a",
                        simulation_dsn="",
                        clickhouse_http_url="",
                        clickhouse_username="",
                        clickhouse_password="",
                        output_dir=str(report_dir),
                    )
                )

            self.assertEqual(report["verdict"]["status"], "WARN")
            self.assertEqual(report["funnel"]["trade_decisions"], 1)
            self.assertEqual(report["execution_quality"]["adapter_mismatch_count"], 1)
            self.assertEqual(report["llm"]["tokens"]["total"], 15)
            self.assertEqual(report["pnl"]["realized_pnl"], "3")
            self.assertTrue((report_dir / "simulation-report.json").exists())
            self.assertTrue((report_dir / "trade-pnl.csv").exists())
