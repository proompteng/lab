from __future__ import annotations

from datetime import datetime, time, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.config import settings
from app.trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionPreflightFailed,
)
from app.trading.prices import MarketSnapshot
from app.trading.models import StrategyDecision
from app.trading.scheduler.capital_controls import (
    CapitalRiskSnapshot,
    CapitalSafetyController,
)


class _ExecutionAdapter:
    def __init__(self, positions: list[dict[str, str]]) -> None:
        self.positions = positions
        self.cancel_calls = 0
        self.submissions = []

    def cancel_all_orders(self):
        self.cancel_calls += 1
        return []

    def list_positions(self):
        return list(self.positions)

    def list_orders(self, status="all"):
        _ = status
        return []

    def submit_risk_reducing_order(self, submission):
        self.submissions.append(submission)
        self.positions = []
        return {"id": "close-1", "status": "accepted"}


class _PriceFetcher:
    def fetch_market_snapshot(self, signal):
        return MarketSnapshot(
            symbol=signal.symbol,
            as_of=signal.event_ts,
            price=Decimal("100"),
            spread=Decimal("0.02"),
            source="alpaca_latest_quote",
            bid=Decimal("99.99"),
            ask=Decimal("100.01"),
        )


def _state() -> SimpleNamespace:
    return SimpleNamespace(
        emergency_stop_active=False,
        emergency_stop_reason=None,
        emergency_stop_triggered_at=None,
        capital_new_exposure_allowed=True,
        capital_current_equity=None,
        capital_daily_start_equity=None,
        capital_high_water_equity=None,
        capital_daily_loss_ratio=None,
        capital_drawdown_ratio=None,
        capital_last_evaluated_at=None,
        capital_closeout_in_progress=False,
        capital_closeout_reason=None,
        capital_closeout_attempts=0,
        capital_flat_confirmed_at=None,
        last_error=None,
    )


