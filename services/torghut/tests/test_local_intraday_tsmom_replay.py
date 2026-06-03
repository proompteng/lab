from __future__ import annotations

import json
import os
import subprocess
import sys
from argparse import Namespace
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from app.trading.costs import CostModelConfig, TransactionCostModel
from app.trading.evaluation_trace import (
    GateTrace,
    NearMissRecord,
    StrategyTrace,
    ThresholdTrace,
)
from app.models import Strategy
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.runtime_ledger import build_runtime_ledger_buckets
from scripts.local_intraday_tsmom_replay import (
    PendingOrder,
    PositionState,
    ReplayConfig,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision,
    _apply_order_preferences,
    _append_decimal_sample,
    _build_near_miss,
    _decision_exit_reason,
    _decision_market_order_spread_bps_max,
    _decision_position_owner,
    _decision_spread_bps,
    _estimate_trade_cost,
    _estimate_trade_cost_lineage,
    _fetch_chunk,
    _flatten_positions,
    _http_query,
    _init_funnel_stats,
    _insert_near_miss,
    _latency_bucket,
    _load_strategies,
    _parse_signal_row,
    _pending_censor_time,
    _positions_payload,
    _quote_quality_status,
    _record_capital_snapshot,
    _record_trace_for_funnel,
    _resolve_repo_root,
    _reconcile_pending_order_before_immediate_fill,
    _resolve_passed_trace_block_reason,
    _resolve_pending_fill_price,
    _should_replace_pending_order,
    _signal_mid_jump_bps,
    _signal_spread_bps,
    _kubectl_clickhouse_query,
    main as replay_main,
    run_replay,
)


