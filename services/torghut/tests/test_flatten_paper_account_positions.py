from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
from io import StringIO
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import patch

from scripts import flatten_paper_account_positions as flatten_script
from scripts.flatten_paper_account_positions import (
    flatten_paper_account_positions,
)


class FakeFlattenClient:
    def __init__(self, positions: list[dict[str, Any]] | None = None) -> None:
        self.positions = positions or []
        self.cancelled = False
        self.submitted: list[dict[str, Any]] = []

    def list_positions(self) -> list[dict[str, Any]]:
        return self.positions

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        self.cancelled = True
        return [{"id": "cancel-1", "status": "canceled"}]

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _ = limit_price, stop_price
        order = {
            "id": f"order-{len(self.submitted) + 1}",
            "symbol": symbol,
            "side": side,
            "qty": str(qty),
            "type": order_type,
            "time_in_force": time_in_force,
            "limit_price": limit_price,
            "extended_hours": (extra_params or {}).get("extended_hours"),
            "client_order_id": (extra_params or {}).get("client_order_id"),
        }
        self.submitted.append(order)
        return order


class RejectingFlattenClient(FakeFlattenClient):
    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _ = (
            symbol,
            side,
            qty,
            order_type,
            time_in_force,
            limit_price,
            stop_price,
            extra_params,
        )
        raise RuntimeError("simulated close rejection")


class SequencedFlattenClient(FakeFlattenClient):
    def __init__(self, position_snapshots: list[list[dict[str, Any]]]) -> None:
        super().__init__(position_snapshots[0] if position_snapshots else [])
        self.position_snapshots = list(position_snapshots)

    def list_positions(self) -> list[dict[str, Any]]:
        if len(self.position_snapshots) > 1:
            return self.position_snapshots.pop(0)
        return self.position_snapshots[0] if self.position_snapshots else []


class FakeSessionContext:
    def __enter__(self) -> object:
        return object()

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None


