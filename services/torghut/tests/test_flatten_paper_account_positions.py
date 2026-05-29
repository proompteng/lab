from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
from io import StringIO
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
            "client_order_id": (extra_params or {}).get("client_order_id"),
        }
        self.submitted.append(order)
        return order


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
