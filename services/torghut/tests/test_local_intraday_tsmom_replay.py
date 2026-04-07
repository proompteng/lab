from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from argparse import Namespace
from unittest import TestCase
from unittest.mock import patch

from app.trading.costs import TransactionCostModel
from app.trading.evaluation_trace import (
    GateTrace,
    NearMissRecord,
    StrategyTrace,
    ThresholdTrace,
)
from app.models import Strategy
from app.trading.models import SignalEnvelope, StrategyDecision
from scripts.local_intraday_tsmom_replay import (
    PendingOrder,
    PositionState,
    ReplayConfig,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision,
    _apply_order_preferences,
    _build_near_miss,
    _init_funnel_stats,
    _insert_near_miss,
    _parse_signal_row,
    _positions_payload,
    _quote_quality_status,
    _record_trace_for_funnel,
    _reconcile_pending_order_before_immediate_fill,
    _resolve_pending_fill_price,
    _should_replace_pending_order,
    main as replay_main,
    run_replay,
)


class TestLocalIntradayTsmomReplay(TestCase):
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
            ]
        )

        assert parsed is not None
        self.assertEqual(parsed.payload["vwap_session"], Decimal("522.95"))
        self.assertEqual(parsed.payload["vwap_w5m"], Decimal("523.05"))
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
            dict(funnel["gate_pass_counts"]),
            {"breakout_continuation_long:structure": 1},
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

    def test_run_replay_marks_passed_trace_with_engine_runtime_filter_reason(self) -> None:
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
                return type("Telemetry", (), {"traces": [passed_trace]})()

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
            payload["trace"][0]["block_reason"], "engine_runtime_filter_rejected"
        )