class TestFlattenPaperAccountPositions(TestCase):
    def test_dry_run_reports_close_orders_without_mutating(self) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "AMAT",
                    "qty": "0.8761",
                    "side": "long",
                    "market_value": "393.66",
                }
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=False,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            generated_at=datetime(2026, 5, 29, 19, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "dry_run")
        self.assertEqual(payload["position_count"], 1)
        self.assertEqual(payload["positions"][0]["close_side"], "sell")
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_apply_cancels_orders_and_submits_opposing_market_orders(self) -> None:
        client = FakeFlattenClient(
            [
                {"symbol": "AMAT", "qty": "0.8761", "side": "long"},
                {"symbol": "TSM", "qty": "0.3321", "side": "short"},
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            generated_at=datetime(2026, 5, 29, 19, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertTrue(client.cancelled)
        self.assertEqual(payload["cancelled_order_count"], 1)
        self.assertEqual(
            [
                (order["symbol"], order["side"], order["type"])
                for order in client.submitted
            ],
            [("AMAT", "sell", "market"), ("TSM", "buy", "market")],
        )
        self.assertEqual(payload["submitted_order_count"], 2)

    def test_extended_hours_limit_orders_use_guarded_reference_prices(self) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "AMAT",
                    "qty": "2",
                    "side": "long",
                    "current_price": "100",
                },
                {
                    "symbol": "TSM",
                    "qty": "3",
                    "side": "short",
                    "current_price": "50",
                },
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            extended_hours_limit=True,
            limit_away_bps=Decimal("200"),
            generated_at=datetime(2026, 5, 29, 13, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertTrue(payload["extended_hours_limit"])
        self.assertEqual(payload["limit_away_bps"], "200")
        self.assertEqual(payload["extended_hours_limit_missing_symbols"], [])
        self.assertEqual(
            [
                (
                    order["symbol"],
                    order["side"],
                    order["type"],
                    order["limit_price"],
                    order["extended_hours"],
                )
                for order in client.submitted
            ],
            [
                ("AMAT", "sell", "limit", 98.0, True),
                ("TSM", "buy", "limit", 51.0, True),
            ],
        )

    def test_extended_hours_limit_blocks_missing_reference_prices(self) -> None:
        client = FakeFlattenClient([{"symbol": "AMAT", "qty": "2", "side": "long"}])

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            extended_hours_limit=True,
            limit_away_bps=Decimal("200"),
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["extended_hours_limit_missing_symbols"], ["AMAT"])
        self.assertIn(
            "paper_account_flatten_extended_hours_limit_price_missing",
            payload["blockers"],
        )
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_extended_hours_limit_clamps_non_positive_sell_limit(self) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "PENNY",
                    "qty": "1",
                    "side": "long",
                    "current_price": "0.000001",
                }
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            extended_hours_limit=True,
            limit_away_bps=Decimal("20000"),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertEqual(client.submitted[0]["type"], "limit")
        self.assertEqual(client.submitted[0]["limit_price"], 0.0001)

    def test_wait_flat_marks_submitted_not_flat_when_positions_remain(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            wait_flat_seconds=0.01,
            poll_seconds=0.01,
        )

        self.assertEqual(payload["status"], "submitted_not_flat")
        self.assertEqual(payload["position_count"], 1)
        self.assertEqual(payload["final_position_count"], 1)

    def test_apply_reports_rejected_close_orders_as_stable_blocker(self) -> None:
        client = RejectingFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
        )

        self.assertEqual(payload["status"], "failed_close_orders")
        self.assertIn("paper_account_flatten_close_order_rejected", payload["blockers"])
        self.assertEqual(payload["rejected_close_order_count"], 1)
        self.assertEqual(
            payload["rejected_close_orders"][0]["reason"],
            "paper_account_flatten_close_order_rejected",
        )
        self.assertEqual(payload["submitted_order_count"], 0)
        self.assertTrue(client.cancelled)

    def test_wait_flat_marks_flattened_when_positions_clear(self) -> None:
        client = SequencedFlattenClient(
            [
                [
                    {
                        "symbol": "AMAT",
                        "qty": "2",
                        "side": "long",
                        "current_price": "100",
                    }
                ],
                [],
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            wait_flat_seconds=0.01,
            poll_seconds=0.01,
        )

        self.assertEqual(payload["status"], "flattened")
        self.assertEqual(payload["position_count"], 1)
        self.assertEqual(payload["final_position_count"], 0)

    def test_refuses_live_mode_or_wrong_account(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AAPL", "qty": "1", "side": "long", "market_value": "100"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="PA3SX7FYNUTF",
            expected_account_label="TORGHUT_SIM",
            trading_mode="live",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertIn("paper_account_flatten_requires_paper_mode", payload["blockers"])
        self.assertIn(
            "paper_account_flatten_account_label_mismatch", payload["blockers"]
        )
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_refuses_position_value_above_limit(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "100", "side": "long", "market_value": "3000"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertIn(
            "paper_account_flatten_gross_market_value_above_limit",
            payload["blockers"],
        )
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_default_guardrail_can_unwind_dirty_paper_proof_account_shape(
        self,
    ) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "AAPL",
                    "qty": "-81",
                    "side": "short",
                    "market_value": "25264.710000",
                },
                {
                    "symbol": "AMZN",
                    "qty": "184",
                    "side": "long",
                    "market_value": "49961.520000",
                },
                {
                    "symbol": "AMZN250530C00190000",
                    "qty": "1",
                    "side": "long",
                    "market_value": "42.00",
                },
                {
                    "symbol": "AMAT",
                    "qty": "0.8761",
                    "side": "long",
                    "market_value": "396.65",
                },
                {
                    "symbol": "INTC",
                    "qty": "0.0477",
                    "side": "long",
                    "market_value": "5.90",
                },
                {
                    "symbol": "MU",
                    "qty": "0.0757",
                    "side": "long",
                    "market_value": "72.44",
                },
                {
                    "symbol": "SPY",
                    "qty": "0.00266",
                    "side": "long",
                    "market_value": "2.01",
                },
                {
                    "symbol": "TSM",
                    "qty": "0.3321",
                    "side": "long",
                    "market_value": "141.80",
                },
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=flatten_script.DEFAULT_MAX_GROSS_MARKET_VALUE,
            max_position_count=25,
            generated_at=datetime(2026, 5, 29, 19, 50, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertEqual(payload["position_count"], 8)
        self.assertEqual(payload["max_gross_market_value"], "100000")
        self.assertTrue(client.cancelled)
        self.assertEqual(payload["submitted_order_count"], 8)
        self.assertEqual(client.submitted[0]["symbol"], "AAPL")
        self.assertEqual(client.submitted[0]["side"], "buy")

    def test_normalizes_dirty_positions_and_refuses_position_count_above_limit(
        self,
    ) -> None:
        client = FakeFlattenClient(
            [
                {"symbol": "", "qty": "10", "side": "long", "market_value": "10"},
                {"symbol": "ZERO", "qty": "0", "side": "long", "market_value": "0"},
                {"symbol": "mu", "qty": "-2", "current_price": "50"},
                {"symbol": "tsm", "qty": "3", "current_price": "100"},
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("1000"),
            max_position_count=1,
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["position_count"], 2)
        self.assertEqual(payload["gross_market_value"], "400")
        self.assertIn(
            "paper_account_flatten_position_count_above_limit",
            payload["blockers"],
        )
        self.assertEqual(
            [
                (position["symbol"], position["side"], position["close_side"])
                for position in payload["positions"]
            ],
            [("MU", "short", "buy"), ("TSM", "long", "sell")],
        )
        self.assertFalse(client.cancelled)

    def test_parse_args_accepts_explicit_guardrails(self) -> None:
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--paper-base-url",
            "https://paper-api.alpaca.markets",
            "--max-gross-market-value",
            "1234.56",
            "--max-position-count",
            "3",
            "--extended-hours-limit",
            "--limit-away-bps",
            "150",
            "--wait-flat-seconds",
            "45",
            "--poll-seconds",
            "3",
            "--persist-snapshot",
            "--apply",
            "--json",
        ]

        with patch.object(sys, "argv", argv):
            args = flatten_script._parse_args()

        self.assertEqual(args.account_label, "TORGHUT_SIM")
        self.assertEqual(args.expected_account_label, "TORGHUT_SIM")
        self.assertEqual(args.trading_mode, "paper")
        self.assertEqual(args.paper_base_url, "https://paper-api.alpaca.markets")
        self.assertEqual(args.max_gross_market_value, "1234.56")
        self.assertEqual(args.max_position_count, 3)
        self.assertTrue(args.extended_hours_limit)
        self.assertEqual(args.limit_away_bps, "150")
        self.assertEqual(args.wait_flat_seconds, 45)
        self.assertEqual(args.poll_seconds, 3)
        self.assertTrue(args.persist_snapshot)
        self.assertTrue(args.apply)
        self.assertTrue(args.json)

    def test_main_outputs_json_and_returns_clean_status(self) -> None:
        client = FakeFlattenClient()
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "clean")
        self.assertEqual(payload["position_count"], 0)

    def test_main_persists_snapshot_for_guarded_paper_account(self) -> None:
        client = FakeFlattenClient()
        snapshot = SimpleNamespace(
            id="snapshot-1",
            as_of=datetime(2026, 5, 31, 6, 35, tzinfo=timezone.utc),
        )
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "TORGHUT_SIM",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(
                flatten_script, "SessionLocal", return_value=FakeSessionContext()
            ),
            patch.object(
                flatten_script, "snapshot_account_and_positions", return_value=snapshot
            ) as snapshot_account,
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["position_snapshot_id"], "snapshot-1")
        self.assertEqual(
            payload["position_snapshot_as_of"],
            "2026-05-31T06:35:00+00:00",
        )
        snapshot_account.assert_called_once()

    def test_main_skips_snapshot_persistence_when_guard_fails(self) -> None:
        client = FakeFlattenClient()
        argv = [
            "flatten_paper_account_positions.py",
            "--account-label",
            "WRONG",
            "--expected-account-label",
            "TORGHUT_SIM",
            "--trading-mode",
            "paper",
            "--persist-snapshot",
            "--json",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            patch.object(flatten_script, "SessionLocal") as session_local,
            patch.object(
                flatten_script, "snapshot_account_and_positions"
            ) as snapshot_account,
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertEqual(
            payload["position_snapshot_skipped"],
            "paper_account_label_or_mode_guard_failed",
        )
        session_local.assert_not_called()
        snapshot_account.assert_not_called()

    def test_main_outputs_text_and_returns_blocked_status(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AAPL", "qty": "1", "side": "long", "market_value": "100"}]
        )
        argv = [
            "flatten_paper_account_positions.py",
            "--trading-mode",
            "live",
            "--max-position-count",
            "-1",
        ]

        with (
            patch.object(sys, "argv", argv),
            patch.object(flatten_script, "TorghutAlpacaClient", return_value=client),
            patch.object(
                flatten_script, "OrderFirewall", side_effect=lambda wrapped: wrapped
            ),
            redirect_stdout(StringIO()) as output,
        ):
            exit_code = flatten_script.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("status=blocked", output.getvalue())
        self.assertFalse(client.cancelled)