class TestCapitalSafetyController(TestCase):
    def _controller(self, adapter: _ExecutionAdapter | None = None):
        return CapitalSafetyController(
            execution_adapter=adapter or _ExecutionAdapter([]),
            price_fetcher=_PriceFetcher(),
            state=_state(),
            account_label="live-account",
            sleep=lambda _seconds: None,
        )

    def test_equity_stop_thresholds_are_account_ratios(self) -> None:
        controller = self._controller()
        daily_stop = CapitalRiskSnapshot(
            current_equity=Decimal("9900"),
            daily_start_equity=Decimal("10000"),
            high_water_equity=Decimal("10000"),
            daily_loss_ratio=Decimal("0.01"),
            drawdown_ratio=Decimal("0.01"),
        )
        drawdown_stop = CapitalRiskSnapshot(
            current_equity=Decimal("9500"),
            daily_start_equity=Decimal("9500"),
            high_water_equity=Decimal("10000"),
            daily_loss_ratio=Decimal("0"),
            drawdown_ratio=Decimal("0.05"),
        )

        self.assertEqual(
            controller._equity_stop_reason(daily_stop),
            "daily_loss_stop:0.01000000",
        )
        self.assertEqual(
            controller._equity_stop_reason(drawdown_stop),
            "persistent_drawdown_stop:0.05000000",
        )

    def test_required_stale_ledger_latches_stop_and_flattens(self) -> None:
        adapter = _ExecutionAdapter([])
        controller = self._controller(adapter)
        now = datetime(2026, 7, 10, 15, 0, tzinfo=ZoneInfo("America/New_York"))
        risk = CapitalRiskSnapshot(
            current_equity=Decimal("10000"),
            daily_start_equity=Decimal("10000"),
            high_water_equity=Decimal("10000"),
            daily_loss_ratio=Decimal("0"),
            drawdown_ratio=Decimal("0"),
        )

        with (
            patch.object(settings, "trading_mode", "live"),
            patch.object(settings, "tigerbeetle_required", True),
            patch.object(settings, "tigerbeetle_reconcile_required", True),
            patch.object(controller, "_load_risk_snapshot", return_value=risk),
            patch(
                "app.trading.scheduler.capital_controls.check_tigerbeetle_health",
                return_value=SimpleNamespace(enabled=True, ok=True),
            ),
            patch(
                "app.trading.scheduler.capital_controls.latest_tigerbeetle_reconciliation_status_payload",
                return_value={
                    "ok": True,
                    "reconciliation_stale": True,
                    "blockers": [],
                },
            ),
        ):
            controller.evaluate(
                SimpleNamespace(),
                SimpleNamespace(as_of=now),
            )

        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn(
            "tigerbeetle_reconciliation_stale",
            controller.state.emergency_stop_reason,
        )
        self.assertEqual(controller.state.capital_ledger_state, "blocked")
        self.assertEqual(adapter.cancel_calls, 1)

    def test_required_protocol_without_reconciliation_does_not_read_stale_audit(
        self,
    ) -> None:
        controller = self._controller()

        with (
            patch.object(settings, "tigerbeetle_required", True),
            patch.object(settings, "tigerbeetle_reconcile_required", False),
            patch(
                "app.trading.scheduler.capital_controls.check_tigerbeetle_health",
                return_value=SimpleNamespace(enabled=True, ok=True),
            ),
            patch(
                "app.trading.scheduler.capital_controls.latest_tigerbeetle_reconciliation_status_payload",
                side_effect=AssertionError(
                    "periodic reconciliation should not be read"
                ),
            ),
        ):
            reason = controller._ledger_stop_reason(
                SimpleNamespace(),
                now=datetime(2026, 7, 10, 15, 0, tzinfo=ZoneInfo("America/New_York")),
            )

        self.assertIsNone(reason)
        self.assertEqual(controller.state.capital_ledger_state, "current")

    def test_required_protocol_failure_latches_stop_without_reconciliation(
        self,
    ) -> None:
        adapter = _ExecutionAdapter([])
        controller = self._controller(adapter)
        now = datetime(2026, 7, 10, 15, 0, tzinfo=ZoneInfo("America/New_York"))
        risk = CapitalRiskSnapshot(
            current_equity=Decimal("10000"),
            daily_start_equity=Decimal("10000"),
            high_water_equity=Decimal("10000"),
            daily_loss_ratio=Decimal("0"),
            drawdown_ratio=Decimal("0"),
        )

        with (
            patch.object(settings, "trading_mode", "live"),
            patch.object(settings, "tigerbeetle_required", True),
            patch.object(settings, "tigerbeetle_reconcile_required", False),
            patch.object(controller, "_load_risk_snapshot", return_value=risk),
            patch(
                "app.trading.scheduler.capital_controls.check_tigerbeetle_health",
                return_value=SimpleNamespace(enabled=True, ok=False),
            ),
            patch(
                "app.trading.scheduler.capital_controls.latest_tigerbeetle_reconciliation_status_payload",
                side_effect=AssertionError(
                    "periodic reconciliation should not be read"
                ),
            ),
        ):
            controller.evaluate(SimpleNamespace(), SimpleNamespace(as_of=now))

        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn(
            "tigerbeetle_protocol_unavailable",
            controller.state.emergency_stop_reason,
        )
        self.assertEqual(controller.state.capital_ledger_state, "blocked")
        self.assertEqual(adapter.cancel_calls, 1)

    def test_required_protocol_check_error_fails_closed(self) -> None:
        controller = self._controller()
        now = datetime(2026, 7, 10, 15, 0, tzinfo=ZoneInfo("America/New_York"))

        with (
            patch.object(settings, "tigerbeetle_required", True),
            patch.object(settings, "tigerbeetle_reconcile_required", False),
            patch(
                "app.trading.scheduler.capital_controls.check_tigerbeetle_health",
                side_effect=ModuleNotFoundError("tigerbeetle package unavailable"),
            ),
        ):
            reason = controller._ledger_stop_reason(SimpleNamespace(), now=now)

        self.assertEqual(reason, "tigerbeetle_protocol_unavailable:ModuleNotFoundError")
        self.assertEqual(controller.state.capital_ledger_state, "blocked")
        self.assertEqual(controller.state.capital_ledger_reason, reason)

    def test_new_exposure_is_blocked_at_1530_et(self) -> None:
        controller = self._controller()
        now = datetime(2026, 7, 10, 15, 30, tzinfo=ZoneInfo("America/New_York"))
        risk = CapitalRiskSnapshot(
            current_equity=Decimal("10000"),
            daily_start_equity=Decimal("10000"),
            high_water_equity=Decimal("10000"),
            daily_loss_ratio=Decimal("0"),
            drawdown_ratio=Decimal("0"),
        )

        with (
            patch(
                "app.trading.scheduler.capital_controls.trading_now",
                return_value=now,
            ),
            patch.object(controller, "_load_risk_snapshot", return_value=risk),
            patch.object(settings, "trading_mode", "live"),
        ):
            controller.evaluate(SimpleNamespace(), SimpleNamespace())

        self.assertFalse(controller.state.capital_new_exposure_allowed)
        self.assertFalse(controller.state.emergency_stop_active)

    def test_midnight_cutoff_freezes_entry_without_disabling_closeout_controller(
        self,
    ) -> None:
        adapter = _ExecutionAdapter([])
        controller = self._controller(adapter)
        now = datetime(2026, 7, 10, 9, 30, tzinfo=ZoneInfo("America/New_York"))
        risk = CapitalRiskSnapshot(
            current_equity=Decimal("10000"),
            daily_start_equity=Decimal("10000"),
            high_water_equity=Decimal("10000"),
            daily_loss_ratio=Decimal("0"),
            drawdown_ratio=Decimal("0"),
        )

        with (
            patch.object(controller, "_load_risk_snapshot", return_value=risk),
            patch.object(settings, "trading_mode", "live"),
            patch.object(settings, "trading_new_exposure_cutoff_time_et", time(0, 0)),
        ):
            controller.evaluate(SimpleNamespace(), SimpleNamespace(as_of=now))

        self.assertFalse(controller.state.capital_new_exposure_allowed)
        self.assertFalse(controller.state.emergency_stop_active)
        self.assertEqual(adapter.cancel_calls, 0)
        self.assertEqual(adapter.submissions, [])

    def test_closeout_uses_marketable_limit_and_confirms_flat(self) -> None:
        adapter = _ExecutionAdapter(
            [
                {
                    "symbol": "NVDA",
                    "qty": "10",
                    "side": "long",
                    "current_price": "100",
                }
            ]
        )
        controller = self._controller(adapter)
        now = datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC"))

        controller._flatten(reason="scheduled_closeout", now=now)

        self.assertEqual(adapter.cancel_calls, 1)
        self.assertEqual(len(adapter.submissions), 1)
        submission = adapter.submissions[0]
        self.assertEqual(submission.symbol, "NVDA")
        self.assertEqual(submission.side, "sell")
        self.assertEqual(submission.order_type, "limit")
        self.assertEqual(submission.limit_price, 99.91)
        self.assertIsNotNone(controller.state.capital_flat_confirmed_at)

    def test_missing_quote_blocks_unbounded_market_exit(self) -> None:
        controller = self._controller()
        controller.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda _signal: None
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "capital_closeout_price_unavailable",
        ):
            controller._close_submission(
                {"symbol": "AMD", "qty": "2", "side": "short"},
                now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
                attempt=1,
            )

    def test_closeout_normalizes_negative_short_quantity(self) -> None:
        adapter = _ExecutionAdapter(
            [
                {
                    "symbol": "AMD",
                    "qty": "-2",
                    "side": "short",
                    "current_price": "100",
                }
            ]
        )
        controller = self._controller(adapter)

        controller._flatten(
            reason="scheduled_closeout",
            now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
        )

        self.assertEqual(len(adapter.submissions), 1)
        submission = adapter.submissions[0]
        self.assertEqual(submission.side, "buy")
        self.assertEqual(submission.qty, 2.0)

    def test_closeout_continues_after_released_preflight_race(self) -> None:
        adapter = _ExecutionAdapter(
            [
                {
                    "symbol": "NVDA",
                    "qty": "1",
                    "side": "long",
                    "current_price": "100",
                },
                {
                    "symbol": "AMD",
                    "qty": "2",
                    "side": "long",
                    "current_price": "100",
                },
            ]
        )
        submitted_symbols: list[str] = []

        def submit(submission):
            submitted_symbols.append(submission.symbol)
            if submission.symbol == "NVDA":
                adapter.positions = [adapter.positions[1]]
                raise BrokerMutationSubmissionPreflightFailed(
                    "risk_reduction_preflight_failed:position_disappeared"
                )
            adapter.positions = []
            return {"id": "close-amd", "status": "accepted"}

        adapter.submit_risk_reducing_order = submit
        controller = self._controller(adapter)

        controller._flatten(
            reason="scheduled_closeout",
            now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
        )

        self.assertEqual(submitted_symbols, ["NVDA", "AMD"])
        self.assertFalse(controller.state.emergency_stop_active)
        self.assertIsNotNone(controller.state.capital_flat_confirmed_at)

    def test_closeout_fails_closed_when_order_cancellation_is_not_confirmed(
        self,
    ) -> None:
        adapter = _ExecutionAdapter([{"symbol": "NVDA", "qty": "1", "side": "long"}])
        adapter.list_orders = lambda status="all": [
            {"id": "still-open", "status": status}
        ]
        controller = self._controller(adapter)

        controller._flatten(
            reason="scheduled_closeout",
            now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
        )

        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn(
            "closeout_error:RuntimeError",
            controller.state.emergency_stop_reason,
        )
        self.assertEqual(adapter.submissions, [])

    def test_pair_fill_delta_must_remain_dollar_balanced(self) -> None:
        decisions = [
            StrategyDecision(
                strategy_id="pairs",
                symbol="NVDA",
                event_ts=datetime(2026, 7, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("100"),
            ),
            StrategyDecision(
                strategy_id="pairs",
                symbol="AMD",
                event_ts=datetime(2026, 7, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("100"),
            ),
        ]

        self.assertTrue(
            CapitalSafetyController.pair_delta_is_balanced(
                decisions,
                before={"NVDA": Decimal("0"), "AMD": Decimal("0")},
                after={"NVDA": Decimal("20000"), "AMD": Decimal("-19999")},
            )
        )
        self.assertFalse(
            CapitalSafetyController.pair_delta_is_balanced(
                decisions,
                before={"NVDA": Decimal("0"), "AMD": Decimal("0")},
                after={"NVDA": Decimal("20000"), "AMD": Decimal("0")},
            )
        )
        self.assertFalse(
            CapitalSafetyController.pair_delta_is_balanced(
                decisions,
                before={"NVDA": Decimal("0"), "AMD": Decimal("0")},
                after={"NVDA": Decimal("-20000"), "AMD": Decimal("19999")},
            )
        )
        self.assertFalse(
            CapitalSafetyController.pair_delta_is_balanced(
                decisions,
                before={"NVDA": Decimal("0"), "AMD": Decimal("0")},
                after={"NVDA": Decimal("0"), "AMD": Decimal("0")},
            )
        )