class TestLocalIntradayTsmomReplay(TestCase):
    def test_resolve_repo_root_accepts_container_app_layout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "app"
            (root / "app").mkdir(parents=True)
            (root / "scripts").mkdir()
            script_path = root / "scripts" / "local_intraday_tsmom_replay.py"
            script_path.touch()

            self.assertEqual(_resolve_repo_root(script_path), root.resolve())

    def test_resolve_repo_root_keeps_legacy_parent_fallback(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            script_path = root / "one" / "two" / "three" / "four" / "script.py"
            script_path.parent.mkdir(parents=True)
            script_path.touch()

            self.assertEqual(
                _resolve_repo_root(script_path), script_path.resolve().parents[3]
            )

    def test_default_strategy_configmap_prefers_runtime_env_path(self) -> None:
        from scripts import local_intraday_tsmom_replay as replay

        with patch.dict(
            os.environ,
            {"TRADING_STRATEGY_CONFIG_PATH": "/etc/torghut/strategies.yaml"},
        ):
            self.assertEqual(
                replay.default_strategy_configmap_path(),
                Path("/etc/torghut/strategies.yaml"),
            )

    def _signal(self, *, bid: str, ask: str, price: str) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=12,
            payload={
                "price": Decimal(price),
                "imbalance_bid_px": Decimal(bid),
                "imbalance_ask_px": Decimal(ask),
                "spread": Decimal(ask) - Decimal(bid),
            },
        )

    def test_force_position_isolation_owns_decision_by_strategy_id(self) -> None:
        decision = StrategyDecision(
            strategy_id="candidate-strategy-1",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={},
        )

        self.assertEqual(_decision_position_owner(decision), _SHARED_POSITION_OWNER)
        self.assertEqual(
            _decision_position_owner(decision, force_position_isolation=True),
            "candidate-strategy-1",
        )

    def test_order_lifecycle_helpers_cover_defensive_branches(self) -> None:
        samples: dict[str, object] = {}
        _append_decimal_sample(samples, "spread_bps_samples", None)
        self.assertEqual(samples, {})
        self.assertEqual(_latency_bucket(50), "1-50ms")
        self.assertEqual(_latency_bucket(151), "151-250ms")

        decision = StrategyDecision(
            strategy_id="candidate-strategy-1",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            order_type="limit",
            time_in_force="day",
            params={},
            limit_price=Decimal("100"),
        )
        signal = self._signal(bid="99.90", ask="100.00", price="99.95")
        before_close = PendingOrder(
            decision=decision,
            created_at=datetime(2026, 3, 27, 17, 30, tzinfo=timezone.utc),
            signal=signal,
        )
        after_close = PendingOrder(
            decision=decision,
            created_at=datetime(2026, 3, 27, 21, 30, tzinfo=timezone.utc),
            signal=signal,
        )
        fallback = datetime(2026, 3, 27, 22, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _pending_censor_time(pending=before_close, fallback=fallback),
            datetime(2026, 3, 27, 20, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            _pending_censor_time(pending=after_close, fallback=fallback), fallback
        )
        self.assertIsNone(
            _reconcile_pending_order_before_immediate_fill(
                decision=decision,
                pending_orders={},
                created_at=signal.event_ts,
            )
        )

    def test_kubectl_clickhouse_query_validates_target_and_reports_failure(
        self,
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "clickhouse_kubectl_url_invalid"):
            _kubectl_clickhouse_query(
                url="kubectl://galactic-lan/torghut",
                username="torghut",
                password="secret",
                query="SELECT 1",
            )

        with patch(
            "scripts.local_intraday_tsmom_replay.subprocess.run",
            return_value=Namespace(returncode=1, stdout="", stderr="denied"),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_kubectl_query_failed: denied"
            ):
                _kubectl_clickhouse_query(
                    url="kubectl://galactic-lan/torghut/clickhouse-0",
                    username="torghut",
                    password="secret",
                    query="SELECT 1",
                )

        with patch(
            "scripts.local_intraday_tsmom_replay.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["kubectl"], timeout=2),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "clickhouse_kubectl_query_timeout:2s"
            ):
                _kubectl_clickhouse_query(
                    url="kubectl://galactic-lan/torghut/clickhouse-0",
                    username="torghut",
                    password="secret",
                    query="SELECT 1",
                    timeout_seconds=2,
                )

    def test_execution_spread_helpers_fall_back_on_invalid_payloads(self) -> None:
        decision = StrategyDecision(
            strategy_id="candidate-strategy-1",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={
                "market_order_spread_bps_max": "not-a-decimal",
                "execution_features": {"spread_bps": "not-a-decimal"},
            },
        )

        self.assertEqual(_decision_market_order_spread_bps_max(decision), Decimal("12"))
        self.assertIsNone(
            _decision_spread_bps(decision, price=Decimal("0"), spread=Decimal("1"))
        )

    def test_load_strategies_rejects_invalid_configmap_shapes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            not_mapping = root / "not-mapping.yaml"
            missing_data = root / "missing-data.yaml"
            missing_strategies = root / "missing-strategies.yaml"
            not_mapping.write_text("- bad\n", encoding="utf-8")
            missing_data.write_text("apiVersion: v1\n", encoding="utf-8")
            missing_strategies.write_text(
                "data:\n  other.yaml: '{}'\n", encoding="utf-8"
            )

            with self.assertRaisesRegex(RuntimeError, "strategy_configmap_not_mapping"):
                _load_strategies(not_mapping)
            with self.assertRaisesRegex(
                RuntimeError, "strategy_configmap_missing_data"
            ):
                _load_strategies(missing_data)
            with self.assertRaisesRegex(
                RuntimeError, "strategy_configmap_missing_strategies_yaml"
            ):
                _load_strategies(missing_strategies)

    def test_fetch_chunk_filters_symbols_and_parses_rows(self) -> None:
        captured_queries: list[str] = []

        def fake_http_query(
            *,
            url: str,
            username: str | None,
            password: str | None,
            timeout_seconds: int,
            query: str,
        ) -> str:
            self.assertEqual(url, "http://clickhouse")
            self.assertEqual(username, "reader")
            self.assertEqual(password, "secret")
            self.assertEqual(timeout_seconds, 7)
            captured_queries.append(query)
            return "\t".join(
                [
                    "META",
                    "2026-03-27 17:30:24.000",
                    "12",
                    "0.031",
                    "0.019",
                    "523.10",
                    "522.80",
                    "57",
                    "523.25",
                    "523.22",
                    "523.28",
                    "0.06",
                    "1200",
                    "800",
                    "0.06",
                    "522.95",
                    "523.05",
                    "0.00018",
                    "18200",
                ]
            )

        with patch(
            "scripts.local_intraday_tsmom_replay._http_query",
            side_effect=fake_http_query,
        ):
            rows = _fetch_chunk(
                http_url="http://clickhouse",
                username="reader",
                password="secret",
                timeout_seconds=7,
                chunk_start=datetime(2026, 3, 27, 17, 0, tzinfo=timezone.utc),
                chunk_end=datetime(2026, 3, 27, 18, 0, tzinfo=timezone.utc),
                symbols=("META", "NVDA"),
            )

        self.assertEqual([row.symbol for row in rows], ["META"])
        self.assertIn("s.symbol IN ('META', 'NVDA')", captured_queries[0])

    def test_http_query_supports_kubectl_clickhouse_transport(self) -> None:
        completed = type(
            "Completed",
            (),
            {
                "returncode": 0,
                "stdout": "2026-05-18\n",
                "stderr": "",
            },
        )()

        with patch(
            "scripts.local_intraday_tsmom_replay.subprocess.run",
            return_value=completed,
        ) as run_mock:
            output = _http_query(
                url="kubectl://galactic-lan/torghut/chi-torghut-clickhouse-default-0-0-0",
                username="torghut",
                password="secret",
                timeout_seconds=5,
                query="SELECT 1 FORMAT TSVRaw",
            )

        self.assertEqual(output, "2026-05-18\n")
        cmd = run_mock.call_args.args[0]
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 5)
        self.assertEqual(
            cmd[:7],
            [
                "kubectl",
                "--context",
                "galactic-lan",
                "exec",
                "-n",
                "torghut",
                "chi-torghut-clickhouse-default-0-0-0",
            ],
        )
        self.assertIn("--user", cmd)
        self.assertIn("torghut", cmd)
        self.assertEqual(cmd[-2:], ["--query", "SELECT 1 FORMAT TSVRaw"])

    def _decision(
        self,
        *,
        action: str,
        order_type: str,
        limit_price: str | None = None,
    ) -> StrategyDecision:
        return StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action=action,
            qty=Decimal("10"),
            order_type=order_type,
            time_in_force="day",
            limit_price=Decimal(limit_price) if limit_price is not None else None,
            rationale="test",
            params={},
        )

    def test_limit_sell_does_not_fill_below_limit(self) -> None:
        decision = self._decision(
            action="sell", order_type="limit", limit_price="524.10"
        )
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertIsNone(fill_price)

    def test_limit_sell_fills_at_bid_when_bid_crosses_limit(self) -> None:
        decision = self._decision(
            action="sell", order_type="limit", limit_price="524.10"
        )
        signal = self._signal(bid="524.18", ask="524.24", price="524.21")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal("524.18"))

    def test_limit_buy_fills_at_ask_when_ask_is_inside_limit(self) -> None:
        decision = self._decision(
            action="buy", order_type="limit", limit_price="593.95"
        )
        signal = self._signal(bid="593.70", ask="593.80", price="593.75")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal("593.80"))

    def test_market_buy_uses_ask_without_limit_price(self) -> None:
        decision = self._decision(action="buy", order_type="market")
        signal = self._signal(bid="593.70", ask="593.80", price="593.75")

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal("593.80"))

    def test_quote_metric_helpers_return_positive_bps(self) -> None:
        signal = self._signal(bid="593.70", ask="593.80", price="593.75")

        self.assertEqual(
            _signal_spread_bps(signal=signal, price=Decimal("593.75")),
            Decimal("1.684210526315789473684210526"),
        )
        self.assertEqual(
            _signal_mid_jump_bps(
                price=Decimal("593.75"),
                reference_price=Decimal("590.00"),
            ),
            Decimal("63.55932203389830508474576271"),
        )

    def test_decision_exit_reason_prefers_runtime_exit_then_rationale(self) -> None:
        stop_loss = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="signal_exit",
            params={"position_exit": {"type": "long_stop_loss_bps"}},
        )
        rationale_exit = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="microbar_exit,score=0.2",
            params={},
        )
        fallback_exit = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 13, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            params={},
        )

        self.assertEqual(_decision_exit_reason(stop_loss), "long_stop_loss_bps")
        self.assertEqual(_decision_exit_reason(rationale_exit), "microbar_exit")
        self.assertEqual(_decision_exit_reason(fallback_exit), "signal_exit")

    def test_resolve_passed_trace_block_reason_reports_post_runtime_filter(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            strategy_id="candidate-a",
            runtime_intent_strategy_ids={"candidate-a"},
            runtime_suppression_reason_by_strategy_id={},
            raw_decision_strategy_ids={"candidate-a"},
            allocation_reject_reason_by_strategy_id={},
            sizing_reject_reason_by_strategy_id={},
            emitted_strategy_ids=set(),
        )

        self.assertEqual(reason, "post_runtime_filter_rejected")

    def test_resolve_passed_trace_block_reason_reports_runtime_suppression(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            strategy_id="candidate-a",
            runtime_intent_strategy_ids={"candidate-a"},
            runtime_suppression_reason_by_strategy_id={
                "candidate-a": "runtime_trade_policy_blocked"
            },
            raw_decision_strategy_ids=set(),
            allocation_reject_reason_by_strategy_id={},
            sizing_reject_reason_by_strategy_id={},
            emitted_strategy_ids=set(),
        )

        self.assertEqual(reason, "runtime_trade_policy_blocked")

    def test_resolve_passed_trace_block_reason_reports_no_runtime_intent(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            strategy_id="candidate-a",
            runtime_intent_strategy_ids=set(),
            runtime_suppression_reason_by_strategy_id={},
            raw_decision_strategy_ids=set(),
            allocation_reject_reason_by_strategy_id={},
            sizing_reject_reason_by_strategy_id={},
            emitted_strategy_ids=set(),
        )

        self.assertEqual(reason, "engine_runtime_no_intent")

    def test_resolve_passed_trace_block_reason_reports_intent_not_emitted(
        self,
    ) -> None:
        reason = _resolve_passed_trace_block_reason(
            strategy_id="candidate-a",
            runtime_intent_strategy_ids={"candidate-a"},
            runtime_suppression_reason_by_strategy_id={},
            raw_decision_strategy_ids=set(),
            allocation_reject_reason_by_strategy_id={},
            sizing_reject_reason_by_strategy_id={},
            emitted_strategy_ids=set(),
        )

        self.assertEqual(reason, "engine_runtime_intent_not_emitted")

    def test_apply_filled_decision_opens_position_on_same_signal(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        decision = self._decision(
            action="buy", order_type="limit", limit_price="523.28"
        )
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.28"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertIn(("META", _SHARED_POSITION_OWNER), positions)
        position = positions[("META", _SHARED_POSITION_OWNER)]
        self.assertEqual(position.avg_entry_price, Decimal("523.28"))
        self.assertEqual(position.qty, Decimal("10"))
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("5232.80"))
        self.assertLess(cash, Decimal("10000"))

    def test_record_capital_snapshot_tracks_cash_and_exposure(self) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("3"),
                avg_entry_price=Decimal("100"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
            ("NVDA", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-2"),
                avg_entry_price=Decimal("50"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
        }
        bucket: dict[str, object] = {}

        equity = _record_capital_snapshot(
            bucket=bucket,
            cash=Decimal("-25"),
            positions=positions,
            last_prices={"META": Decimal("110"), "NVDA": Decimal("45")},
        )

        self.assertEqual(equity, Decimal("215"))
        self.assertEqual(bucket["min_cash"], Decimal("-25"))
        self.assertEqual(bucket["min_equity"], Decimal("215"))
        self.assertEqual(bucket["max_gross_exposure"], Decimal("420"))
        self.assertEqual(bucket["max_net_exposure_abs"], Decimal("240"))
        self.assertEqual(
            bucket["max_gross_exposure_pct_equity"], Decimal("420") / Decimal("215")
        )
        self.assertEqual(bucket["negative_cash_observation_count"], 1)
        self.assertEqual(bucket["capital_snapshot_count"], 1)

    def test_apply_filled_decision_backfills_missing_stats_bucket_fields(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        decision = self._decision(
            action="buy", order_type="limit", limit_price="523.28"
        )
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.28"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("5232.80"))
        self.assertLess(cash, Decimal("10000"))

    def test_estimate_trade_cost_uses_observed_adv_for_square_root_impact(
        self,
    ) -> None:
        signal = self._signal(bid="99.99", ask="100.01", price="100")
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("100"),
            params={},
        )
        cost_model = TransactionCostModel(
            CostModelConfig(
                impact_bps_at_full_participation=Decimal("100"),
                max_participation_rate=Decimal("1"),
            )
        )

        cost_without_adv = _estimate_trade_cost(
            model=cost_model,
            decision=decision,
            signal=signal,
        )
        cost_with_adv = _estimate_trade_cost(
            model=cost_model,
            decision=decision,
            signal=signal,
            symbol_bucket={"daily_adv_notional": Decimal("40000")},
        )

        self.assertEqual(cost_without_adv, Decimal("0"))
        self.assertEqual(cost_with_adv, Decimal("50"))

    def test_estimate_trade_cost_falls_back_to_signal_payload_adv(self) -> None:
        signal = self._signal(bid="99.99", ask="100.01", price="100")
        signal.payload["adv"] = "40000"
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("100"),
            params={},
        )

        cost = _estimate_trade_cost(
            model=TransactionCostModel(
                CostModelConfig(
                    impact_bps_at_full_participation=Decimal("100"),
                    max_participation_rate=Decimal("1"),
                )
            ),
            decision=decision,
            signal=signal,
            symbol_bucket={"daily_adv_notional": "not-a-number"},
        )

        self.assertEqual(cost, Decimal("50"))

    def test_estimate_trade_cost_lineage_exposes_adv_and_capacity_warnings(
        self,
    ) -> None:
        signal = self._signal(bid="99.99", ask="100.01", price="100")
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("100"),
            params={},
        )

        lineage = _estimate_trade_cost_lineage(
            model=TransactionCostModel(
                CostModelConfig(
                    impact_bps_at_full_participation=Decimal("100"),
                    max_participation_rate=Decimal("0.1"),
                )
            ),
            decision=decision,
            signal=signal,
            symbol_bucket={"daily_adv_notional": Decimal("40000")},
        )

        self.assertEqual(lineage.adv_notional, Decimal("40000"))
        self.assertEqual(lineage.adv_source, "symbol_bucket.daily_adv_notional")
        self.assertEqual(lineage.participation_rate, Decimal("0.25"))
        self.assertEqual(lineage.total_cost, Decimal("50"))
        self.assertEqual(lineage.warnings, ("participation_exceeds_max",))

    def test_apply_filled_decision_prefers_symbol_adv_for_impact_cost(self) -> None:
        signal = self._signal(bid="9.99", ask="10.01", price="10")
        decision = StrategyDecision(
            strategy_id="impact-aware",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("100"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("10"),
            params={},
        )
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket: dict[str, Any] = {
            "daily_adv_notional": Decimal("1000000"),
        }
        symbol_bucket: dict[str, Any] = {
            "daily_adv_notional": Decimal("4000"),
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("10"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(
                CostModelConfig(
                    impact_bps_at_full_participation=Decimal("100"),
                    max_participation_rate=Decimal("1"),
                )
            ),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertEqual(day_bucket["cost_total"], Decimal("5"))
        self.assertEqual(symbol_bucket["cost_total"], Decimal("5"))
        self.assertEqual(cash, Decimal("8995"))

    def test_apply_filled_decision_opens_short_position_on_sell_entry(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        decision = self._decision(
            action="sell", order_type="limit", limit_price="523.22"
        )
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.22"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertIn(("META", _SHARED_POSITION_OWNER), positions)
        position = positions[("META", _SHARED_POSITION_OWNER)]
        self.assertEqual(position.avg_entry_price, Decimal("523.22"))
        self.assertEqual(position.qty, Decimal("-10"))
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("5232.20"))
        self.assertGreater(cash, Decimal("10000"))

    def test_apply_filled_decision_buy_covers_existing_short(self) -> None:
        signal = self._signal(bid="522.90", ask="523.00", price="522.95")
        decision = self._decision(
            action="buy", order_type="limit", limit_price="523.00"
        )
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }
        all_closed_trades: list[object] = []

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.00"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("15231.20"),
            all_closed_trades=all_closed_trades,
        )

        self.assertNotIn(("META", _SHARED_POSITION_OWNER), positions)
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertGreater(day_bucket["gross_pnl"], Decimal("0"))
        self.assertGreater(day_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(day_bucket["wins"], 1)
        self.assertEqual(len(all_closed_trades), 1)
        self.assertLess(cash, Decimal("15231.20"))

    def test_quote_quality_rejects_wide_spread_outlier(self) -> None:
        signal = self._signal(bid="239.11", ask="253.69", price="246.40")
        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://localhost:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("31590.02"),
        )

        status = _quote_quality_status(
            signal=signal,
            previous_price=Decimal("253.70"),
            config=config,
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "spread_bps_exceeded")

    def test_quote_quality_accepts_normal_tight_quote(self) -> None:
        signal = self._signal(bid="253.69", ask="253.72", price="253.705")
        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://localhost:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("31590.02"),
        )

        status = _quote_quality_status(
            signal=signal,
            previous_price=Decimal("253.68"),
            config=config,
        )

        self.assertTrue(status.valid)

    def test_session_flatten_exit_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="session_flatten_exit",
            params={"position_exit": {"type": "session_flatten_minute_utc"}},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_high_conviction_breakout_entry_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="breakout_entry",
            params={
                "execution_features": {
                    "spread_bps": Decimal("4"),
                    "recent_microprice_bias_bps_avg": Decimal("0.20"),
                    "cross_section_continuation_rank": Decimal("0.82"),
                },
                "strategy_runtime": {
                    "source_strategy_runtime": [
                        {"strategy_type": "breakout_continuation_long_v1"}
                    ]
                },
            },
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_candidate_prefer_limit_converts_market_entry_when_global_default_false(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="ordinary_entry",
            params={"entry_order_type": "prefer_limit"},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        with patch(
            "scripts.local_intraday_tsmom_replay.settings.trading_execution_prefer_limit",
            False,
        ):
            updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "limit")
        self.assertEqual(updated.limit_price, Decimal("525.10"))

    def test_strategy_params_can_drive_candidate_order_preference(self) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="ordinary_entry",
            params={},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        with patch(
            "scripts.local_intraday_tsmom_replay.settings.trading_execution_prefer_limit",
            False,
        ):
            updated = _apply_order_preferences(
                decision,
                signal,
                strategy_params={"entry_order_type": "prefer_limit"},
            )

        self.assertEqual(updated.order_type, "limit")
        self.assertEqual(updated.limit_price, Decimal("525.10"))

    def test_candidate_market_order_type_keeps_market_when_global_prefer_limit_true(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="ordinary_entry",
            params={"entry_order_type": "market"},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        with patch(
            "scripts.local_intraday_tsmom_replay.settings.trading_execution_prefer_limit",
            True,
        ):
            updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_candidate_market_order_spread_cap_overrides_high_conviction_exception(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="breakout_entry",
            params={
                "entry_order_type": "prefer_limit",
                "market_order_spread_bps_max": "2",
                "execution_features": {
                    "spread_bps": Decimal("4"),
                    "recent_microprice_bias_bps_avg": Decimal("0.20"),
                    "cross_section_continuation_rank": Decimal("0.82"),
                },
                "strategy_runtime": {
                    "source_strategy_runtime": [
                        {"strategy_type": "breakout_continuation_long_v1"}
                    ]
                },
            },
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "limit")
        self.assertEqual(updated.limit_price, Decimal("525.10"))

    def test_microbar_cross_sectional_short_entry_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id="short-cross-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 13, 30, 1, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="microbar_cross_sectional_entry,rank=1",
            params={
                "execution_features": {
                    "spread_bps": Decimal("4"),
                },
                "strategy_runtime": {
                    "source_strategy_runtime": [
                        {"strategy_type": "microbar_cross_sectional_short_v1"}
                    ]
                },
            },
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_session_flatten_exit_replaces_resting_sell_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("524.10"),
            rationale="signal_exit",
            params={"position_exit": {"type": "signal_exit"}},
        )
        replacement = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="session_flatten_exit",
            params={"position_exit": {"type": "session_flatten_minute_utc"}},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_more_aggressive_sell_limit_replaces_resting_sell_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("524.10"),
            rationale="signal_exit",
            params={"position_exit": {"type": "signal_exit"}},
        )
        replacement = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.80"),
            rationale="signal_exit",
            params={"position_exit": {"type": "signal_exit"}},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_buy_market_replaces_same_priority_resting_buy_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.80"),
            rationale="entry",
            params={},
        )
        replacement = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="entry",
            params={},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_immediate_fill_clears_existing_pending_order_for_same_position_owner(
        self,
    ) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        existing_pending = PendingOrder(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.10"
            ),
            created_at=datetime(2026, 3, 27, 17, 29, 55, tzinfo=timezone.utc),
            signal=signal,
        )
        pending_orders = {("META", _SHARED_POSITION_OWNER): existing_pending}
        immediate_decision = self._decision(
            action="buy", order_type="limit", limit_price="523.40"
        )

        _reconcile_pending_order_before_immediate_fill(
            decision=immediate_decision,
            pending_orders=pending_orders,
            created_at=signal.event_ts,
        )

        self.assertNotIn(("META", _SHARED_POSITION_OWNER), pending_orders)

    def test_positions_payload_projects_pending_buy_exposure(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_buy = PendingOrder(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.40"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            {},
            {},
            {("META", _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "10",
                    "side": "long",
                    "market_value": "5234.00",
                    "avg_entry_price": "523.40",
                    "opened_at": signal.event_ts.isoformat(),
                    "decision_at": pending_buy.created_at.isoformat(),
                    "pending_entry": True,
                }
            ],
        )

    def test_positions_payload_projects_pending_sell_against_existing_long(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = PendingOrder(
            decision=self._decision(
                action="sell", order_type="limit", limit_price="523.10"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(payload, [])

    def test_positions_payload_projects_pending_short_entry(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = PendingOrder(
            decision=self._decision(
                action="sell", order_type="limit", limit_price="523.22"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            {},
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "10",
                    "side": "short",
                    "market_value": "-5232.50",
                    "avg_entry_price": "523.22",
                    "opened_at": signal.event_ts.isoformat(),
                    "decision_at": pending_sell.created_at.isoformat(),
                    "pending_entry": True,
                }
            ],
        )

    def test_positions_payload_projects_pending_buy_cover_against_existing_short(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_buy = PendingOrder(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.28"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(payload, [])

    def test_positions_payload_projects_partial_pending_buy_cover_against_existing_short(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        partial_cover = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("4"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.28"),
            rationale="test",
            params={},
        )
        pending_buy = PendingOrder(
            decision=partial_cover,
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "6",
                    "side": "short",
                    "market_value": "-3139.50",
                    "avg_entry_price": "520",
                    "opened_at": "2026-03-27T17:00:00+00:00",
                    "decision_at": "2026-03-27T17:00:00+00:00",
                    "pending_entry": False,
                }
            ],
        )

    def test_positions_payload_projects_pending_sell_against_existing_short(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-5"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = PendingOrder(
            decision=StrategyDecision(
                strategy_id="intraday_tsmom_v1@prod",
                symbol="META",
                event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("4"),
                order_type="limit",
                time_in_force="day",
                limit_price=Decimal("523.22"),
                rationale="test",
                params={},
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "9",
                    "side": "short",
                    "market_value": "-4709.25",
                    "avg_entry_price": "521.4311111111111111111111111",
                    "opened_at": "2026-03-27T17:00:00+00:00",
                    "decision_at": "2026-03-27T17:00:00+00:00",
                    "pending_entry": False,
                }
            ],
        )

    def test_positions_payload_keeps_other_strategy_position_when_isolated_sell_pending(
        self,
    ) -> None:
        positions = {
            ("META", "breakout_continuation_long_v1@research"): PositionState(
                strategy_id="breakout_continuation_long_v1@research",
                qty=Decimal("10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
            ("META", "mean_reversion_rebound_long_v1@research"): PositionState(
                strategy_id="mean_reversion_rebound_long_v1@research",
                qty=Decimal("6"),
                avg_entry_price=Decimal("521"),
                opened_at=datetime(2026, 3, 27, 17, 5, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 5, 0, tzinfo=timezone.utc),
            ),
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = StrategyDecision(
            strategy_id="mean_reversion_rebound_long_v1@research",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("6"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.10"),
            rationale="mean_reversion_rebound_exit",
            params={"strategy_runtime": {"position_isolation_mode": "per_strategy"}},
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {
                ("META", "mean_reversion_rebound_long_v1@research"): PendingOrder(
                    decision=pending_sell,
                    created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
                    signal=signal,
                )
            },
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": "breakout_continuation_long_v1@research",
                    "qty": "10",
                    "side": "long",
                    "market_value": "5232.50",
                    "avg_entry_price": "520",
                    "opened_at": "2026-03-27T17:00:00+00:00",
                    "decision_at": "2026-03-27T17:00:00+00:00",
                    "pending_entry": False,
                }
            ],
        )

    def test_flatten_positions_closes_short_and_books_pnl(self) -> None:
        day = date(2026, 4, 2)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 4, 2, 19, 59, 59, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={"price": Decimal("520.50")},
        )
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 4, 2, 14, 30, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 4, 2, 14, 30, 0, tzinfo=timezone.utc),
            )
        }
        stats = _init_funnel_stats()
        stats["closed_trades"] = []
        funnel_stats: dict[tuple[str, str], dict[str, object]] = {}
        cash_ref = [Decimal("15231.20")]
        all_closed_trades: list[object] = []

        _flatten_positions(
            day=day,
            stats=stats,
            funnel_stats=funnel_stats,
            positions=positions,
            last_signals={"META": signal},
            last_prices={"META": Decimal("520.50")},
            cost_model=TransactionCostModel(),
            cash_ref=cash_ref,
            all_closed_trades=all_closed_trades,
        )

        self.assertEqual(positions, {})
        self.assertEqual(stats["filled_count"], 1)
        self.assertGreater(stats["gross_pnl"], Decimal("0"))
        self.assertGreater(stats["net_pnl"], Decimal("0"))
        self.assertEqual(stats["wins"], 1)
        self.assertEqual(len(all_closed_trades), 1)

    def test_parse_signal_row_preserves_vwap_and_imbalance_sizes(self) -> None:
        parsed = _parse_signal_row(
            [
                "META",
                "2026-03-27 17:30:24.000",
                "12",
                "0.031",
                "0.019",
                "523.10",
                "522.80",
                "57",
                "523.25",
                "523.22",
                "523.28",
                "0.06",
                "1200",
                "800",
                "0.06",
                "522.95",
                "523.05",
                "0.00018",
                "18200",
            ]
        )

        assert parsed is not None
        self.assertEqual(parsed.payload["vwap_session"], Decimal("522.95"))
        self.assertEqual(parsed.payload["vwap_w5m"], Decimal("523.05"))
        self.assertEqual(parsed.payload["microbar_volume"], Decimal("18200"))
        self.assertEqual(parsed.payload["imbalance_bid_sz"], Decimal("1200"))
        self.assertEqual(parsed.payload["imbalance_ask_sz"], Decimal("800"))
        imbalance = parsed.payload["imbalance"]
        assert isinstance(imbalance, dict)
        self.assertEqual(imbalance["bid_sz"], Decimal("1200"))
        self.assertEqual(imbalance["ask_sz"], Decimal("800"))

    def test_record_trace_for_funnel_stops_at_first_failed_gate(self) -> None:
        funnel = _init_funnel_stats()
        trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="META",
            event_ts="2026-03-27T17:30:24+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="feed_quality",
            gates=(
                GateTrace(
                    gate="structure",
                    category="structure",
                    passed=True,
                    thresholds=(),
                ),
                GateTrace(
                    gate="feed_quality",
                    category="feed_quality",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="recent_quote_invalid_ratio",
                            comparator="max_lte",
                            value=Decimal("0.20"),
                            threshold=Decimal("0.10"),
                            passed=False,
                            missing_policy="fail_closed",
                            distance_to_pass=Decimal("0.10"),
                        ),
                    ),
                ),
            ),
        )

        _record_trace_for_funnel(funnel, trace)

        self.assertEqual(funnel["strategy_evaluations"], 1)
        self.assertEqual(
            dict(funnel["first_failed_gate_counts"]),
            {"breakout_continuation_long:feed_quality": 1},
        )
        self.assertEqual(
            dict(funnel["failing_threshold_counts"]),
            {"breakout_continuation_long:feed_quality:recent_quote_invalid_ratio": 1},
        )
        self.assertEqual(funnel["passed_trace_count"], 0)
        self.assertEqual(
            dict(funnel["gate_pass_counts"]),
            {"breakout_continuation_long:structure": 1},
        )

    def test_record_trace_for_funnel_handles_missing_failed_gate(self) -> None:
        funnel = _init_funnel_stats()
        trace = StrategyTrace(
            strategy_id="short@prod",
            strategy_type="mean_reversion_short",
            symbol="META",
            event_ts="2026-03-27T17:30:24+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(
                GateTrace(
                    gate="structure",
                    category="structure",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        _record_trace_for_funnel(funnel, trace)

        self.assertEqual(funnel["strategy_evaluations"], 1)
        self.assertEqual(
            dict(funnel["first_failed_gate_counts"]),
            {"mean_reversion_short:confirmation": 1},
        )
        self.assertEqual(dict(funnel["failing_threshold_counts"]), {})
        self.assertEqual(
            dict(funnel["gate_pass_counts"]),
            {"mean_reversion_short:structure": 1},
        )

    def test_build_near_miss_uses_failed_gate_thresholds(self) -> None:
        trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(
                GateTrace(
                    gate="confirmation",
                    category="confirmation",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="cross_section_continuation_breadth",
                            comparator="min_gte",
                            value=Decimal("0.42"),
                            threshold=Decimal("0.50"),
                            passed=False,
                            missing_policy="fail_closed",
                            distance_to_pass=Decimal("0.08"),
                        ),
                    ),
                ),
            ),
        )

        near_miss = _build_near_miss(trace, trading_day="2026-03-26")

        self.assertIsNotNone(near_miss)
        assert near_miss is not None
        self.assertEqual(near_miss.symbol, "AAPL")
        self.assertEqual(near_miss.first_failed_gate, "confirmation")
        self.assertEqual(near_miss.distance_score, Decimal("0.08"))
        self.assertEqual(len(near_miss.thresholds), 1)

    def test_build_near_miss_returns_none_for_non_rejectable_traces(self) -> None:
        passed_trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=True,
            action="buy",
            first_failed_gate=None,
            gates=(),
        )
        missing_gate_trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(),
        )
        no_thresholds_trace = StrategyTrace(
            strategy_id="breakout@prod",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts="2026-03-26T18:07:12+00:00",
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="confirmation",
            gates=(
                GateTrace(
                    gate="confirmation",
                    category="confirmation",
                    passed=False,
                    thresholds=(),
                ),
            ),
        )

        self.assertIsNone(_build_near_miss(passed_trace, trading_day="2026-03-26"))
        self.assertIsNone(
            _build_near_miss(missing_gate_trace, trading_day="2026-03-26")
        )
        self.assertIsNone(
            _build_near_miss(no_thresholds_trace, trading_day="2026-03-26")
        )

    def test_insert_near_miss_sorts_and_limits_bucket(self) -> None:
        near_misses: dict[str, list[NearMissRecord]] = {}
        for symbol, score in [("MSFT", "0.30"), ("AAPL", "0.10"), ("NVDA", "0.20")]:
            _insert_near_miss(
                near_misses,
                NearMissRecord(
                    trading_day="2026-03-27",
                    symbol=symbol,
                    strategy_id=f"{symbol.lower()}@prod",
                    strategy_type="breakout_continuation_long",
                    event_ts=f"2026-03-27T18:0{len(near_misses)}:00+00:00",
                    action="buy",
                    first_failed_gate="confirmation",
                    distance_score=Decimal(score),
                    thresholds=(),
                ),
                limit=2,
            )

        self.assertEqual(
            [item.symbol for item in near_misses["2026-03-27"]],
            ["AAPL", "NVDA"],
        )

    def test_apply_filled_decision_updates_symbol_bucket_for_buy_and_sell(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }
        symbol_bucket = _init_funnel_stats()

        cash = _apply_filled_decision(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.28"
            ),
            signal=signal,
            fill_price=Decimal("523.28"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("10000"),
            all_closed_trades=[],
        )

        self.assertEqual(symbol_bucket["filled_count"], 1)
        self.assertEqual(symbol_bucket["filled_notional"], Decimal("5232.80"))
        self.assertGreaterEqual(symbol_bucket["cost_total"], Decimal("0"))

        cash = _apply_filled_decision(
            decision=self._decision(action="sell", order_type="market"),
            signal=signal,
            fill_price=Decimal("523.22"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(),
            cash=cash,
            all_closed_trades=[],
        )

        self.assertGreater(symbol_bucket["gross_pnl"], Decimal("-1"))
        self.assertNotEqual(symbol_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(symbol_bucket["closed_trade_count"], 1)
        self.assertEqual(symbol_bucket["filled_notional"], Decimal("10465.00"))
        self.assertGreater(cash, Decimal("0"))

    def test_apply_filled_decision_partial_buy_cover_updates_symbol_bucket_and_losses(
        self,
    ) -> None:
        signal = self._signal(bid="523.90", ask="524.00", price="523.95")
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }
        symbol_bucket = _init_funnel_stats()
        partial_cover = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("4"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("524.00"),
            rationale="test",
            params={},
        )
        all_closed_trades: list[object] = []

        cash = _apply_filled_decision(
            decision=partial_cover,
            signal=signal,
            fill_price=Decimal("524.00"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            symbol_bucket=symbol_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("15231.20"),
            all_closed_trades=all_closed_trades,
        )

        self.assertIn(("META", _SHARED_POSITION_OWNER), positions)
        self.assertEqual(positions[("META", _SHARED_POSITION_OWNER)].qty, Decimal("-6"))
        self.assertLess(day_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(day_bucket["losses"], 1)
        self.assertEqual(symbol_bucket["closed_trade_count"], 1)
        self.assertLess(symbol_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(len(all_closed_trades), 1)
        self.assertLess(cash, Decimal("15231.20"))

    def test_apply_filled_decision_sell_adds_to_existing_short(self) -> None:
        signal = self._signal(bid="523.90", ask="524.00", price="523.95")
        decision = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("5"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.90"),
            rationale="test",
            params={},
        )
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.90"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("15231.20"),
            all_closed_trades=[],
        )

        self.assertEqual(
            positions[("META", _SHARED_POSITION_OWNER)].qty, Decimal("-15")
        )
        self.assertEqual(
            positions[("META", _SHARED_POSITION_OWNER)].avg_entry_price,
            Decimal("523.4466666666666666666666667"),
        )
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertEqual(day_bucket["filled_notional"], Decimal("2619.50"))
        self.assertGreater(cash, Decimal("15231.20"))

    def test_replay_main_writes_trace_funnel_and_near_miss_outputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            trace_output = root / "trace.jsonl"
            funnel_output = root / "funnel.json"
            near_misses_output = root / "near-misses.json"

            args = Namespace(
                strategy_configmap="/tmp/strategies.yaml",
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="",
                clickhouse_password="",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=10,
                no_flatten_eod=False,
                start_equity="31590.02",
                symbols="",
                progress_log_seconds=30,
                max_executable_spread_bps="12",
                max_quote_mid_jump_bps="150",
                max_jump_with_wide_spread_bps="40",
                log_level="INFO",
                trace_output=trace_output,
                funnel_output=funnel_output,
                near_misses_output=near_misses_output,
                json=False,
            )

            payload = {
                "trace": [{"strategy_id": "breakout@prod", "passed": True}],
                "funnel": {"schema_version": "torghut.replay-funnel.v1", "buckets": []},
                "near_misses": [{"symbol": "AAPL"}],
            }
            with (
                patch(
                    "scripts.local_intraday_tsmom_replay._parse_args", return_value=args
                ),
                patch(
                    "scripts.local_intraday_tsmom_replay.run_replay",
                    return_value=payload,
                ),
                patch("builtins.print"),
            ):
                replay_main()

            self.assertEqual(
                trace_output.read_text(encoding="utf-8"),
                json.dumps(payload["trace"][0], sort_keys=True) + "\n",
            )
            self.assertEqual(
                json.loads(funnel_output.read_text(encoding="utf-8")),
                payload["funnel"],
            )
            self.assertEqual(
                json.loads(near_misses_output.read_text(encoding="utf-8")),
                payload["near_misses"],
            )

    def test_parse_args_accepts_collect_traces_flag(self) -> None:
        with patch.object(
            sys, "argv", ["local_intraday_tsmom_replay.py", "--collect-traces"]
        ):
            args = replay_main.__globals__["_parse_args"]()

        self.assertTrue(args.collect_traces)

    def test_parse_args_prefers_ta_clickhouse_env_defaults(self) -> None:
        with patch.dict(
            os.environ,
            {
                "TA_CLICKHOUSE_URL": "http://clickhouse.example:8123",
                "TA_CLICKHOUSE_USERNAME": "env-user",
                "TA_CLICKHOUSE_PASSWORD": "env-secret",
            },
            clear=False,
        ):
            with patch.object(sys, "argv", ["local_intraday_tsmom_replay.py"]):
                args = replay_main.__globals__["_parse_args"]()

        self.assertEqual(args.clickhouse_http_url, "http://clickhouse.example:8123")
        self.assertEqual(args.clickhouse_username, "env-user")
        self.assertEqual(args.clickhouse_password, "env-secret")

    def test_parse_args_uses_repo_root_strategy_configmap_by_default(self) -> None:
        with patch.object(sys, "argv", ["local_intraday_tsmom_replay.py"]):
            args = replay_main.__globals__["_parse_args"]()

        expected = (
            Path(__file__).resolve().parents[3]
            / "argocd/applications/torghut/strategy-configmap.yaml"
        )
        self.assertEqual(args.strategy_configmap, expected)
        self.assertTrue(args.strategy_configmap.exists())

    def test_replay_main_enables_trace_capture_for_funnel_and_near_miss_outputs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            funnel_output = root / "funnel.json"
            near_misses_output = root / "near-misses.json"

            args = Namespace(
                strategy_configmap="/tmp/strategies.yaml",
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="",
                clickhouse_password="",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=10,
                no_flatten_eod=False,
                start_equity="31590.02",
                symbols="",
                progress_log_seconds=30,
                max_executable_spread_bps="12",
                max_quote_mid_jump_bps="150",
                max_jump_with_wide_spread_bps="40",
                log_level="INFO",
                trace_output=None,
                funnel_output=funnel_output,
                near_misses_output=near_misses_output,
                collect_traces=False,
                json=False,
            )

            payload = {
                "trace": [],
                "funnel": {"schema_version": "torghut.replay-funnel.v1", "buckets": []},
                "near_misses": [],
            }

            with (
                patch(
                    "scripts.local_intraday_tsmom_replay._parse_args", return_value=args
                ),
                patch(
                    "scripts.local_intraday_tsmom_replay.run_replay",
                    return_value=payload,
                ) as run_replay_mock,
                patch("builtins.print"),
            ):
                replay_main()

            replay_config = run_replay_mock.call_args.args[0]
            self.assertTrue(replay_config.capture_traces)
            self.assertEqual(
                json.loads(funnel_output.read_text(encoding="utf-8")),
                payload["funnel"],
            )
            self.assertEqual(
                json.loads(near_misses_output.read_text(encoding="utf-8")),
                payload["near_misses"],
            )

    def test_run_replay_emits_trace_funnel_and_near_misses(self) -> None:
        strategy = Strategy(
            name="breakout-continuation-long-v1",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        decision_strategy_id = str(strategy.id)

        signal_open = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "imbalance_bid_sz": Decimal("60"),
                "imbalance_ask_sz": Decimal("40"),
                "spread": Decimal("0.10"),
            },
        )
        signal_fill = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 31, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": Decimal("99.45"),
                "imbalance_bid_px": Decimal("99.40"),
                "imbalance_ask_px": Decimal("99.50"),
                "imbalance_bid_sz": Decimal("70"),
                "imbalance_ask_sz": Decimal("50"),
                "spread": Decimal("0.10"),
            },
        )
        signal_follow = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=3,
            payload={
                "price": Decimal("101.50"),
                "imbalance_bid_px": Decimal("101.40"),
                "imbalance_ask_px": Decimal("101.50"),
                "imbalance_bid_sz": Decimal("80"),
                "imbalance_ask_sz": Decimal("60"),
                "spread": Decimal("0.10"),
            },
        )

        decision_one = StrategyDecision(
            strategy_id=decision_strategy_id,
            symbol="AAPL",
            event_ts=signal_open.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.00"),
            rationale="candidate_one",
            params={},
        )
        decision_two = StrategyDecision(
            strategy_id="replacement-strategy",
            symbol="AAPL",
            event_ts=signal_open.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.50"),
            rationale="candidate_two",
            params={},
        )

        passed_trace = StrategyTrace(
            strategy_id="replacement-strategy",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal_open.event_ts.isoformat(),
            timeframe="1Sec",
            passed=True,
            action="buy",
            gates=(
                GateTrace(
                    gate="eligibility",
                    category="eligibility",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )
        failed_trace = StrategyTrace(
            strategy_id="late-day-blocked",
            strategy_type="late_day_continuation_long",
            symbol="AAPL",
            event_ts=signal_fill.event_ts.isoformat(),
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="feed_quality",
            gates=(
                GateTrace(
                    gate="feed_quality",
                    category="feed_quality",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="recent_quote_invalid_ratio",
                            comparator="max_lte",
                            value=Decimal("0.22"),
                            threshold=Decimal("0.10"),
                            passed=False,
                            missing_policy="fail_closed",
                            distance_to_pass=Decimal("0.12"),
                        ),
                    ),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
                _ = args
                _ = kwargs
                self._call_index = 0

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self, signal: SignalEnvelope, strategies, *, equity, positions
            ):  # type: ignore[no-untyped-def]
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                self._call_index += 1
                if self._call_index == 1:
                    return [decision_one, decision_two]
                return []

            def consume_runtime_telemetry(self):  # type: ignore[no-untyped-def]
                if self._call_index == 1:
                    traces = [passed_trace]
                elif self._call_index == 2:
                    traces = [failed_trace]
                else:
                    traces = []
                return type("Telemetry", (), {"traces": traces})()

        class _Allocator:
            def allocate(self, raw_decisions, **kwargs):  # type: ignore[no-untyped-def]
                _ = kwargs
                return [
                    type(
                        "AllocationResult", (), {"approved": True, "decision": decision}
                    )()
                    for decision in raw_decisions
                ]

        class _Sizer:
            def size(self, decision, **kwargs):  # type: ignore[no-untyped-def]
                _ = kwargs
                return type(
                    "SizingResult", (), {"approved": True, "decision": decision}
                )()

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
            capture_exact_replay_ledger=True,
        )

        with (
            patch(
                "scripts.local_intraday_tsmom_replay._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.local_intraday_tsmom_replay._iter_signal_rows",
                return_value=iter([signal_open, signal_fill, signal_follow]),
            ),
            patch("scripts.local_intraday_tsmom_replay.DecisionEngine", _Engine),
            patch(
                "scripts.local_intraday_tsmom_replay.allocator_from_settings",
                return_value=_Allocator(),
            ),
            patch(
                "scripts.local_intraday_tsmom_replay.sizer_from_settings",
                return_value=_Sizer(),
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(payload["start_date"], "2026-03-26")
        self.assertEqual(payload["end_date"], "2026-03-27")
        self.assertEqual(len(payload["trace"]), 2)
        self.assertEqual(payload["trace"][0]["fill_status"], "pending")
        self.assertEqual(payload["trace"][1]["block_reason"], "feed_quality")
        self.assertEqual(payload["near_misses"][0]["first_failed_gate"], "feed_quality")
        self.assertEqual(
            payload["funnel"]["schema_version"], "torghut.replay-funnel.v1"
        )
        self.assertEqual(payload["funnel"]["buckets"][0]["trading_day"], "2026-03-26")
        self.assertGreaterEqual(payload["filled_count"], 2)
        lifecycle = payload["order_lifecycle"]
        self.assertEqual(lifecycle["submitted_order_count"], 2)
        self.assertEqual(lifecycle["filled_order_count"], 1)
        self.assertEqual(lifecycle["pending_censored_count"], 1)
        self.assertEqual(lifecycle["replaced_pending_count"], 1)
        self.assertTrue(lifecycle["fill_survival_evidence_present"])
        self.assertEqual(lifecycle["fill_survival_sample_count"], 2)
        self.assertEqual(lifecycle["fill_rate"], "0.5")
        self.assertEqual(lifecycle["fill_time_ms_p50"], 60000)
        self.assertEqual(
            lifecycle["fill_probability_by_latency_bucket"][">1000ms"]["fill_rate"], "1"
        )
        self.assertEqual(
            lifecycle["fill_probability_by_latency_threshold_ms"]["250"]["fill_rate"],
            "0",
        )
        self.assertEqual(
            lifecycle["censor_reason_counts"],
            {"pending_replaced": 1},
        )
        self.assertEqual(
            Decimal(str(lifecycle["depth_notional_min_at_order"])),
            Decimal("9994.00"),
        )
        self.assertEqual(
            Decimal(str(lifecycle["order_qty_to_touch_qty_ratio_p95"])),
            Decimal("0.05"),
        )
        self.assertEqual(
            Decimal(str(lifecycle["queue_touch_qty_avg"])),
            Decimal("40"),
        )
        self.assertEqual(
            Decimal(str(lifecycle["queue_touch_notional_avg"])),
            Decimal("4000.00"),
        )
        self.assertEqual(
            payload["order_lifecycle_by_day"]["2026-03-26"]["submitted_order_count"],
            2,
        )
        self.assertEqual(
            payload["order_lifecycle_by_symbol"]["AAPL"]["filled_order_count"],
            1,
        )
        self.assertEqual(
            lifecycle["post_cost_survivorship"]["closed_trade_count"],
            1,
        )
        exact_ledger = payload["exact_replay_ledger"]
        self.assertEqual(
            exact_ledger["schema_version"], "torghut.exact_replay_ledger.rows.v1"
        )
        self.assertEqual(exact_ledger["stage"], "replay")
        self.assertEqual(
            exact_ledger["promotion_authority"], "replay_artifact_only_not_live"
        )
        self.assertTrue(str(exact_ledger["candidate_id"]).startswith("exact-replay-"))
        self.assertEqual(
            exact_ledger["candidate_identity"]["candidate_id"],
            exact_ledger["candidate_id"],
        )
        self.assertEqual(
            exact_ledger["candidate_identity"]["candidate_identity_hash"],
            exact_ledger["candidate_identity_hash"],
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["cost_lineage_hash"],
            exact_ledger["cost_lineage_hash"],
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["warning_contract"],
            ["missing_adv", "participation_exceeds_max"],
        )
        self.assertEqual(exact_ledger["decision_row_count"], 3)
        self.assertEqual(exact_ledger["submitted_order_row_count"], 3)
        self.assertEqual(exact_ledger["fill_row_count"], 2)
        rows = exact_ledger["runtime_ledger_rows"]
        self.assertEqual(
            [row["event_type"] for row in rows],
            [
                "decision",
                "order_submitted",
                "order_cancelled",
                "decision",
                "order_submitted",
                "fill",
                "decision",
                "order_submitted",
                "fill",
            ],
        )
        fill_rows = [row for row in rows if row["event_type"] == "fill"]
        self.assertEqual(
            [row["candidate_identity_hash"] for row in fill_rows],
            [exact_ledger["candidate_identity_hash"]] * 2,
        )
        self.assertEqual(
            [row["cost_lineage_hash"] for row in fill_rows],
            [exact_ledger["cost_lineage_hash"]] * 2,
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["capacity_warning_counts"],
            {"missing_adv": 2},
        )
        self.assertEqual(
            [row["capacity_warning_codes"] for row in fill_rows],
            [["missing_adv"], ["missing_adv"]],
        )
        ledger_bucket = build_runtime_ledger_buckets(
            rows,
            bucket_ranges=[
                (
                    datetime(2026, 3, 26, 17, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 26, 21, 0, tzinfo=timezone.utc),
                )
            ],
            require_order_lifecycle=True,
        )[0]
        self.assertEqual(ledger_bucket.fill_count, 2)
        self.assertEqual(ledger_bucket.closed_trade_count, 1)
        self.assertNotIn("unclosed_position", ledger_bucket.blockers)
        self.assertNotIn("cost_model_hash_missing", ledger_bucket.blockers)
        self.assertNotIn("unfilled_order_present", ledger_bucket.blockers)

    def test_run_replay_enriches_day_two_open_with_prev_day_open45_ranks(self) -> None:
        strategy = Strategy(
            name="observer",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "META"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        observed_signals: list[SignalEnvelope] = []

        day_one_aapl_open = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 13, 30, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("100"),
                "imbalance_bid_px": Decimal("99.95"),
                "imbalance_ask_px": Decimal("100.05"),
                "imbalance_bid_sz": Decimal("100"),
                "imbalance_ask_sz": Decimal("100"),
                "spread": Decimal("0.10"),
            },
        )
        day_one_meta_open = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 13, 30, 1, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": Decimal("100"),
                "imbalance_bid_px": Decimal("99.95"),
                "imbalance_ask_px": Decimal("100.05"),
                "imbalance_bid_sz": Decimal("100"),
                "imbalance_ask_sz": Decimal("100"),
                "spread": Decimal("0.10"),
            },
        )
        day_one_aapl_45 = day_one_aapl_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 27, 14, 15, 0, tzinfo=timezone.utc),
                "seq": 3,
                "payload": {
                    **day_one_aapl_open.payload,
                    "price": Decimal("105"),
                    "imbalance_bid_px": Decimal("104.95"),
                    "imbalance_ask_px": Decimal("105.05"),
                },
            }
        )
        day_one_meta_45 = day_one_meta_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 27, 14, 15, 0, tzinfo=timezone.utc),
                "seq": 4,
                "payload": {
                    **day_one_meta_open.payload,
                    "price": Decimal("95"),
                    "imbalance_bid_px": Decimal("94.95"),
                    "imbalance_ask_px": Decimal("95.05"),
                },
            }
        )
        day_two_aapl_open = day_one_aapl_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc),
                "seq": 5,
            }
        )
        day_two_meta_open = day_one_meta_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc),
                "seq": 6,
            }
        )

        class _Engine:
            def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self, signal: SignalEnvelope, strategies, *, equity, positions
            ):  # type: ignore[no-untyped-def]
                _ = strategies
                _ = equity
                _ = positions
                observed_signals.append(signal)
                return []

            def consume_runtime_telemetry(self):  # type: ignore[no-untyped-def]
                return type("Telemetry", (), {"traces": []})()

        class _Allocator:
            def allocate(self, raw_decisions, **kwargs):  # type: ignore[no-untyped-def]
                _ = raw_decisions
                _ = kwargs
                return []

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 30, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=False,
        )

        with (
            patch(
                "scripts.local_intraday_tsmom_replay._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.local_intraday_tsmom_replay._iter_signal_rows",
                return_value=iter(
                    [
                        day_one_aapl_open,
                        day_one_meta_open,
                        day_one_aapl_45,
                        day_one_meta_45,
                        day_two_aapl_open,
                        day_two_meta_open,
                    ]
                ),
            ),
            patch("scripts.local_intraday_tsmom_replay.DecisionEngine", _Engine),
            patch(
                "scripts.local_intraday_tsmom_replay.allocator_from_settings",
                return_value=_Allocator(),
            ),
        ):
            run_replay(config)

        aapl_day_two = next(
            signal
            for signal in observed_signals
            if signal.symbol == "AAPL"
            and signal.event_ts == datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc)
        )
        meta_day_two = next(
            signal
            for signal in observed_signals
            if signal.symbol == "META"
            and signal.event_ts == datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc)
        )

        self.assertEqual(
            aapl_day_two.payload["cross_section_prev_day_open45_return_rank"],
            Decimal("1"),
        )
        self.assertEqual(
            meta_day_two.payload["cross_section_prev_day_open45_return_rank"],
            Decimal("0"),
        )

    def test_run_replay_marks_passed_trace_with_sizer_reject_reason(self) -> None:
        strategy = Strategy(
            name="breakout-continuation-long-v1",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        decision_strategy_id = str(strategy.id)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "spread": Decimal("0.10"),
            },
        )
        decision = StrategyDecision(
            strategy_id=decision_strategy_id,
            symbol="AAPL",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.00"),
            rationale="candidate_one",
            params={},
        )
        passed_trace = StrategyTrace(
            strategy_id=decision_strategy_id,
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal.event_ts.isoformat(),
            timeframe="1Sec",
            passed=True,
            action="buy",
            gates=(
                GateTrace(
                    gate="eligibility",
                    category="eligibility",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self, signal: SignalEnvelope, strategies, *, equity, positions
            ):  # type: ignore[no-untyped-def]
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return [decision]

            def consume_runtime_telemetry(self):  # type: ignore[no-untyped-def]
                return type("Telemetry", (), {"traces": [passed_trace]})()

        class _Allocator:
            def allocate(self, raw_decisions, **kwargs):  # type: ignore[no-untyped-def]
                _ = raw_decisions
                _ = kwargs
                return [
                    type(
                        "AllocationResult", (), {"approved": True, "decision": decision}
                    )()
                ]

        class _Sizer:
            def size(self, decision, **kwargs):  # type: ignore[no-untyped-def]
                _ = decision
                _ = kwargs
                return type(
                    "SizingResult",
                    (),
                    {"approved": False, "decision": decision, "reasons": []},
                )()

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.local_intraday_tsmom_replay._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.local_intraday_tsmom_replay._iter_signal_rows",
                return_value=iter([signal]),
            ),
            patch("scripts.local_intraday_tsmom_replay.DecisionEngine", _Engine),
            patch(
                "scripts.local_intraday_tsmom_replay.allocator_from_settings",
                return_value=_Allocator(),
            ),
            patch(
                "scripts.local_intraday_tsmom_replay.sizer_from_settings",
                return_value=_Sizer(),
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(len(payload["trace"]), 1)
        self.assertTrue(payload["trace"][0]["strategy_trace"]["passed"])
        self.assertFalse(payload["trace"][0]["decision_emitted"])
        self.assertEqual(payload["trace"][0]["fill_status"], "none")
        self.assertEqual(payload["trace"][0]["block_reason"], "sizer_rejected")

    def test_run_replay_marks_passed_trace_with_allocator_reject_reason(self) -> None:
        strategy = Strategy(
            name="breakout-continuation-long-v1",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        decision_strategy_id = str(strategy.id)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "spread": Decimal("0.10"),
            },
        )
        decision = StrategyDecision(
            strategy_id=decision_strategy_id,
            symbol="AAPL",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.00"),
            rationale="candidate_one",
            params={},
        )
        passed_trace = StrategyTrace(
            strategy_id=decision_strategy_id,
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal.event_ts.isoformat(),
            timeframe="1Sec",
            passed=True,
            action="buy",
            gates=(
                GateTrace(
                    gate="eligibility",
                    category="eligibility",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self, signal: SignalEnvelope, strategies, *, equity, positions
            ):  # type: ignore[no-untyped-def]
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return [decision]

            def consume_runtime_telemetry(self):  # type: ignore[no-untyped-def]
                return type("Telemetry", (), {"traces": [passed_trace]})()

        class _Allocator:
            def allocate(self, raw_decisions, **kwargs):  # type: ignore[no-untyped-def]
                _ = raw_decisions
                _ = kwargs
                return [
                    type(
                        "AllocationResult",
                        (),
                        {
                            "approved": False,
                            "decision": decision,
                            "reason_codes": ("allocator_reject_symbol_capacity",),
                        },
                    )()
                ]

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.local_intraday_tsmom_replay._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.local_intraday_tsmom_replay._iter_signal_rows",
                return_value=iter([signal]),
            ),
            patch("scripts.local_intraday_tsmom_replay.DecisionEngine", _Engine),
            patch(
                "scripts.local_intraday_tsmom_replay.allocator_from_settings",
                return_value=_Allocator(),
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(len(payload["trace"]), 1)
        self.assertEqual(
            payload["trace"][0]["block_reason"], "allocator_reject_symbol_capacity"
        )

    def test_run_replay_marks_passed_trace_with_runtime_suppression_reason(
        self,
    ) -> None:
        strategy = Strategy(
            name="breakout-continuation-long-v1",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        decision_strategy_id = str(strategy.id)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "spread": Decimal("0.10"),
            },
        )
        passed_trace = StrategyTrace(
            strategy_id=decision_strategy_id,
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal.event_ts.isoformat(),
            timeframe="1Sec",
            passed=True,
            action="buy",
            gates=(
                GateTrace(
                    gate="eligibility",
                    category="eligibility",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self, signal: SignalEnvelope, strategies, *, equity, positions
            ):  # type: ignore[no-untyped-def]
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return []

            def consume_runtime_telemetry(self):  # type: ignore[no-untyped-def]
                observation = type(
                    "Observation",
                    (),
                    {
                        "strategy_intents_total": {decision_strategy_id},
                        "strategy_intent_suppression_total": {
                            f"{decision_strategy_id}|runtime_trade_policy_blocked": 1
                        },
                    },
                )()
                return type(
                    "Telemetry",
                    (),
                    {"traces": [passed_trace], "observation": observation},
                )()

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.local_intraday_tsmom_replay._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.local_intraday_tsmom_replay._iter_signal_rows",
                return_value=iter([signal]),
            ),
            patch("scripts.local_intraday_tsmom_replay.DecisionEngine", _Engine),
        ):
            payload = run_replay(config)

        self.assertEqual(len(payload["trace"]), 1)
        self.assertEqual(
            payload["trace"][0]["block_reason"], "runtime_trade_policy_blocked"
        )

    def test_run_replay_serializes_real_daily_liquidity_evidence(self) -> None:
        strategy = Strategy(
            name="observer",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal_one = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("10.00"),
                "imbalance_bid_px": Decimal("9.995"),
                "imbalance_ask_px": Decimal("10.005"),
                "imbalance_bid_sz": Decimal("50"),
                "imbalance_ask_sz": Decimal("40"),
                "microbar_volume": Decimal("100"),
                "spread": Decimal("0.01"),
            },
        )
        signal_two = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": Decimal("11.00"),
                "imbalance_bid_px": Decimal("10.995"),
                "imbalance_ask_px": Decimal("11.005"),
                "imbalance_bid_sz": Decimal("20"),
                "imbalance_ask_sz": Decimal("10"),
                "microbar_volume": Decimal("200"),
                "spread": Decimal("0.01"),
            },
        )

        class _Engine:
            def __init__(self, *args, **kwargs) -> None:  # type: ignore[no-untyped-def]
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self, signal: SignalEnvelope, strategies, *, equity, positions
            ):  # type: ignore[no-untyped-def]
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return []

            def consume_runtime_telemetry(self):  # type: ignore[no-untyped-def]
                return type("Telemetry", (), {"traces": []})()

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.local_intraday_tsmom_replay._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.local_intraday_tsmom_replay._iter_signal_rows",
                return_value=iter([signal_one, signal_two]),
            ),
            patch("scripts.local_intraday_tsmom_replay.DecisionEngine", _Engine),
        ):
            payload = run_replay(config)

        daily = payload["daily"]["2026-03-26"]
        self.assertEqual(Decimal(daily["daily_adv_notional"]), Decimal("3200.00"))
        self.assertEqual(Decimal(daily["depth_notional"]), Decimal("329.950"))
        self.assertEqual(daily["liquidity_observation_count"], 2)
