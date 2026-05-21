from __future__ import annotations

import io
import json
import sys
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace

import yaml

from app.trading.discovery.replay_tape import (
    build_source_query_digest,
    materialize_signal_tape,
)
from app.trading.models import SignalEnvelope
import scripts.search_consistent_profitability_frontier as frontier


class TestSearchConsistentProfitabilityFrontier(TestCase):
    def test_candidate_replay_lineage_payload_hashes_window_coverage(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_configmap = root / "candidate.yaml"
            candidate_configmap.write_text("data:\n  strategies.yaml: '{}'\n")
            replay_payload = self._payload(
                start_date="2026-03-18",
                end_date="2026-03-19",
                daily_net={"2026-03-18": "100", "2026-03-19": "150"},
                decision_count=2,
                filled_count=2,
                wins=2,
                losses=0,
            )
            window = frontier.FrontierReplayWindows(
                train_days=(date(2026, 3, 18),),
                holdout_days=(date(2026, 3, 19),),
                second_oos_days=(),
            )

            lineage = frontier._candidate_replay_lineage_payload(
                candidate_configmap_path=candidate_configmap,
                candidate_search_key="candidate-key",
                dataset_snapshot_id="snapshot-lineage",
                train_payload=replay_payload,
                holdout_payload=replay_payload,
                full_window_payload=replay_payload,
                second_oos_payload=None,
                window=window,
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 19),
                holdout_replay_skipped=False,
                full_window_replay_skipped=False,
            )

        coverage = frontier._replay_window_coverage_payload(lineage)
        self.assertEqual(
            lineage["schema_version"], "torghut.frontier-replay-lineage.v1"
        )
        self.assertEqual(lineage["missing_windows"], [])
        self.assertEqual(
            lineage["present_windows"], ["train", "holdout", "full_window"]
        )
        self.assertTrue(lineage["lineage_hash"])
        self.assertEqual(
            len(lineage["windows"]["full_window"]["daily_filled_notional_sha256"]),
            64,
        )
        self.assertEqual(
            len(lineage["windows"]["full_window"]["daily_liquidity_notional_sha256"]),
            64,
        )
        self.assertEqual(coverage["lineage_hash"], lineage["lineage_hash"])
        self.assertEqual(coverage["window_count"], 3)

    def test_parse_args_supports_harness_v2_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = root / "strategies.yaml"
            sweep_config = root / "sweep.yaml"
            family_dir = root / "families"
            strategy_configmap.write_text(
                "apiVersion: v1\nkind: ConfigMap\n", encoding="utf-8"
            )
            sweep_config.write_text(
                "family: breakout_reclaim\nstrategy_name: intraday-tsmom-profit-v3\n",
                encoding="utf-8",
            )
            family_dir.mkdir()
            with patch.object(
                sys,
                "argv",
                [
                    "prog",
                    "--strategy-configmap",
                    str(strategy_configmap),
                    "--sweep-config",
                    str(sweep_config),
                    "--expected-last-trading-day",
                    "2026-04-07",
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--allow-stale-tape",
                    "--replay-tape-path",
                    str(root / "tape.jsonl"),
                    "--replay-tape-manifest",
                    str(root / "tape.jsonl.manifest.json"),
                    "--family-template-dir",
                    str(family_dir),
                    "--max-candidates-to-evaluate",
                    "12",
                    "--candidate-record",
                    str(root / "candidate.json"),
                    "--no-train-screening",
                    "--min-train-screen-net-per-day",
                    "-50",
                    "--min-train-screen-active-ratio",
                    "0.25",
                    "--max-train-screen-worst-day-loss",
                    "125",
                    "--second-oos-days",
                    "2",
                    "--collect-train-gate-diagnostics",
                ],
            ):
                args = frontier._parse_args()

        self.assertEqual(args.expected_last_trading_day, "2026-04-07")
        self.assertEqual(args.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertTrue(args.allow_stale_tape)
        self.assertEqual(args.replay_tape_path, root / "tape.jsonl")
        self.assertEqual(args.replay_tape_manifest, root / "tape.jsonl.manifest.json")
        self.assertEqual(args.family_template_dir, family_dir)
        self.assertEqual(args.max_candidates_to_evaluate, 12)
        self.assertEqual(args.candidate_record, [root / "candidate.json"])
        self.assertFalse(args.train_screening)
        self.assertEqual(args.min_train_screen_net_per_day, "-50")
        self.assertEqual(args.min_train_screen_active_ratio, "0.25")
        self.assertEqual(args.max_train_screen_worst_day_loss, "125")
        self.assertEqual(args.second_oos_days, 2)
        self.assertTrue(args.collect_train_gate_diagnostics)

    def test_load_replay_tape_rows_validates_and_slices_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "frontier-tape.jsonl"
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 18, 17, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Sec",
                        seq=1,
                        source="ta",
                        payload={"price": Decimal("900.00")},
                    ),
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 19, 17, 30, tzinfo=timezone.utc),
                        symbol="META",
                        timeframe="1Sec",
                        seq=2,
                        source="ta",
                        payload={"price": Decimal("500.00")},
                    ),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-frontier",
                symbols=("NVDA", "META"),
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 19),
                source_query_digest=build_source_query_digest({"query": "frontier"}),
            )

            rows, validation = frontier._load_replay_tape_rows(
                tape_path=tape_path,
                manifest_path=None,
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 18),
                symbols=("NVDA",),
                allow_stale_tape=False,
            )

        self.assertEqual([row.symbol for row in rows], ["NVDA"])
        self.assertEqual(validation["status"], "valid")
        self.assertEqual(validation["selected_row_count"], 1)
        self.assertEqual(validation["selected_symbols"], ["NVDA"])
        self.assertEqual(
            validation["source_query_digest"], build_source_query_digest({"query": "frontier"})
        )
        self.assertEqual(validation["manifest_path"], "")

    def test_clickhouse_password_env_resolution_keeps_secret_out_of_argv(self) -> None:
        with patch.dict("os.environ", {"TORGHUT_CLICKHOUSE_PASSWORD": "from-env"}):
            resolved = frontier._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="",
                    clickhouse_password_env="TORGHUT_CLICKHOUSE_PASSWORD",
                )
            )
            direct = frontier._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="direct",
                    clickhouse_password_env="TORGHUT_CLICKHOUSE_PASSWORD",
                )
            )

        self.assertEqual(resolved, "from-env")
        self.assertEqual(direct, "direct")

    def test_rolling_lower_bound_handles_empty_and_short_windows(self) -> None:
        self.assertEqual(frontier._rolling_lower_bound({}, window=3), Decimal("0"))
        self.assertEqual(
            frontier._rolling_lower_bound(
                {"2026-04-03": Decimal("30"), "2026-04-04": Decimal("60")},
                window=5,
            ),
            Decimal("45"),
        )

    def test_selected_normalization_regime_prefers_override(self) -> None:
        self.assertEqual(
            frontier._selected_normalization_regime(
                strategy_overrides={"normalization_regime": "matched_filter"},
                template_allowed_normalizations=("trading_value_scaled",),
            ),
            "matched_filter",
        )

    def test_candidate_search_key_ignores_local_only_overrides(self) -> None:
        left = frontier._candidate_search_key(
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "universe_symbols": ["NVDA", "AMAT"],
                "normalization_regime": "price_scaled",
            },
        )
        right = frontier._candidate_search_key(
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "universe_symbols": ["NVDA", "AMAT"],
                "normalization_regime": "matched_filter",
            },
        )

        self.assertEqual(left, right)

    def test_candidate_evaluation_key_binds_replay_and_cost_proof_context(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_configmap = root / "candidate.yaml"
            candidate_configmap.write_text("data:\n  strategies.yaml: '{}'\n")
            replay_payload = self._payload(
                start_date="2026-03-18",
                end_date="2026-03-19",
                daily_net={"2026-03-18": "100", "2026-03-19": "150"},
                decision_count=2,
                filled_count=2,
                wins=2,
                losses=0,
            )
            window = frontier.FrontierReplayWindows(
                train_days=(date(2026, 3, 18),),
                holdout_days=(date(2026, 3, 19),),
                second_oos_days=(),
            )
            lineage = frontier._candidate_replay_lineage_payload(
                candidate_configmap_path=candidate_configmap,
                candidate_search_key="candidate-key",
                dataset_snapshot_id="snapshot-lineage",
                train_payload=replay_payload,
                holdout_payload=replay_payload,
                full_window_payload=replay_payload,
                second_oos_payload=None,
                window=window,
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 19),
                holdout_replay_skipped=False,
                full_window_replay_skipped=False,
            )

        base = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v1",
                "market_impact_stress_cost_bps": "8",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )
        changed_tape = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "different-tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v1",
                "market_impact_stress_cost_bps": "8",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )
        changed_cost = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v2",
                "market_impact_stress_cost_bps": "12",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )

        self.assertEqual(base["schema_version"], "torghut.candidate-evaluation-key.v1")
        self.assertEqual(base["replay_tape"]["source_query_digest"], "query-sha")
        self.assertEqual(
            base["effective_strategy_config_sha256"],
            lineage["candidate_configmap_sha256"],
        )
        self.assertNotEqual(
            base["candidate_evaluation_key"],
            changed_tape["candidate_evaluation_key"],
        )
        self.assertNotEqual(
            base["candidate_evaluation_key"],
            changed_cost["candidate_evaluation_key"],
        )

    def test_parameter_grid_items_rejects_non_iterable_shapes(self) -> None:
        with self.assertRaisesRegex(ValueError, "parameter_values_not_sequence:alpha"):
            frontier._parameter_grid_items({"alpha": "1"})
        with self.assertRaisesRegex(ValueError, "parameter_values_not_sequence:alpha"):
            frontier._parameter_grid_items({"alpha": {"nested": "1"}})
        with self.assertRaisesRegex(ValueError, "parameter_values_not_iterable:alpha"):
            frontier._parameter_grid_items({"alpha": 1})

    def test_candidate_record_seed_extracts_exact_strategy_candidate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "candidate.json"
            path.write_text(
                json.dumps(
                    {
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "candidate_strategy": {
                            "strategy_name": "intraday-tsmom-profit-v3",
                            "universe_symbols": ["NVDA", "AAPL"],
                            "max_notional_per_trade": "50000",
                            "max_position_pct_equity": "3.0",
                            "params": {
                                "entry_start_minute_utc": "810",
                                "entry_end_minute_utc": "930",
                                "max_spread_bps": "20",
                                "min_recent_imbalance_pressure": "0.02",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            params, overrides = frontier._candidate_record_seed(
                path=path,
                strategy_name="intraday-tsmom-profit-v3",
            )

        self.assertEqual(
            params,
            {
                "entry_start_minute_utc": "810",
                "entry_end_minute_utc": "930",
                "max_spread_bps": "20",
                "min_recent_imbalance_pressure": "0.02",
            },
        )
        self.assertEqual(
            overrides,
            {
                "universe_symbols": ["NVDA", "AAPL"],
                "max_notional_per_trade": "50000",
                "max_position_pct_equity": "3.0",
            },
        )

    def test_initial_worklist_yields_candidate_record_seeds_before_grid(self) -> None:
        candidates = frontier._iter_initial_worklist_candidates(
            parameter_grid={"long_stop_loss_bps": ["10"]},
            override_candidates=[{"max_notional_per_trade": "63180"}],
            seed_candidates=[
                (
                    {"entry_start_minute_utc": "810"},
                    {"max_notional_per_trade": "50000"},
                )
            ],
        )

        first = next(candidates)
        second = next(candidates)

        self.assertEqual(first[0], {"entry_start_minute_utc": "810"})
        self.assertEqual(first[1], {"max_notional_per_trade": "50000"})
        self.assertEqual(second[0], {"long_stop_loss_bps": "10"})
        self.assertEqual(second[1], {"max_notional_per_trade": "63180"})

    def test_candidate_symbols_prefers_cli_filter_then_universe_override(self) -> None:
        self.assertEqual(
            frontier._candidate_symbols(
                cli_symbols=("META",),
                strategy_overrides={"universe_symbols": ["NVDA", "AMAT"]},
            ),
            ("META",),
        )
        self.assertEqual(
            frontier._candidate_symbols(
                cli_symbols=(),
                strategy_overrides={"universe_symbols": ["nvda", " amat "]},
            ),
            ("NVDA", "AMAT"),
        )

    @staticmethod
    def _payload(
        *,
        start_date: str,
        end_date: str,
        daily_net: dict[str, str],
        daily_filled_notional: dict[str, str] | None = None,
        daily_liquidity_notional: dict[str, str] | None = None,
        decision_count: int,
        filled_count: int,
        wins: int,
        losses: int,
    ) -> dict[str, object]:
        return {
            "start_date": start_date,
            "end_date": end_date,
            "net_pnl": str(sum(float(value) for value in daily_net.values())),
            "decision_count": decision_count,
            "filled_count": filled_count,
            "wins": wins,
            "losses": losses,
            "daily": {
                day: {
                    "net_pnl": value,
                    "filled_count": 1 if float(value) != 0 else 0,
                    "filled_notional": (
                        daily_filled_notional[day]
                        if daily_filled_notional is not None
                        and day in daily_filled_notional
                        else ("1000" if float(value) != 0 else "0")
                    ),
                    "daily_adv_notional": daily_liquidity_notional[day]
                    if daily_liquidity_notional is not None
                    and day in daily_liquidity_notional
                    else None,
                }
                for day, value in daily_net.items()
            },
        }

    def test_resolve_full_window_rejects_inverted_explicit_dates(self) -> None:
        with self.assertRaisesRegex(ValueError, "full_window_invalid_range"):
            frontier._resolve_full_window(
                args=Namespace(
                    full_window_start_date="2026-04-03",
                    full_window_end_date="2026-04-02",
                ),
                train_days=(date(2026, 4, 1),),
                holdout_days=(date(2026, 4, 2),),
            )

    def test_max_best_day_share_returns_zero_when_positive_total_has_no_positive_day(
        self,
    ) -> None:
        self.assertEqual(
            frontier._max_best_day_share_of_total_pnl(
                daily_net={"2026-04-01": Decimal("-10")},
                total_net_pnl=Decimal("100"),
            ),
            Decimal("0"),
        )

    def test_consistency_penalty_penalizes_excess_negative_days(self) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-03",
                daily_net={
                    "2026-04-01": "-20",
                    "2026-04-02": "-30",
                    "2026-04-03": "200",
                },
                decision_count=3,
                filled_count=3,
                wins=1,
                losses=2,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("10"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=1,
                min_active_ratio=Decimal("0"),
                min_positive_days=1,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=0,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
        )

        self.assertGreaterEqual(penalties, Decimal("600"))
        self.assertEqual(summary["negative_days"], 2)

    def test_consistency_penalty_preserves_order_type_execution_metrics(self) -> None:
        payload = self._payload(
            start_date="2026-04-01",
            end_date="2026-04-02",
            daily_net={"2026-04-01": "120", "2026-04-02": "80"},
            decision_count=4,
            filled_count=3,
            wins=2,
            losses=0,
        )
        payload["decision_count_by_order_type"] = {"market": 2, "limit": 2}
        payload["filled_count_by_order_type"] = {"market": 2, "limit": 1}
        payload["limit_fill_rate"] = "0.50"

        _, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("10"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=1,
                min_active_ratio=Decimal("0"),
                min_positive_days=1,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=2,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
        )

        self.assertEqual(
            summary["decision_count_by_order_type"], {"market": 2, "limit": 2}
        )
        self.assertEqual(
            summary["filled_count_by_order_type"], {"market": 2, "limit": 1}
        )
        self.assertEqual(summary["limit_fill_rate"], "0.50")
        self.assertEqual(summary["market_limit_order_mix_sample_count"], 4)
        self.assertEqual(summary["limit_fill_probability_sample_count"], 2)
        self.assertTrue(summary["market_limit_order_mix_evidence_present"])
        self.assertTrue(summary["limit_fill_probability_evidence_present"])

    def test_run_frontier_writes_paired_order_type_ablation_artifact(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": False,
                        },
                        "order_type_ablation": {
                            "enabled": True,
                            "max_candidates": 1,
                            "min_sample_count": 4,
                            "max_opportunity_cost_bps": "8",
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["18"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-ablation",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-ablation",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            forced_order_types: list[str] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                entry_order_type = str(
                    strategy.get("params", {}).get("entry_order_type") or "default"
                )
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                full_window = start_date == "2026-03-18" and end_date == "2026-03-23"
                if full_window and entry_order_type in {"market", "limit"}:
                    forced_order_types.append(entry_order_type)
                    daily_net = (
                        {
                            "2026-03-18": "120",
                            "2026-03-19": "120",
                            "2026-03-20": "120",
                            "2026-03-21": "120",
                            "2026-03-22": "120",
                            "2026-03-23": "120",
                        }
                        if entry_order_type == "market"
                        else {
                            "2026-03-18": "110",
                            "2026-03-19": "110",
                            "2026-03-20": "110",
                            "2026-03-21": "110",
                            "2026-03-22": "110",
                            "2026-03-23": "110",
                        }
                    )
                    replay_payload = self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net=daily_net,
                        daily_filled_notional={day: "20000" for day in daily_net},
                        decision_count=6,
                        filled_count=6 if entry_order_type == "market" else 5,
                        wins=6,
                        losses=0,
                    )
                    replay_payload["decision_count_by_order_type"] = {
                        entry_order_type: 6
                    }
                    replay_payload["filled_count_by_order_type"] = {
                        entry_order_type: 6 if entry_order_type == "market" else 5
                    }
                    if entry_order_type == "limit":
                        replay_payload["limit_fill_rate"] = "0.83"
                    return replay_payload

                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    daily_net = {
                        "2026-03-18": "105",
                        "2026-03-19": "110",
                        "2026-03-20": "115",
                    }
                elif start_date == "2026-03-21" and end_date == "2026-03-23":
                    daily_net = {
                        "2026-03-21": "125",
                        "2026-03-22": "130",
                        "2026-03-23": "135",
                    }
                else:
                    daily_net = {
                        "2026-03-18": "105",
                        "2026-03-19": "110",
                        "2026-03-20": "115",
                        "2026-03-21": "125",
                        "2026-03-22": "130",
                        "2026-03-23": "135",
                    }
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=6,
                    filled_count=6,
                    wins=6,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(forced_order_types, ["market", "limit"])
            scorecard = payload["top"][0]["objective_scorecard"]
            artifact_ref = Path(scorecard["order_type_ablation_artifact_ref"])
            self.assertTrue(artifact_ref.exists())
            self.assertEqual(scorecard["order_type_ablation_sample_count"], 12)
            self.assertTrue(scorecard["order_type_ablation_passed"])
            self.assertEqual(
                scorecard["order_type_ablation_selected_order_type"], "market"
            )
            self.assertNotIn("route_tca_artifact_ref", scorecard)
            self.assertNotIn("price_improvement_evidence_present", scorecard)
            self.assertNotIn("execution_shortfall_evidence_present", scorecard)
            artifact = json.loads(artifact_ref.read_text(encoding="utf-8"))
            self.assertEqual(
                artifact["schema_version"], "torghut.order-type-ablation.v1"
            )
            self.assertEqual(artifact["selected_order_type"], "market")
            self.assertEqual(artifact["alternative_order_type"], "limit")
            self.assertEqual(artifact["market"]["sample_count"], 6)
            self.assertEqual(artifact["limit"]["sample_count"], 6)
            self.assertEqual(len(artifact["market"]["payload_sha256"]), 64)
            self.assertEqual(len(artifact["limit"]["payload_sha256"]), 64)
            self.assertEqual(
                payload["top"][0]["order_type_ablation"]["artifact_ref"],
                str(artifact_ref),
            )

    def test_train_screen_failures_reports_worst_day_loss(self) -> None:
        failures = frontier._train_screen_failures(
            train_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-02",
                daily_net={"2026-04-01": "-125", "2026-04-02": "200"},
                decision_count=2,
                filled_count=2,
                wins=1,
                losses=1,
            ),
            holdout_policy=frontier.ProfitabilityConstraintPolicy(
                holdout_target_net_per_day=Decimal("0"),
                min_active_holdout_days=0,
                max_worst_holdout_day_loss=Decimal("1000"),
                min_profit_factor=Decimal("0"),
                require_training_decisions=True,
                require_holdout_decisions=False,
            ),
            consistency_policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("0"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=1,
                min_active_ratio=Decimal("0"),
                min_positive_days=1,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=1,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
            min_train_net_per_day=Decimal("-1000"),
            min_train_active_ratio=Decimal("0"),
            max_train_worst_day_loss=Decimal("100"),
        )

        self.assertIn("train_worst_day_loss_above_screen", failures)

    def _write_strategy_configmap(self, root: Path) -> Path:
        path = root / "strategy-configmap.yaml"
        path.write_text(
            yaml.safe_dump(
                {
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "data": {
                        "strategies.yaml": yaml.safe_dump(
                            {
                                "strategies": [
                                    {
                                        "name": "intraday-tsmom-profit-v3",
                                        "enabled": True,
                                        "max_notional_per_trade": "25000",
                                        "max_position_pct_equity": "2.0",
                                        "universe_symbols": ["NVDA", "AMAT", "AMD"],
                                        "params": {
                                            "min_cross_section_continuation_rank": "0.60",
                                            "long_stop_loss_bps": "18",
                                        },
                                    },
                                    {
                                        "name": "late-day-continuation-long-v1",
                                        "enabled": True,
                                        "params": {
                                            "min_recent_microprice_bias_bps": "0.20"
                                        },
                                    },
                                ]
                            },
                            sort_keys=False,
                        )
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    def _write_sweep_config(self, root: Path) -> Path:
        path = root / "sweep.yaml"
        path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "intraday_tsmom_consistent",
                    "strategy_name": "intraday-tsmom-profit-v3",
                    "disable_other_strategies": True,
                    "constraints": {
                        "holdout_target_net_per_day": "200",
                        "min_active_holdout_days": 2,
                        "max_worst_holdout_day_loss": "200",
                        "min_profit_factor": "1.1",
                    },
                    "consistency_constraints": {
                        "target_net_per_day": "200",
                        "min_active_days": 6,
                        "max_worst_day_loss": "250",
                        "max_negative_days": 1,
                        "max_drawdown": "300",
                        "require_every_day_active": True,
                    },
                    "strategy_overrides": {
                        "universe_symbols": [["NVDA"], ["NVDA", "AMAT"]],
                        "max_notional_per_trade": ["15000"],
                    },
                    "parameters": {
                        "long_stop_loss_bps": ["12", "18"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    def _make_args(
        self, *, strategy_configmap: Path, sweep_config: Path, json_output: Path
    ) -> Namespace:
        return Namespace(
            strategy_configmap=strategy_configmap,
            sweep_config=sweep_config,
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols="",
            progress_log_seconds=30,
            train_days=3,
            holdout_days=3,
            second_oos_days=0,
            full_window_start_date="",
            full_window_end_date="",
            expected_last_trading_day="",
            allow_stale_tape=False,
            family_template_dir=Path(__file__).resolve().parents[1]
            / "config"
            / "trading"
            / "families",
            prefetch_full_window_rows=False,
            top_n=10,
            max_candidates_to_evaluate=0,
            json_output=json_output,
            symbol_prune_iterations=0,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            loss_repair_iterations=0,
            loss_repair_candidates=1,
            train_screening=True,
            min_train_screen_net_per_day="0",
            min_train_screen_active_ratio="0.50",
            max_train_screen_worst_day_loss="",
        )

    def test_resolve_frontier_replay_windows_keeps_second_oos_independent(
        self,
    ) -> None:
        days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(8))

        resolved = frontier._resolve_frontier_replay_windows(
            days,
            train_days=3,
            holdout_days=3,
            second_oos_days=2,
        )

        self.assertEqual(resolved.train_days, days[:3])
        self.assertEqual(resolved.holdout_days, days[3:6])
        self.assertEqual(resolved.second_oos_days, days[6:])
        self.assertEqual(resolved.expected_days, days)

    def test_strategy_universe_symbols_reads_target_strategy_universe(self) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "universe_symbols": ["nvda", " AMAT "],
                            },
                            {
                                "name": "other",
                                "universe_symbols": ["META"],
                            },
                        ]
                    },
                    sort_keys=False,
                )
            }
        }
        self.assertEqual(
            frontier._strategy_universe_symbols(
                configmap_payload=configmap_payload,
                strategy_name="intraday-tsmom-profit-v3",
            ),
            ("NVDA", "AMAT"),
        )

    def test_resolve_prefetch_symbols_uses_override_union_before_base_universe(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "universe_symbols": ["META"],
                            },
                        ]
                    },
                    sort_keys=False,
                )
            }
        }
        self.assertEqual(
            frontier._resolve_prefetch_symbols(
                cli_symbols=(),
                override_candidates=[
                    {"universe_symbols": ["nvda", "amat"]},
                    {"universe_symbols": ["AMAT", "amd"]},
                ],
                configmap_payload=configmap_payload,
                strategy_name="intraday-tsmom-profit-v3",
            ),
            ("NVDA", "AMAT", "AMD"),
        )

    def test_cached_iter_signal_rows_factory_filters_by_date_and_symbol_preserving_order(
        self,
    ) -> None:
        rows = [
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=2,
            ),
            SimpleNamespace(
                symbol="AMAT",
                event_ts=datetime(2026, 3, 23, 14, 0, 1, tzinfo=timezone.utc),
                seq=1,
            ),
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 24, 14, 0, tzinfo=timezone.utc),
                seq=3,
            ),
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        config = SimpleNamespace(
            symbols=("NVDA",),
            start_date=date(2026, 3, 23),
            end_date=date(2026, 3, 23),
        )
        filtered = list(iterator(config))
        self.assertEqual([item.symbol for item in filtered], ["NVDA"])
        self.assertEqual(filtered[0].seq, 2)

    def test_apply_candidate_to_configmap_with_overrides_updates_top_level_fields(
        self,
    ) -> None:
        configmap_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "enabled": False,
                                "max_notional_per_trade": "25000",
                                "params": {"long_stop_loss_bps": "18"},
                            },
                            {"name": "late-day", "enabled": True, "params": {}},
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = frontier.apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name="intraday-tsmom-profit-v3",
            candidate_params={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "universe_symbols": ["NVDA", "AMAT"],
                "max_notional_per_trade": "15000",
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategies = {item["name"]: item for item in catalog["strategies"]}
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["params"]["long_stop_loss_bps"],
            "12",
        )
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["params"]["position_isolation_mode"],
            "per_strategy",
        )
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["universe_symbols"],
            ["NVDA", "AMAT"],
        )
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["max_notional_per_trade"],
            "15000",
        )
        self.assertFalse(strategies["late-day"]["enabled"])

    def test_apply_candidate_to_configmap_with_overrides_skips_search_only_normalization_override(
        self,
    ) -> None:
        configmap_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "enabled": True,
                                "max_notional_per_trade": "25000",
                                "params": {"long_stop_loss_bps": "18"},
                            },
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = frontier.apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name="intraday-tsmom-profit-v3",
            candidate_params={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "opening_window_scaled",
                "universe_symbols": ["NVDA", "AMAT"],
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategy = catalog["strategies"][0]
        self.assertEqual(strategy["params"]["long_stop_loss_bps"], "12")
        self.assertEqual(strategy["universe_symbols"], ["NVDA", "AMAT"])
        self.assertNotIn("normalization_regime", strategy)

    def test_apply_candidate_to_configmap_with_overrides_validates_returned_catalog(
        self,
    ) -> None:
        base_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {"strategies": [{"name": "target", "enabled": True, "params": {}}]},
                    sort_keys=False,
                )
            },
        }

        invalid_returns = [
            ({"data": []}, "strategy_configmap_missing_data"),
            ({"data": {}}, "strategy_configmap_missing_strategies_yaml"),
            ({"data": {"strategies.yaml": "- bad\n"}}, "strategy_catalog_not_mapping"),
            (
                {"data": {"strategies.yaml": "strategies: {}\n"}},
                "strategy_catalog_missing_strategies",
            ),
        ]
        for returned, reason in invalid_returns:
            with self.subTest(reason=reason):
                with patch.object(
                    frontier, "apply_candidate_to_configmap", return_value=returned
                ):
                    with self.assertRaisesRegex(ValueError, reason):
                        frontier.apply_candidate_to_configmap_with_overrides(
                            configmap_payload=base_payload,
                            strategy_name="target",
                            candidate_params={},
                            strategy_overrides={"universe_symbols": ["NVDA"]},
                            disable_other_strategies=True,
                        )

        with self.assertRaisesRegex(
            ValueError, "strategy_override_key_reserved:params"
        ):
            frontier.apply_candidate_to_configmap_with_overrides(
                configmap_payload=base_payload,
                strategy_name="target",
                candidate_params={},
                strategy_overrides={"params": {"long_stop_loss_bps": "10"}},
                disable_other_strategies=True,
            )
        returned_other_strategy = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {"strategies": [{"name": "other", "params": {}}]},
                    sort_keys=False,
                )
            }
        }
        with patch.object(
            frontier,
            "apply_candidate_to_configmap",
            return_value=returned_other_strategy,
        ):
            with self.assertRaisesRegex(ValueError, "strategy_not_found:missing"):
                frontier.apply_candidate_to_configmap_with_overrides(
                    configmap_payload=base_payload,
                    strategy_name="missing",
                    candidate_params={},
                    strategy_overrides={"universe_symbols": ["NVDA"]},
                    disable_other_strategies=False,
                )

    def test_symbol_contributions_from_replay_payload_aggregates_downside_and_activity(
        self,
    ) -> None:
        payload = {
            "funnel": {
                "buckets": [
                    {
                        "trading_day": "2026-03-31",
                        "symbol": "AVGO",
                        "filled_count": 1,
                        "net_pnl": "-120",
                        "cost_total": "10",
                    },
                    {
                        "trading_day": "2026-04-01",
                        "symbol": "AVGO",
                        "filled_count": 1,
                        "net_pnl": "30",
                        "cost_total": "5",
                    },
                    {
                        "trading_day": "2026-04-01",
                        "symbol": "MSFT",
                        "filled_count": 1,
                        "net_pnl": "220",
                        "cost_total": "7",
                    },
                ]
            }
        }
        contributions = frontier._symbol_contributions_from_replay_payload(payload)
        self.assertEqual(list(contributions), ["AVGO", "MSFT"])
        self.assertEqual(contributions["AVGO"]["active_days"], 2)
        self.assertEqual(contributions["AVGO"]["negative_days"], 1)
        self.assertEqual(contributions["AVGO"]["net_pnl"], "-90")
        self.assertEqual(contributions["AVGO"]["downside_pnl"], "120")
        self.assertEqual(contributions["MSFT"]["contribution_score"], "220")

    def test_train_gate_diagnostics_from_replay_payload_summarizes_funnel(self) -> None:
        payload = {
            "decision_count": 0,
            "filled_count": 0,
            "funnel": {
                "buckets": [
                    {
                        "retained_rows": 10,
                        "runtime_evaluable_rows": 8,
                        "quote_valid_rows": 9,
                        "strategy_evaluations": 8,
                        "passed_trace_count": 1,
                        "gate_pass_counts": {"short:eligibility": 8},
                        "first_failed_gate_counts": {"short:confirmation": 5},
                        "failing_threshold_counts": {
                            "short:confirmation:imbalance_pressure": 5,
                        },
                    },
                    {
                        "retained_rows": 4,
                        "runtime_evaluable_rows": 3,
                        "quote_valid_rows": 3,
                        "strategy_evaluations": 3,
                        "passed_trace_count": 0,
                        "first_failed_gate_counts": {"short:structure": 3},
                        "failing_threshold_counts": {"short:structure:rsi14": 3},
                    },
                ]
            },
            "near_misses": [
                {
                    "trading_day": "2026-05-01",
                    "symbol": "AAPL",
                    "strategy_type": "short",
                    "event_ts": "2026-05-01T15:00:00+00:00",
                    "first_failed_gate": "confirmation",
                    "distance_score": "0.02",
                    "thresholds": [
                        {
                            "metric": "imbalance_pressure",
                            "value": "0.01",
                            "threshold": "0.00",
                            "distance_to_pass": "0.01",
                        }
                    ],
                }
            ],
        }

        diagnostics = frontier._train_gate_diagnostics_from_replay_payload(payload)

        self.assertEqual(diagnostics["status"], "available")
        self.assertEqual(diagnostics["aggregate"]["strategy_evaluations"], 11)
        self.assertEqual(
            diagnostics["top_first_failed_gates"][0],
            {"key": "short:confirmation", "count": 5},
        )
        self.assertEqual(
            diagnostics["top_failing_thresholds"][0],
            {"key": "short:confirmation:imbalance_pressure", "count": 5},
        )
        self.assertEqual(
            diagnostics["near_misses"][0]["thresholds"][0]["metric"],
            "imbalance_pressure",
        )

    def test_train_gate_diagnostics_from_replay_payload_ignores_malformed_items(
        self,
    ) -> None:
        payload = {
            "decision_count": 1,
            "filled_count": 0,
            "funnel": {
                "buckets": [
                    "not-a-bucket",
                    {
                        "retained_rows": "bad-count",
                        "runtime_evaluable_rows": "2",
                        "quote_valid_rows": "2",
                        "strategy_evaluations": "2",
                        "passed_trace_count": "0",
                        "gate_pass_counts": {"short:structure": "2"},
                        "first_failed_gate_counts": {
                            "short:confirmation": "bad-count",
                            "short:structure": "1",
                        },
                    },
                ]
            },
            "near_misses": [
                {
                    "trading_day": "2026-05-01",
                    "symbol": "AAPL",
                    "strategy_type": "short",
                    "event_ts": "2026-05-01T15:00:00+00:00",
                    "first_failed_gate": "confirmation",
                    "distance_score": "0.02",
                    "thresholds": [
                        "not-a-threshold",
                        {
                            "metric": "rsi14",
                            "value": "72",
                            "threshold": "70",
                            "distance_to_pass": "2",
                        },
                    ],
                }
            ],
        }

        diagnostics = frontier._train_gate_diagnostics_from_replay_payload(payload)

        self.assertEqual(diagnostics["aggregate"]["retained_rows"], 0)
        self.assertEqual(diagnostics["aggregate"]["runtime_evaluable_rows"], 2)
        self.assertEqual(
            diagnostics["top_first_failed_gates"],
            [{"key": "short:structure", "count": 1}],
        )
        self.assertEqual(
            diagnostics["near_misses"][0]["thresholds"],
            [
                {
                    "metric": "rsi14",
                    "value": "72",
                    "threshold": "70",
                    "distance_to_pass": "2",
                }
            ],
        )

    def test_generate_symbol_prune_children_removes_worst_symbols_from_universe(
        self,
    ) -> None:
        children = frontier._generate_symbol_prune_children(
            cli_symbols=(),
            strategy_overrides={"universe_symbols": ["NVDA", "AVGO", "MSFT"]},
            configmap_payload={},
            strategy_name="intraday-tsmom-profit-v3",
            symbol_contributions={
                "AVGO": {"contribution_score": "-200", "net_pnl": "-100"},
                "NVDA": {"contribution_score": "-50", "net_pnl": "10"},
                "MSFT": {"contribution_score": "100", "net_pnl": "120"},
            },
            branch_count=2,
            min_universe_size=2,
        )
        self.assertEqual(children[0][0], "AVGO")
        self.assertEqual(children[0][1]["universe_symbols"], ["NVDA", "MSFT"])
        self.assertEqual(children[1][0], "NVDA")
        self.assertEqual(children[1][1]["universe_symbols"], ["AVGO", "MSFT"])

    def test_generate_loss_repair_children_tightens_controls_and_exposure(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "max_notional_per_trade": "20000",
                                "max_position_pct_equity": "0.50",
                                "params": {
                                    "long_stop_loss_bps": "12",
                                    "long_trailing_stop_drawdown_bps": "4",
                                    "max_session_negative_exit_bps": "12",
                                    "max_stop_loss_exits_per_session": "2",
                                    "stop_loss_lockout_seconds": "1200",
                                    "negative_exit_lockout_seconds": "900",
                                    "max_gross_exposure_pct_equity": "1.0",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_loss_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="intraday-tsmom-profit-v3",
            hard_vetoes=["worst_day_loss_above_max"],
            full_window_summary={},
            branch_count=2,
        )

        self.assertEqual(
            children[0][0], "loss_controls_and_exposure:worst_day_loss_above_max"
        )
        repaired_params = children[0][1]
        repaired_overrides = children[0][2]
        self.assertEqual(repaired_params["long_stop_loss_bps"], "9")
        self.assertEqual(repaired_params["long_trailing_stop_drawdown_bps"], "3")
        self.assertEqual(repaired_params["max_session_negative_exit_bps"], "9")
        self.assertEqual(repaired_params["max_stop_loss_exits_per_session"], "1")
        self.assertEqual(repaired_params["stop_loss_lockout_seconds"], "2400")
        self.assertEqual(repaired_params["negative_exit_lockout_seconds"], "1800")
        self.assertEqual(repaired_params["max_gross_exposure_pct_equity"], "0.75")
        self.assertEqual(repaired_overrides["max_notional_per_trade"], "15000")
        self.assertEqual(repaired_overrides["max_position_pct_equity"], "0.375")

    def test_generate_loss_repair_children_ignores_non_loss_vetoes(self) -> None:
        children = frontier._generate_loss_repair_children(
            params_candidate={"entry_cooldown_seconds": "300"},
            strategy_overrides={},
            candidate_configmap={},
            strategy_name="intraday-tsmom-profit-v3",
            hard_vetoes=["active_day_ratio_below_min"],
            full_window_summary={},
            branch_count=2,
        )

        self.assertEqual(children, [])

    def test_loss_repair_configmap_lookup_handles_invalid_shapes(self) -> None:
        invalid_payloads = [
            {"not_data": {}},
            {"data": {"strategies.yaml": {"not": "yaml"}}},
            {"data": {"strategies.yaml": "[]"}},
            {"data": {"strategies.yaml": "strategies: {}\n"}},
            {
                "data": {
                    "strategies.yaml": yaml.safe_dump(
                        {
                            "strategies": [
                                "not-a-strategy",
                                {"name": "other-strategy", "params": {"stop": "1"}},
                            ]
                        }
                    )
                }
            },
        ]

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                item, params = frontier._strategy_item_from_configmap(
                    configmap_payload=payload,
                    strategy_name="intraday-tsmom-profit-v3",
                )
                self.assertEqual(item, {})
                self.assertEqual(params, {})

    def test_loss_repair_decimal_helpers_reject_invalid_or_non_reducing_values(
        self,
    ) -> None:
        self.assertIsNone(frontier._decimal_or_none(None))
        self.assertIsNone(frontier._decimal_or_none(" "))
        self.assertIsNone(frontier._decimal_or_none("not-a-decimal"))
        self.assertIsNone(
            frontier._tightened_bps("0", floor=Decimal("4")),
        )
        self.assertIsNone(
            frontier._tightened_bps("4", floor=Decimal("4")),
        )
        self.assertIsNone(frontier._reduced_exposure("0"))
        self.assertIsNone(frontier._reduced_exposure("0.0000001"))

    def test_loss_repair_trigger_reason_accepts_suffix_and_daily_summary(
        self,
    ) -> None:
        self.assertEqual(
            frontier._loss_repair_trigger_reason(
                hard_vetoes=["second_oos_worst_day_loss_above_max"],
                full_window_summary={},
            ),
            "second_oos_worst_day_loss_above_max",
        )
        self.assertEqual(
            frontier._loss_repair_trigger_reason(
                hard_vetoes=[],
                full_window_summary={"daily_net_below_min_count": "2"},
            ),
            "daily_net_below_min",
        )
        self.assertIsNone(
            frontier._loss_repair_trigger_reason(
                hard_vetoes=[],
                full_window_summary={"daily_net_below_min_count": "bad"},
            )
        )

    def test_loss_repair_tightening_skips_absent_or_non_reducible_controls(
        self,
    ) -> None:
        params = {
            "long_stop_loss_bps": "0",
            "max_stop_loss_exits_per_session": "1",
            "stop_loss_lockout_seconds": "-1",
        }

        changed = frontier._apply_loss_control_tightening(
            params=params,
            strategy_params={},
        )

        self.assertFalse(changed)
        self.assertEqual(
            params,
            {
                "long_stop_loss_bps": "0",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "-1",
            },
        )

    def test_loss_repair_exposure_clamp_skips_absent_exposure_controls(
        self,
    ) -> None:
        params: dict[str, object] = {}
        overrides: dict[str, object] = {}

        changed = frontier._apply_exposure_clamp(
            params=params,
            overrides=overrides,
            strategy_item={},
            strategy_params={},
        )

        self.assertFalse(changed)
        self.assertEqual(params, {})
        self.assertEqual(overrides, {})

    def test_generate_loss_repair_children_drops_noop_and_duplicate_children(
        self,
    ) -> None:
        noop_children = frontier._generate_loss_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap={
                "data": {
                    "strategies.yaml": yaml.safe_dump(
                        {"strategies": [{"name": "intraday-tsmom-profit-v3"}]}
                    )
                }
            },
            strategy_name="intraday-tsmom-profit-v3",
            hard_vetoes=["max_drawdown_above_max"],
            full_window_summary={},
            branch_count=3,
        )
        self.assertEqual(noop_children, [])

        duplicate_children = frontier._generate_loss_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap={
                "data": {
                    "strategies.yaml": yaml.safe_dump(
                        {
                            "strategies": [
                                {
                                    "name": "intraday-tsmom-profit-v3",
                                    "params": {"long_stop_loss_bps": "12"},
                                }
                            ]
                        }
                    )
                }
            },
            strategy_name="intraday-tsmom-profit-v3",
            hard_vetoes=["max_drawdown_above_max"],
            full_window_summary={},
            branch_count=3,
        )

        self.assertEqual(len(duplicate_children), 1)
        self.assertEqual(
            duplicate_children[0][0],
            "loss_controls_and_exposure:max_drawdown_above_max",
        )
        self.assertEqual(duplicate_children[0][1], {"long_stop_loss_bps": "9"})
        self.assertEqual(duplicate_children[0][2], {})

    def test_consistency_penalty_rejects_lucky_strike_and_low_notional_profile(
        self,
    ) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-04-02",
                daily_net={
                    "2026-03-24": "0",
                    "2026-03-25": "0",
                    "2026-03-26": "0",
                    "2026-03-27": "0",
                    "2026-03-30": "0",
                    "2026-03-31": "-150",
                    "2026-04-01": "-100",
                    "2026-04-02": "2650",
                },
                daily_filled_notional={
                    "2026-03-24": "0",
                    "2026-03-25": "0",
                    "2026-03-26": "0",
                    "2026-03-27": "0",
                    "2026-03-30": "0",
                    "2026-03-31": "40000",
                    "2026-04-01": "50000",
                    "2026-04-02": "60000",
                },
                daily_liquidity_notional={
                    "2026-03-31": "1000000",
                    "2026-04-01": "1250000",
                    "2026-04-02": "1500000",
                },
                decision_count=3,
                filled_count=3,
                wins=1,
                losses=2,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("300"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=6,
                min_active_ratio=frontier.Decimal("0.75"),
                min_positive_days=4,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=2,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.55"),
                min_avg_filled_notional_per_day=frontier.Decimal("150000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("200000"),
                require_every_day_active=False,
            ),
        )

        self.assertGreater(penalties, frontier.Decimal("0"))
        self.assertEqual(summary["active_days"], 3)
        self.assertEqual(summary["positive_days"], 1)
        self.assertEqual(
            summary["best_day_share_of_total_pnl"], "1.104166666666666666666666667"
        )
        self.assertEqual(summary["avg_filled_notional_per_day"], "18750")
        self.assertTrue(summary["market_impact_liquidity_evidence_present"])
        self.assertEqual(summary["market_impact_liquidity_day_count"], 3)
        self.assertEqual(summary["market_impact_liquidity_missing_day_count"], 5)
        self.assertEqual(summary["avg_liquidity_notional_per_day"], "468750")
        self.assertEqual(summary["market_impact_stress_model"], "square_root")
        self.assertEqual(summary["market_impact_stress_cost_bps"], "20.0")
        self.assertEqual(summary["market_impact_stress_net_pnl_per_day"], "262.5")
        self.assertTrue(summary["implementation_uncertainty_required"])
        self.assertEqual(
            summary["implementation_uncertainty_model"],
            "impact_latency_cost_model_interval",
        )
        self.assertEqual(summary["implementation_uncertainty_model_count"], 5)
        self.assertIn(
            "impact_decay_reversion_1_5x",
            summary["implementation_uncertainty_scenarios"],
        )
        self.assertEqual(
            summary["market_impact_stress_components"]["source_marker"],
            "realistic_market_impact_arxiv_2603_29086_2026",
        )
        self.assertEqual(
            summary["market_impact_stress_components"]["almgren_chriss_cost_bps"],
            "10.00",
        )
        self.assertTrue(summary["market_impact_stress_passed"])
        self.assertEqual(
            summary["delay_adjusted_depth_stress_model"], "latency_depth_haircut"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_fillable_notional_per_day"], "18750"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_latency_grid_ms"], ["50", "150", "250"]
        )
        self.assertEqual(summary["delay_adjusted_depth_grid_max_stress_ms"], "250")
        self.assertEqual(
            summary["delay_adjusted_depth_worst_active_day_fillable_notional"],
            "40000",
        )
        self.assertEqual(
            summary["delay_adjusted_depth_p10_active_day_fillable_notional"],
            "40000",
        )
        self.assertTrue(summary["delay_adjusted_depth_tail_coverage_passed"])
        self.assertTrue(summary["delay_adjusted_depth_liquidity_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_liquidity_missing_day_count"], 0)
        self.assertEqual(summary["delay_adjusted_depth_fillable_ratio"], "1")
        self.assertEqual(
            summary["delay_adjusted_depth_unfillable_notional_per_day"], "0"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_stress_net_pnl_per_day"], "298.125"
        )
        self.assertTrue(summary["delay_adjusted_depth_stress_passed"])
        self.assertEqual(
            summary["daily_liquidity_notional"],
            {
                "2026-03-31": "1000000",
                "2026-04-01": "1250000",
                "2026-04-02": "1500000",
            },
        )

    def test_consistency_penalty_selects_almgren_chriss_proxy_when_stricter(
        self,
    ) -> None:
        _, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-24",
                daily_net={"2026-03-24": "1000"},
                daily_filled_notional={"2026-03-24": "1000000"},
                daily_liquidity_notional={"2026-03-24": "1000000"},
                decision_count=10,
                filled_count=10,
                wins=10,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=1,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=1,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("1"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertEqual(summary["market_impact_stress_model"], "almgren_chriss_proxy")
        self.assertEqual(summary["market_impact_stress_cost_bps"], "150")
        self.assertEqual(
            summary["market_impact_stress_components"]["square_root_cost_bps"], "100"
        )
        self.assertEqual(
            summary["market_impact_stress_components"]["almgren_chriss_cost_bps"],
            "150",
        )
        self.assertFalse(summary["market_impact_stress_passed"])

    def test_consistency_penalty_fails_implementation_uncertainty_lower_bound(
        self,
    ) -> None:
        penalties, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-25",
                daily_net={
                    "2026-03-24": "514",
                    "2026-03-25": "514",
                },
                daily_filled_notional={
                    "2026-03-24": "100000",
                    "2026-03-25": "100000",
                },
                daily_liquidity_notional={
                    "2026-03-24": "10000000000000",
                    "2026-03-25": "10000000000000",
                },
                decision_count=4,
                filled_count=4,
                wins=4,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=2,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=2,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.60"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertTrue(summary["market_impact_stress_passed"])
        self.assertEqual(summary["market_impact_stress_net_pnl_per_day"], "504.0")
        self.assertFalse(summary["implementation_uncertainty_stability_passed"])
        self.assertEqual(
            summary["implementation_uncertainty_lower_net_pnl_per_day"], "499.0"
        )
        self.assertGreater(penalties, frontier.Decimal("0"))

    def test_consistency_penalty_fails_delay_depth_when_filled_day_lacks_liquidity(
        self,
    ) -> None:
        _, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-25",
                daily_net={
                    "2026-03-24": "800",
                    "2026-03-25": "800",
                },
                daily_filled_notional={
                    "2026-03-24": "200000",
                    "2026-03-25": "200000",
                },
                daily_liquidity_notional={
                    "2026-03-24": "100000",
                },
                decision_count=4,
                filled_count=4,
                wins=4,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=2,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=2,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.75"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertFalse(summary["delay_adjusted_depth_liquidity_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_liquidity_missing_day_count"], 1)
        self.assertEqual(
            summary["delay_adjusted_depth_fillable_notional_per_day"], "47500.00"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_worst_active_day_fillable_notional"], "0"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_p10_active_day_fillable_notional"], "0"
        )
        self.assertFalse(summary["delay_adjusted_depth_tail_coverage_passed"])
        self.assertFalse(summary["delay_adjusted_depth_stress_passed"])

    def test_consistency_penalty_scales_delay_depth_net_for_thin_recorded_liquidity(
        self,
    ) -> None:
        _, summary = frontier._consistency_penalty(
            full_window_payload=self._payload(
                start_date="2026-03-24",
                end_date="2026-03-25",
                daily_net={
                    "2026-03-24": "800",
                    "2026-03-25": "800",
                },
                daily_filled_notional={
                    "2026-03-24": "400000",
                    "2026-03-25": "400000",
                },
                daily_liquidity_notional={
                    "2026-03-24": "200000",
                    "2026-03-25": "200000",
                },
                decision_count=4,
                filled_count=4,
                wins=4,
                losses=0,
            ),
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=2,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=2,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.75"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertTrue(summary["delay_adjusted_depth_liquidity_evidence_present"])
        self.assertEqual(summary["delay_adjusted_depth_liquidity_missing_day_count"], 0)
        self.assertEqual(
            summary["delay_adjusted_depth_fillable_notional_per_day"], "190000.00"
        )
        self.assertEqual(
            summary["delay_adjusted_depth_worst_grid_fillable_notional_per_day"],
            "150000.00",
        )
        self.assertEqual(
            summary["delay_adjusted_depth_worst_active_day_fillable_notional"],
            "150000.00",
        )
        self.assertEqual(
            summary["delay_adjusted_depth_p10_active_day_fillable_notional"],
            "150000.00",
        )
        self.assertTrue(summary["delay_adjusted_depth_tail_coverage_passed"])
        self.assertEqual(summary["delay_adjusted_depth_fillable_ratio"], "0.475")
        self.assertEqual(
            summary["delay_adjusted_depth_unfillable_notional_per_day"], "210000.00"
        )
        self.assertEqual(
            frontier.Decimal(summary["delay_adjusted_depth_stress_net_pnl_per_day"]),
            frontier.Decimal("361"),
        )

    def test_consistency_penalty_applies_order_lifecycle_fill_survival_to_delay_depth(
        self,
    ) -> None:
        payload = self._payload(
            start_date="2026-03-24",
            end_date="2026-03-24",
            daily_net={"2026-03-24": "1000"},
            daily_filled_notional={"2026-03-24": "100000"},
            daily_liquidity_notional={"2026-03-24": "1000000"},
            decision_count=4,
            filled_count=4,
            wins=4,
            losses=0,
        )
        payload["order_lifecycle"] = {
            "submitted_order_count": 4,
            "filled_order_count": 2,
            "fill_rate": "0.5",
            "fill_survival_sample_count": 4,
            "fill_survival_evidence_present": True,
            "order_qty_to_touch_qty_ratio_p95": "0.25",
            "post_cost_survivorship": {
                "post_cost_survival_rate": "1",
                "gross_positive_killed_by_cost_count": 0,
            },
        }

        _, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=1,
                min_active_ratio=frontier.Decimal("1"),
                min_positive_days=1,
                max_worst_day_loss=frontier.Decimal("250"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("500"),
                max_best_day_share_of_total_pnl=frontier.Decimal("1"),
                min_avg_filled_notional_per_day=frontier.Decimal("50000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("50000"),
                require_every_day_active=True,
            ),
        )

        self.assertEqual(summary["fill_survival_sample_count"], 4)
        self.assertEqual(summary["fill_survival_fill_rate"], "0.5")
        self.assertEqual(
            summary["delay_adjusted_depth_survival_adjusted_fillable_ratio"],
            "0.5",
        )
        self.assertEqual(
            frontier.Decimal(summary["delay_adjusted_depth_stress_net_pnl_per_day"]),
            frontier.Decimal("490"),
        )
        self.assertEqual(summary["delay_adjusted_depth_queue_ratio_p95"], "0.25")

    def test_consistency_penalty_reports_and_penalizes_capital_realism(self) -> None:
        payload = self._payload(
            start_date="2026-03-24",
            end_date="2026-03-26",
            daily_net={
                "2026-03-24": "600",
                "2026-03-25": "550",
                "2026-03-26": "650",
            },
            daily_filled_notional={
                "2026-03-24": "250000",
                "2026-03-25": "260000",
                "2026-03-26": "270000",
            },
            decision_count=12,
            filled_count=12,
            wins=9,
            losses=3,
        )
        daily = cast(dict[str, dict[str, object]], payload["daily"])
        daily["2026-03-24"]["min_cash"] = "12000"
        daily["2026-03-24"]["max_gross_exposure_pct_equity"] = "0.80"
        daily["2026-03-24"]["negative_cash_observation_count"] = 0
        daily["2026-03-25"]["min_cash"] = "-2500"
        daily["2026-03-25"]["max_gross_exposure_pct_equity"] = "2.40"
        daily["2026-03-25"]["negative_cash_observation_count"] = 3
        daily["2026-03-26"]["min_cash"] = "8000"
        daily["2026-03-26"]["max_gross_exposure_pct_equity"] = "1.10"
        daily["2026-03-26"]["negative_cash_observation_count"] = 0

        penalties, summary = frontier._consistency_penalty(
            full_window_payload=payload,
            policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=frontier.Decimal("500"),
                min_daily_net_pnl=frontier.Decimal("0"),
                min_active_days=3,
                min_active_ratio=frontier.Decimal("1.0"),
                min_positive_days=3,
                max_worst_day_loss=frontier.Decimal("0"),
                max_negative_days=0,
                max_drawdown=frontier.Decimal("0"),
                max_best_day_share_of_total_pnl=frontier.Decimal("0.60"),
                min_avg_filled_notional_per_day=frontier.Decimal("200000"),
                min_avg_filled_notional_per_active_day=frontier.Decimal("200000"),
                require_every_day_active=True,
                max_gross_exposure_pct_equity=frontier.Decimal("1.50"),
                min_cash=frontier.Decimal("0"),
            ),
        )

        self.assertGreater(penalties, frontier.Decimal("0"))
        self.assertEqual(summary["max_gross_exposure_pct_equity"], "2.40")
        self.assertEqual(summary["min_cash"], "-2500")
        self.assertEqual(summary["negative_cash_observation_count"], 3)
        self.assertEqual(summary["daily_min_cash"]["2026-03-25"], "-2500")

    def test_main_prefers_consistent_candidate_over_prettier_holdout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            tape_path = root / "full-window-tape.jsonl"
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 18, 17, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Sec",
                        seq=1,
                        source="ta",
                        payload={"price": Decimal("900.00")},
                    )
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-test",
                symbols=("NVDA", "AMAT"),
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 23),
                source_query_digest=build_source_query_digest({"query": "frontier"}),
            )
            args.replay_tape_path = tape_path
            args.replay_tape_manifest = None
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                stop = str(strategy["params"]["long_stop_loss_bps"])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    return self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-18": "80",
                            "2026-03-19": "90",
                            "2026-03-20": "85",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if start_date == "2026-03-21" and end_date == "2026-03-23":
                    if stop == "12":
                        return self._payload(
                            start_date="2026-03-21",
                            end_date="2026-03-23",
                            daily_net={
                                "2026-03-21": "450",
                                "2026-03-22": "0",
                                "2026-03-23": "0",
                            },
                            decision_count=1,
                            filled_count=1,
                            wins=1,
                            losses=0,
                        )
                    return self._payload(
                        start_date="2026-03-21",
                        end_date="2026-03-23",
                        daily_net={
                            "2026-03-21": "220",
                            "2026-03-22": "210",
                            "2026-03-23": "205",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if stop == "12":
                    return self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-23",
                        daily_net={
                            "2026-03-18": "80",
                            "2026-03-19": "90",
                            "2026-03-20": "85",
                            "2026-03-21": "450",
                            "2026-03-22": "0",
                            "2026-03-23": "0",
                        },
                        decision_count=4,
                        filled_count=4,
                        wins=4,
                        losses=0,
                    )
                return self._payload(
                    start_date="2026-03-18",
                    end_date="2026-03-23",
                    daily_net={
                        "2026-03-18": "80",
                        "2026-03-19": "90",
                        "2026-03-20": "85",
                        "2026-03-21": "220",
                        "2026-03-22": "210",
                        "2026-03-23": "205",
                    },
                    decision_count=6,
                    filled_count=6,
                    wins=6,
                    losses=0,
                )

            stdout = io.StringIO()
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-test",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-test",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            stdout_payload = json.loads(stdout.getvalue())
            self.assertEqual(payload, stdout_payload)
            top = payload["top"][0]
            self.assertEqual(top["replay_config"]["params"]["long_stop_loss_bps"], "18")
            self.assertEqual(top["full_window"]["active_days"], 6)
            self.assertEqual(
                payload["dataset_snapshot_receipt"]["snapshot_id"], "snap-test"
            )
            self.assertEqual(payload["replay_tape"]["selected_row_count"], 1)
            self.assertEqual(top["ranking"]["method"], "pareto_frontier_v2")
            self.assertEqual(top["family_template_id"], "intraday_tsmom_v2")

    def test_run_frontier_vetoes_candidate_that_fails_second_oos(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.second_oos_days = 2
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(8)
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                stop = str(strategy["params"]["long_stop_loss_bps"])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-24" and end_date == "2026-03-25":
                    if stop == "12":
                        return self._payload(
                            start_date=start_date,
                            end_date=end_date,
                            daily_net={"2026-03-24": "-250", "2026-03-25": "0"},
                            daily_liquidity_notional={
                                "2026-03-24": "1000000",
                                "2026-03-25": "1000000",
                            },
                            decision_count=1,
                            filled_count=1,
                            wins=0,
                            losses=1,
                        )
                    return self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net={"2026-03-24": "240", "2026-03-25": "230"},
                        daily_liquidity_notional={
                            "2026-03-24": "1000000",
                            "2026-03-25": "1000000",
                        },
                        decision_count=2,
                        filled_count=2,
                        wins=2,
                        losses=0,
                    )
                if start_date == "2026-03-21" and end_date == "2026-03-23":
                    return self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net=(
                            {
                                "2026-03-21": "500",
                                "2026-03-22": "510",
                                "2026-03-23": "520",
                            }
                            if stop == "12"
                            else {
                                "2026-03-21": "220",
                                "2026-03-22": "210",
                                "2026-03-23": "205",
                            }
                        ),
                        daily_liquidity_notional={
                            "2026-03-21": "1000000",
                            "2026-03-22": "1000000",
                            "2026-03-23": "1000000",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    return self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net={
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                        },
                        daily_liquidity_notional={
                            "2026-03-18": "1000000",
                            "2026-03-19": "1000000",
                            "2026-03-20": "1000000",
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    )
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=(
                        {
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                            "2026-03-21": "500",
                            "2026-03-22": "510",
                            "2026-03-23": "520",
                            "2026-03-24": "-250",
                            "2026-03-25": "0",
                        }
                        if stop == "12"
                        else {
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                            "2026-03-21": "220",
                            "2026-03-22": "210",
                            "2026-03-23": "205",
                            "2026-03-24": "240",
                            "2026-03-25": "230",
                        }
                    ),
                    daily_liquidity_notional={
                        "2026-03-18": "1000000",
                        "2026-03-19": "1000000",
                        "2026-03-20": "1000000",
                        "2026-03-21": "1000000",
                        "2026-03-22": "1000000",
                        "2026-03-23": "1000000",
                        "2026-03-24": "1000000",
                        "2026-03-25": "1000000",
                    },
                    decision_count=8,
                    filled_count=8,
                    wins=7,
                    losses=1 if stop == "12" else 0,
                )

            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-second-oos",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-second-oos",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-25",
                    "expected_last_trading_day": "2026-03-25",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(
                payload["window"]["second_oos_days"], ["2026-03-24", "2026-03-25"]
            )
            self.assertEqual(
                payload["constraints"]["second_oos"]["min_independent_window_count"],
                2,
            )
            top_by_stop = {
                str(row["replay_config"]["params"]["long_stop_loss_bps"]): row
                for row in payload["top"]
            }
            self.assertTrue(top_by_stop["18"]["second_oos"]["passed"])
            self.assertTrue(
                top_by_stop["18"]["full_window"][
                    "market_impact_liquidity_evidence_present"
                ]
            )
            self.assertEqual(
                top_by_stop["18"]["full_window"]["market_impact_liquidity_day_count"],
                8,
            )
            self.assertEqual(
                top_by_stop["18"]["second_oos"]["market_impact_liquidity_day_count"],
                2,
            )
            self.assertTrue(
                top_by_stop["18"]["objective_scorecard"][
                    "market_impact_liquidity_evidence_present"
                ]
            )
            self.assertEqual(
                top_by_stop["18"]["objective_scorecard"]["market_impact_stress_model"],
                "square_root",
            )
            self.assertEqual(
                top_by_stop["18"]["objective_scorecard"][
                    "market_impact_stress_components"
                ]["source_marker"],
                "realistic_market_impact_arxiv_2603_29086_2026",
            )
            self.assertTrue(
                top_by_stop["18"]["objective_scorecard"][
                    "nonlinear_market_impact_stress_passed"
                ]
            )
            self.assertIn(
                "market_impact_stress_net_pnl_per_day",
                top_by_stop["18"]["objective_scorecard"],
            )
            self.assertEqual(
                top_by_stop["18"]["objective_scorecard"][
                    "delay_adjusted_depth_stress_model"
                ],
                "latency_depth_haircut",
            )
            self.assertIn(
                "delay_adjusted_depth_stress_net_pnl_per_day",
                top_by_stop["18"]["objective_scorecard"],
            )
            self.assertTrue(
                top_by_stop["18"]["objective_scorecard"]["double_oos_passed"]
            )
            self.assertFalse(top_by_stop["12"]["second_oos"]["passed"])
            self.assertIn(
                "second_oos_net_per_day_below_target",
                top_by_stop["12"]["hard_vetoes"],
            )
            self.assertEqual(
                top_by_stop["12"]["objective_scorecard"][
                    "double_oos_independent_window_count"
                ],
                2,
            )

    def test_run_frontier_writes_partial_json_output_between_candidates(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "200",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "200",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12", "18"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = "1"
            args.collect_train_gate_diagnostics = True
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-partial",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-partial",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            replay_call_count = {"count": 0}

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_call_count["count"] += 1
                if replay_call_count["count"] == 4:
                    partial_payload = json.loads(
                        json_output.read_text(encoding="utf-8")
                    )
                    self.assertEqual(partial_payload["status"], "running")
                    self.assertEqual(partial_payload["candidate_count"], 1)
                    self.assertEqual(
                        partial_payload["progress"]["evaluated_candidates"], 1
                    )
                    self.assertGreaterEqual(
                        partial_payload["progress"]["pending_candidates"], 0
                    )
                    self.assertEqual(len(partial_payload["top"]), 1)

                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                stop = str(strategy["params"]["long_stop_loss_bps"])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    daily_net = (
                        {"2026-03-18": "90", "2026-03-19": "95", "2026-03-20": "100"}
                        if stop == "18"
                        else {
                            "2026-03-18": "60",
                            "2026-03-19": "55",
                            "2026-03-20": "50",
                        }
                    )
                elif start_date == "2026-03-21" and end_date == "2026-03-23":
                    daily_net = (
                        {"2026-03-21": "220", "2026-03-22": "210", "2026-03-23": "205"}
                        if stop == "18"
                        else {
                            "2026-03-21": "120",
                            "2026-03-22": "115",
                            "2026-03-23": "110",
                        }
                    )
                else:
                    daily_net = (
                        {
                            "2026-03-18": "90",
                            "2026-03-19": "95",
                            "2026-03-20": "100",
                            "2026-03-21": "220",
                            "2026-03-22": "210",
                            "2026-03-23": "205",
                        }
                        if stop == "18"
                        else {
                            "2026-03-18": "60",
                            "2026-03-19": "55",
                            "2026-03-20": "50",
                            "2026-03-21": "120",
                            "2026-03-22": "115",
                            "2026-03-23": "110",
                        }
                    )
                replay_payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )
                if getattr(config, "capture_trace_funnel", False):
                    replay_payload["funnel"] = {
                        "buckets": [
                            {
                                "strategy_evaluations": 2,
                                "passed_trace_count": 0,
                                "first_failed_gate_counts": {
                                    "breakout:confirmation": 2
                                },
                            }
                        ]
                    }
                return replay_payload

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload["status"], "completed")
            self.assertEqual(payload["candidate_count"], 2)
            self.assertEqual(
                payload["top"][0]["train_gate_diagnostics"]["status"], "available"
            )
            persisted = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(persisted["status"], "completed")
            self.assertEqual(persisted["candidate_count"], 2)

    def test_run_frontier_train_screen_skips_dead_candidate_expensive_replays(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "200",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "200",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": True,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-screen",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-screen",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            replay_calls: list[tuple[str, str]] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_calls.append(
                    (
                        str(getattr(config, "start_date")),
                        str(getattr(config, "end_date")),
                    )
                )
                return self._payload(
                    start_date="2026-03-18",
                    end_date="2026-03-20",
                    daily_net={
                        "2026-03-18": "0",
                        "2026-03-19": "0",
                        "2026-03-20": "0",
                    },
                    decision_count=0,
                    filled_count=0,
                    wins=0,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(replay_calls, [("2026-03-18", "2026-03-20")])
            self.assertEqual(payload["candidate_count"], 1)
            top = payload["top"][0]
            self.assertEqual(top["screening"]["status"], "rejected")
            self.assertTrue(top["screening"]["holdout_replay_skipped"])
            self.assertTrue(top["screening"]["full_window_replay_skipped"])
            self.assertIn("train_no_decisions", top["hard_vetoes"])
            self.assertIn("train_net_per_day_below_screen", top["hard_vetoes"])

    def test_run_frontier_respects_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            json_output = root / "nested" / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.max_candidates_to_evaluate = 1
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-budget",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-budget",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                return self._payload(
                    start_date=str(getattr(config, "start_date")),
                    end_date=str(getattr(config, "end_date")),
                    daily_net={
                        "2026-03-18": "100",
                        "2026-03-19": "110",
                        "2026-03-20": "120",
                    },
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(payload["status"], "candidate_budget_exhausted")
            self.assertEqual(payload["candidate_count"], 1)
            self.assertGreater(payload["progress"]["pending_candidates"], 0)
            persisted = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(persisted["status"], "candidate_budget_exhausted")

    def test_initial_worklist_streams_large_parameter_product(self) -> None:
        candidates = frontier._iter_initial_worklist_candidates(
            parameter_grid={
                "min_recent_microprice_bias_bps": list(range(10_000)),
                "min_late_day_continuation_bps": list(range(10_000)),
            },
            override_candidates=[{"universe_symbols": ["NVDA"]}],
        )

        (
            first_params,
            first_overrides,
            first_iteration,
            first_pruned_symbol,
            first_loss_repair_reason,
            first_parent_id,
        ) = next(candidates)
        (
            second_params,
            second_overrides,
            second_iteration,
            second_pruned_symbol,
            second_loss_repair_reason,
            second_parent_id,
        ) = next(candidates)

        self.assertEqual(
            first_params,
            {"min_recent_microprice_bias_bps": 0, "min_late_day_continuation_bps": 0},
        )
        self.assertEqual(
            second_params,
            {"min_recent_microprice_bias_bps": 1, "min_late_day_continuation_bps": 0},
        )
        self.assertEqual(first_overrides, {"universe_symbols": ["NVDA"]})
        self.assertEqual(second_overrides, {"universe_symbols": ["NVDA"]})
        self.assertEqual(first_iteration, 0)
        self.assertEqual(second_iteration, 0)
        self.assertIsNone(first_pruned_symbol)
        self.assertIsNone(second_pruned_symbol)
        self.assertIsNone(first_loss_repair_reason)
        self.assertIsNone(second_loss_repair_reason)
        self.assertIsNone(first_parent_id)
        self.assertIsNone(second_parent_id)

    def test_parameter_stream_prioritizes_entry_gates_for_small_budgets(self) -> None:
        candidates = frontier._iter_parameter_candidates(
            {
                "long_stop_loss_bps": ["20", "24"],
                "min_cross_section_continuation_rank": ["0.60", "0.70"],
                "entry_cooldown_seconds": ["3600", "7200"],
            }
        )

        first = next(candidates)
        second = next(candidates)
        third = next(candidates)

        self.assertEqual(first["min_cross_section_continuation_rank"], "0.60")
        self.assertEqual(second["min_cross_section_continuation_rank"], "0.70")
        self.assertEqual(second["long_stop_loss_bps"], "20")
        self.assertEqual(third["long_stop_loss_bps"], "24")

    def test_main_symbol_pruning_promotes_pruned_universe(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_reclaim",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "200",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "200",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA", "AVGO"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.symbol_prune_iterations = 1
            args.symbol_prune_candidates = 1
            args.symbol_prune_min_universe_size = 1
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-prune",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-prune",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                universe = tuple(strategy.get("universe_symbols") or [])
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))

                if universe == ("NVDA",):
                    daily_net = {
                        "2026-03-18": "240",
                        "2026-03-19": "260",
                        "2026-03-20": "250",
                        "2026-03-21": "280",
                        "2026-03-22": "270",
                        "2026-03-23": "275",
                    }
                    funnel = {
                        "buckets": [
                            {
                                "trading_day": day,
                                "symbol": "NVDA",
                                "filled_count": 1,
                                "net_pnl": value,
                                "cost_total": "5",
                            }
                            for day, value in daily_net.items()
                        ]
                    }
                else:
                    daily_net = {
                        "2026-03-18": "240",
                        "2026-03-19": "260",
                        "2026-03-20": "250",
                        "2026-03-21": "60",
                        "2026-03-22": "-220",
                        "2026-03-23": "290",
                    }
                    funnel = {
                        "buckets": [
                            {
                                "trading_day": "2026-03-22",
                                "symbol": "AVGO",
                                "filled_count": 1,
                                "net_pnl": "-260",
                                "cost_total": "10",
                            },
                            {
                                "trading_day": "2026-03-21",
                                "symbol": "AVGO",
                                "filled_count": 1,
                                "net_pnl": "20",
                                "cost_total": "5",
                            },
                            {
                                "trading_day": "2026-03-18",
                                "symbol": "NVDA",
                                "filled_count": 1,
                                "net_pnl": "240",
                                "cost_total": "5",
                            },
                        ]
                    }

                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    subset = {
                        day: daily_net[day]
                        for day in ("2026-03-18", "2026-03-19", "2026-03-20")
                    }
                elif start_date == "2026-03-21" and end_date == "2026-03-23":
                    subset = {
                        day: daily_net[day]
                        for day in ("2026-03-21", "2026-03-22", "2026-03-23")
                    }
                else:
                    subset = daily_net
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    decision_count=3,
                    filled_count=3,
                    wins=2,
                    losses=1,
                )
                payload["funnel"] = funnel
                return payload

            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            top = payload["top"][0]
            self.assertEqual(
                top["replay_config"]["strategy_overrides"]["universe_symbols"], ["NVDA"]
            )
            self.assertEqual(top["search_iteration"], 1)
            self.assertEqual(top["pruned_symbol"], "AVGO")

    def test_main_adds_concentration_hard_vetoes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_reclaim",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "500",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_days": 1,
                            "max_worst_day_loss": "500",
                            "max_negative_days": 3,
                            "max_drawdown": "800",
                            "require_every_day_active": False,
                            "max_symbol_concentration_share": "0.50",
                            "max_entry_family_contribution_share": "0.50",
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA", "AMAT"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-veto",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-veto",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    daily_net = {
                        "2026-03-18": "200",
                        "2026-03-19": "180",
                        "2026-03-20": "160",
                    }
                else:
                    daily_net = {
                        "2026-03-21": "220",
                        "2026-03-22": "210",
                        "2026-03-23": "205",
                    }
                payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )
                payload["trace"] = []
                return payload

            fake_decomposition = SimpleNamespace(
                to_payload=lambda: {"families": {}, "symbols": {}},
            )
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_replay_decomposition",
                    return_value=fake_decomposition,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.regime_slice_pass_rate",
                    return_value=Decimal("1"),
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.max_symbol_concentration_share",
                    return_value=Decimal("0.90"),
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.max_family_contribution_share",
                    return_value=Decimal("0.90"),
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertIn(
                "symbol_concentration_above_max", payload["top"][0]["hard_vetoes"]
            )
            self.assertIn(
                "entry_family_contribution_above_max", payload["top"][0]["hard_vetoes"]
            )

    def test_main_keeps_min_active_days_disabled_for_widened_full_window(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "widened-sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 1,
                            "max_worst_holdout_day_loss": "500",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_ratio": "0",
                            "max_worst_day_loss": "500",
                            "max_negative_days": 7,
                            "max_drawdown": "900",
                            "require_every_day_active": False,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.full_window_start_date = "2026-03-17"
            args.full_window_end_date = "2026-03-23"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-wide",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-wide",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-17",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 321,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )

            daily_net = {
                "2026-03-17": "90",
                "2026-03-18": "110",
                "2026-03-19": "95",
                "2026-03-20": "120",
                "2026-03-21": "130",
                "2026-03-22": "115",
                "2026-03-23": "125",
            }

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                subset = {
                    day: value
                    for day, value in daily_net.items()
                    if start_date <= day <= end_date
                }
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=subset,
                    decision_count=max(1, len(subset)),
                    filled_count=max(1, len(subset)),
                    wins=max(1, len(subset)),
                    losses=0,
                )

            stdout = io.StringIO()
            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["constraints"]["consistency"]["min_active_days"], 0
            )
