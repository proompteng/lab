from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.trading.costs import TransactionCostModel
from app.trading.models import SignalEnvelope, StrategyDecision
from scripts.local_intraday_tsmom_replay import (
    PendingOrder,
    PositionState,
    ReplayConfig,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision,
    _apply_order_preferences,
    _parse_signal_row,
    _positions_payload,
    _quote_quality_status,
    _reconcile_pending_order_before_immediate_fill,
    _resolve_pending_fill_price,
    _should_replace_pending_order,
)


class TestLocalIntradayTsmomReplay(TestCase):
    def _signal(self, *, bid: str, ask: str, price: str) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 24, tzinfo=timezone.utc),
            symbol='META',
            timeframe='1Sec',
            seq=12,
            payload={
                'price': Decimal(price),
                'imbalance_bid_px': Decimal(bid),
                'imbalance_ask_px': Decimal(ask),
                'spread': Decimal(ask) - Decimal(bid),
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
            strategy_id='intraday_tsmom_v1@prod',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe='1Sec',
            action=action,
            qty=Decimal('10'),
            order_type=order_type,
            time_in_force='day',
            limit_price=Decimal(limit_price) if limit_price is not None else None,
            rationale='test',
            params={},
        )

    def test_limit_sell_does_not_fill_below_limit(self) -> None:
        decision = self._decision(action='sell', order_type='limit', limit_price='524.10')
        signal = self._signal(bid='523.22', ask='523.28', price='523.25')

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertIsNone(fill_price)

    def test_limit_sell_fills_at_bid_when_bid_crosses_limit(self) -> None:
        decision = self._decision(action='sell', order_type='limit', limit_price='524.10')
        signal = self._signal(bid='524.18', ask='524.24', price='524.21')

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal('524.18'))

    def test_limit_buy_fills_at_ask_when_ask_is_inside_limit(self) -> None:
        decision = self._decision(action='buy', order_type='limit', limit_price='593.95')
        signal = self._signal(bid='593.70', ask='593.80', price='593.75')

        fill_price = _resolve_pending_fill_price(decision, signal)

        self.assertEqual(fill_price, Decimal('593.80'))

    def test_apply_filled_decision_opens_position_on_same_signal(self) -> None:
        signal = self._signal(bid='523.22', ask='523.28', price='523.25')
        decision = self._decision(action='buy', order_type='limit', limit_price='523.28')
        positions: dict[tuple[str, str], PositionState] = {}
        day_bucket = {
            'decision_count': 1,
            'filled_count': 0,
            'gross_pnl': Decimal('0'),
            'net_pnl': Decimal('0'),
            'cost_total': Decimal('0'),
            'wins': 0,
            'losses': 0,
            'closed_trades': [],
        }

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal('523.28'),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal('10000'),
            all_closed_trades=[],
        )

        self.assertIn(('META', _SHARED_POSITION_OWNER), positions)
        position = positions[('META', _SHARED_POSITION_OWNER)]
        self.assertEqual(position.avg_entry_price, Decimal('523.28'))
        self.assertEqual(position.qty, Decimal('10'))
        self.assertEqual(day_bucket['filled_count'], 1)
        self.assertLess(cash, Decimal('10000'))

    def test_quote_quality_rejects_wide_spread_outlier(self) -> None:
        signal = self._signal(bid='239.11', ask='253.69', price='246.40')
        config = ReplayConfig(
            strategy_configmap_path=Path('/tmp/strategies.yaml'),
            clickhouse_http_url='http://localhost:8123',
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal('31590.02'),
        )

        status = _quote_quality_status(
            signal=signal,
            previous_price=Decimal('253.70'),
            config=config,
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, 'spread_bps_exceeded')

    def test_quote_quality_accepts_normal_tight_quote(self) -> None:
        signal = self._signal(bid='253.69', ask='253.72', price='253.705')
        config = ReplayConfig(
            strategy_configmap_path=Path('/tmp/strategies.yaml'),
            clickhouse_http_url='http://localhost:8123',
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal('31590.02'),
        )

        status = _quote_quality_status(
            signal=signal,
            previous_price=Decimal('253.68'),
            config=config,
        )

        self.assertTrue(status.valid)

    def test_session_flatten_exit_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id='intraday_tsmom_v1@prod',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe='1Sec',
            action='sell',
            qty=Decimal('10'),
            order_type='market',
            time_in_force='day',
            rationale='session_flatten_exit',
            params={'position_exit': {'type': 'session_flatten_minute_utc'}},
        )
        signal = self._signal(bid='524.90', ask='525.10', price='525.00')

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, 'market')
        self.assertIsNone(updated.limit_price)

    def test_session_flatten_exit_replaces_resting_sell_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id='intraday_tsmom_v1@prod',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe='1Sec',
            action='sell',
            qty=Decimal('10'),
            order_type='limit',
            time_in_force='day',
            limit_price=Decimal('524.10'),
            rationale='signal_exit',
            params={'position_exit': {'type': 'signal_exit'}},
        )
        replacement = StrategyDecision(
            strategy_id='intraday_tsmom_v1@prod',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe='1Sec',
            action='sell',
            qty=Decimal('10'),
            order_type='market',
            time_in_force='day',
            rationale='session_flatten_exit',
            params={'position_exit': {'type': 'session_flatten_minute_utc'}},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_more_aggressive_sell_limit_replaces_resting_sell_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id='intraday_tsmom_v1@prod',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe='1Sec',
            action='sell',
            qty=Decimal('10'),
            order_type='limit',
            time_in_force='day',
            limit_price=Decimal('524.10'),
            rationale='signal_exit',
            params={'position_exit': {'type': 'signal_exit'}},
        )
        replacement = StrategyDecision(
            strategy_id='intraday_tsmom_v1@prod',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe='1Sec',
            action='sell',
            qty=Decimal('10'),
            order_type='limit',
            time_in_force='day',
            limit_price=Decimal('523.80'),
            rationale='signal_exit',
            params={'position_exit': {'type': 'signal_exit'}},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_immediate_fill_clears_existing_pending_order_for_same_position_owner(self) -> None:
        signal = self._signal(bid='523.22', ask='523.28', price='523.25')
        existing_pending = PendingOrder(
            decision=self._decision(action='buy', order_type='limit', limit_price='523.10'),
            created_at=datetime(2026, 3, 27, 17, 29, 55, tzinfo=timezone.utc),
            signal=signal,
        )
        pending_orders = {('META', _SHARED_POSITION_OWNER): existing_pending}
        immediate_decision = self._decision(action='buy', order_type='limit', limit_price='523.40')

        _reconcile_pending_order_before_immediate_fill(
            decision=immediate_decision,
            pending_orders=pending_orders,
            created_at=signal.event_ts,
        )

        self.assertNotIn(('META', _SHARED_POSITION_OWNER), pending_orders)

    def test_positions_payload_projects_pending_buy_exposure(self) -> None:
        signal = self._signal(bid='523.22', ask='523.28', price='523.25')
        pending_buy = PendingOrder(
            decision=self._decision(action='buy', order_type='limit', limit_price='523.40'),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            {},
            {},
            {('META', _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(payload, [
            {
                'symbol': 'META',
                'strategy_id': _SHARED_POSITION_OWNER,
                'qty': '10',
                'side': 'long',
                'market_value': '5234.00',
                'avg_entry_price': '523.40',
                'opened_at': signal.event_ts.isoformat(),
                'decision_at': pending_buy.created_at.isoformat(),
                'pending_entry': True,
            }
        ])

    def test_positions_payload_projects_pending_sell_against_existing_long(self) -> None:
        positions = {
            ('META', _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal('10'),
                avg_entry_price=Decimal('520'),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal('0'),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid='523.22', ask='523.28', price='523.25')
        pending_sell = PendingOrder(
            decision=self._decision(action='sell', order_type='limit', limit_price='523.10'),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {'META': Decimal('523.25')},
            {('META', _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(payload, [])

    def test_positions_payload_keeps_other_strategy_position_when_isolated_sell_pending(self) -> None:
        positions = {
            ('META', 'breakout_continuation_long_v1@research'): PositionState(
                strategy_id='breakout_continuation_long_v1@research',
                qty=Decimal('10'),
                avg_entry_price=Decimal('520'),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal('0'),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
            ('META', 'mean_reversion_rebound_long_v1@research'): PositionState(
                strategy_id='mean_reversion_rebound_long_v1@research',
                qty=Decimal('6'),
                avg_entry_price=Decimal('521'),
                opened_at=datetime(2026, 3, 27, 17, 5, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal('0'),
                decision_at=datetime(2026, 3, 27, 17, 5, 0, tzinfo=timezone.utc),
            ),
        }
        signal = self._signal(bid='523.22', ask='523.28', price='523.25')
        pending_sell = StrategyDecision(
            strategy_id='mean_reversion_rebound_long_v1@research',
            symbol='META',
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe='1Sec',
            action='sell',
            qty=Decimal('6'),
            order_type='limit',
            time_in_force='day',
            limit_price=Decimal('523.10'),
            rationale='mean_reversion_rebound_exit',
            params={'strategy_runtime': {'position_isolation_mode': 'per_strategy'}},
        )

        payload = _positions_payload(
            positions,
            {'META': Decimal('523.25')},
            {
                ('META', 'mean_reversion_rebound_long_v1@research'): PendingOrder(
                    decision=pending_sell,
                    created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
                    signal=signal,
                )
            },
        )

        self.assertEqual(payload, [
            {
                'symbol': 'META',
                'strategy_id': 'breakout_continuation_long_v1@research',
                'qty': '10',
                'side': 'long',
                'market_value': '5232.50',
                'avg_entry_price': '520',
                'opened_at': '2026-03-27T17:00:00+00:00',
                'decision_at': '2026-03-27T17:00:00+00:00',
                'pending_entry': False,
            }
        ])

    def test_parse_signal_row_preserves_vwap_and_imbalance_sizes(self) -> None:
        parsed = _parse_signal_row(
            [
                'META',
                '2026-03-27 17:30:24.000',
                '12',
                '0.031',
                '0.019',
                '523.10',
                '522.80',
                '57',
                '523.25',
                '523.22',
                '523.28',
                '0.06',
                '1200',
                '800',
                '0.06',
                '522.95',
                '523.05',
                '0.00018',
            ]
        )

        assert parsed is not None
        self.assertEqual(parsed.payload['vwap_session'], Decimal('522.95'))
        self.assertEqual(parsed.payload['vwap_w5m'], Decimal('523.05'))
        self.assertEqual(parsed.payload['imbalance_bid_sz'], Decimal('1200'))
        self.assertEqual(parsed.payload['imbalance_ask_sz'], Decimal('800'))
        imbalance = parsed.payload['imbalance']
        assert isinstance(imbalance, dict)
        self.assertEqual(imbalance['bid_sz'], Decimal('1200'))
        self.assertEqual(imbalance['ask_sz'], Decimal('800'))
