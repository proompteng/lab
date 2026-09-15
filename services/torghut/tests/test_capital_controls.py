from __future__ import annotations

from datetime import datetime, time, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from app.config import settings
from app.trading.models import StrategyDecision
from app.trading.scheduler.capital_controls import (
    CapitalRiskSnapshot,
    CapitalSafetyController,
)


class _ExecutionAdapter:
    def __init__(self, positions: list[dict[str, str]]) -> None:
        self.positions = positions
        self.cancel_calls = 0
        self.cancel_purposes: list[str] = []
        self.close_calls: list[str] = []

    def cancel_all_orders(self, *, purpose="operator"):
        self.cancel_calls += 1
        self.cancel_purposes.append(purpose)
        return []

    def list_positions(self):
        return list(self.positions)

    def list_orders(self, status="all"):
        _ = status
        return []

    def close_all_positions(self, *, purpose="flatten"):
        self.close_calls.append(purpose)
        self.positions = []
        return [{"id": "close-1", "status": "accepted"}]


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
                "app.trading.scheduler.capital_controls.create_tigerbeetle_client",
                return_value=Mock(),
            ),
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
                "app.trading.scheduler.capital_controls.create_tigerbeetle_client",
                return_value=Mock(),
            ),
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

    def test_protocol_checks_reuse_one_client_until_controller_close(self) -> None:
        controller = self._controller()
        client = SimpleNamespace(nop=Mock(), close=Mock())
        now = datetime(2026, 7, 10, 15, 0, tzinfo=ZoneInfo("America/New_York"))

        with (
            patch.object(settings, "tigerbeetle_enabled", True),
            patch.object(settings, "tigerbeetle_required", True),
            patch.object(settings, "tigerbeetle_reconcile_required", False),
            patch(
                "app.trading.scheduler.capital_controls.create_tigerbeetle_client",
                return_value=client,
            ) as create_client,
        ):
            self.assertIsNone(
                controller._ledger_stop_reason(SimpleNamespace(), now=now)
            )
            controller._ledger_checked_at_monotonic = None
            self.assertIsNone(
                controller._ledger_stop_reason(SimpleNamespace(), now=now)
            )
            controller.close()
            controller.close()

        create_client.assert_called_once_with(settings)
        self.assertEqual(client.nop.call_count, 2)
        client.close.assert_called_once_with()

    def test_required_disabled_protocol_fails_closed_without_creating_client(
        self,
    ) -> None:
        controller = self._controller()
        now = datetime(2026, 7, 10, 15, 0, tzinfo=ZoneInfo("America/New_York"))

        with (
            patch.object(settings, "tigerbeetle_enabled", False),
            patch.object(settings, "tigerbeetle_required", True),
            patch.object(settings, "tigerbeetle_reconcile_required", False),
            patch(
                "app.trading.scheduler.capital_controls.create_tigerbeetle_client"
            ) as create_client,
        ):
            reason = controller._ledger_stop_reason(SimpleNamespace(), now=now)

        self.assertEqual(reason, "tigerbeetle_protocol_unavailable")
        create_client.assert_not_called()

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
                "app.trading.scheduler.capital_controls.create_tigerbeetle_client",
                return_value=Mock(),
            ),
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
                "app.trading.scheduler.capital_controls.create_tigerbeetle_client",
                return_value=Mock(),
            ),
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
        self.assertEqual(adapter.close_calls, [])

    def test_closeout_uses_broker_enforced_account_flatten_and_confirms_flat(
        self,
    ) -> None:
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
        self.assertEqual(adapter.cancel_purposes, ["closeout"])
        self.assertEqual(adapter.close_calls, ["closeout"])
        self.assertIsNotNone(controller.state.capital_flat_confirmed_at)

    def test_closeout_never_replays_an_unchanged_position_snapshot(self) -> None:
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

        def accepted_without_fill(*, purpose="flatten"):
            adapter.close_calls.append(purpose)
            return [{"id": "close-nvda", "status": "accepted"}]

        adapter.close_all_positions = accepted_without_fill
        controller = self._controller(adapter)

        with (
            patch.object(settings, "trading_closeout_max_attempts", 3),
            patch.object(settings, "trading_closeout_reprice_seconds", 0),
        ):
            controller._flatten(
                reason="scheduled_closeout",
                now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
            )

        self.assertEqual(adapter.close_calls, ["closeout"])
        self.assertEqual(adapter.cancel_calls, 2)
        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn("closeout_failed", controller.state.emergency_stop_reason)
        self.assertNotIn("closeout_error", controller.state.emergency_stop_reason)

    def test_closeout_reissues_only_after_monotonic_partial_fill(self) -> None:
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

        def partially_fill_then_flatten(*, purpose="flatten"):
            adapter.close_calls.append(purpose)
            if len(adapter.close_calls) == 1:
                adapter.positions = [
                    {
                        "symbol": "NVDA",
                        "qty": "5",
                        "side": "long",
                        "current_price": "100",
                    }
                ]
            else:
                adapter.positions = []
            return [
                {"id": f"close-nvda-{len(adapter.close_calls)}", "status": "accepted"}
            ]

        adapter.close_all_positions = partially_fill_then_flatten
        controller = self._controller(adapter)

        with (
            patch.object(settings, "trading_closeout_max_attempts", 3),
            patch.object(settings, "trading_closeout_reprice_seconds", 0),
        ):
            controller._flatten(
                reason="scheduled_closeout",
                now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
            )

        self.assertEqual(adapter.close_calls, ["closeout", "closeout"])
        self.assertEqual(adapter.cancel_calls, 2)
        self.assertFalse(controller.state.emergency_stop_active)
        self.assertIsNotNone(controller.state.capital_flat_confirmed_at)

    def test_closeout_never_reissues_after_a_position_side_flip(self) -> None:
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

        def fill_past_zero(*, purpose="flatten"):
            adapter.close_calls.append(purpose)
            adapter.positions = [
                {
                    "symbol": "NVDA",
                    "qty": "1",
                    "side": "short",
                    "current_price": "100",
                }
            ]
            return [{"id": "close-nvda", "status": "accepted"}]

        adapter.close_all_positions = fill_past_zero
        controller = self._controller(adapter)

        with (
            patch.object(settings, "trading_closeout_max_attempts", 3),
            patch.object(settings, "trading_closeout_reprice_seconds", 0),
        ):
            controller._flatten(
                reason="scheduled_closeout",
                now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
            )

        self.assertEqual(adapter.close_calls, ["closeout"])
        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn(
            "closeout_error:RuntimeError",
            controller.state.emergency_stop_reason,
        )

    def test_malformed_position_cannot_be_misreported_as_flat(self) -> None:
        adapter = _ExecutionAdapter(
            [{"symbol": "NVDA", "qty": "not-a-number", "side": "long"}]
        )
        controller = self._controller(adapter)

        controller._flatten(
            reason="scheduled_closeout",
            now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
        )

        self.assertIsNone(controller.state.capital_flat_confirmed_at)
        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn(
            "closeout_error:RuntimeError", controller.state.emergency_stop_reason
        )
        self.assertEqual(adapter.close_calls, [])

    def test_broker_outage_during_flatten_latches_unresolved_stop(self) -> None:
        adapter = _ExecutionAdapter([{"symbol": "AMD", "qty": "2", "side": "short"}])
        adapter.close_all_positions = lambda **_kwargs: (_ for _ in ()).throw(
            OSError("broker unavailable")
        )
        controller = self._controller(adapter)

        controller._flatten(
            reason="scheduled_closeout",
            now=datetime(2026, 7, 10, 19, 45, tzinfo=ZoneInfo("UTC")),
        )

        self.assertTrue(controller.state.emergency_stop_active)
        self.assertIn("closeout_error:OSError", controller.state.emergency_stop_reason)

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

        self.assertEqual(
            controller._positions(),
            [
                {
                    "symbol": "AMD",
                    "qty": "2",
                    "side": "short",
                    "current_price": "100",
                }
            ],
        )

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
        self.assertEqual(adapter.close_calls, [])

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
