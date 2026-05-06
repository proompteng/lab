from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from scripts.verify_alpaca_broker import (
    BrokerCredentials,
    PriceLookup,
    _load_reference_price,
    _proof_payload,
    _resolve_broker_credentials,
    _write_output,
    main,
)


class _BarsClient:
    def __init__(self, payload: dict[str, list[dict[str, Any]]]) -> None:
        self.payload = payload

    def get_bars(
        self,
        *,
        symbols: list[str],
        timeframe: str,
        lookback_bars: int,
    ) -> dict[str, list[dict[str, Any]]]:
        return self.payload


class _FailingBarsClient:
    def get_bars(
        self,
        *,
        symbols: list[str],
        timeframe: str,
        lookback_bars: int,
    ) -> dict[str, list[dict[str, Any]]]:
        raise RuntimeError("market data unavailable")


class _ProofClient:
    endpoint_class = "paper"


class _FakeFirewall:
    def __init__(self, client: object) -> None:
        self.client = client
        self.cancelled: list[str] = []
        self.readbacks = [
            {"id": "order-1", "status": "accepted"},
            {"id": "order-1", "status": "canceled"},
        ]

    def get_account(self) -> dict[str, str]:
        return {"status": "ACTIVE", "account_number": "PAPER123"}

    def get_asset(self, symbol: str) -> dict[str, object]:
        return {"symbol": symbol, "status": "active", "tradable": True}

    def submit_order(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float,
        extra_params: dict[str, str],
    ) -> dict[str, str]:
        _ = (symbol, side, qty, order_type, time_in_force, limit_price, extra_params)
        return {"id": "order-1", "status": "accepted"}

    def get_order(self, order_id: str) -> dict[str, str]:
        _ = order_id
        return self.readbacks.pop(0)

    def cancel_order(self, order_id: str) -> bool:
        self.cancelled.append(order_id)
        return True


class TestVerifyAlpacaBroker(TestCase):
    def test_load_reference_price_uses_latest_alpaca_bar_close(self) -> None:
        lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"close": "123.45"}]})),
            "NVDA",
        )

        self.assertEqual(lookup.reference_price, 123.45)
        self.assertEqual(lookup.source, "alpaca_bars")
        self.assertIsNone(lookup.error)

    def test_load_reference_price_falls_back_when_market_data_fails(self) -> None:
        lookup = _load_reference_price(cast(Any, _FailingBarsClient()), "NVDA")

        self.assertEqual(lookup.reference_price, 1.0)
        self.assertEqual(lookup.source, "fallback_default")
        self.assertIn("RuntimeError:market data unavailable", lookup.error or "")

    def test_load_reference_price_uses_c_alias_and_empty_fallbacks(self) -> None:
        alias_lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"close": None, "c": "7.5"}]})),
            "NVDA",
        )
        self.assertEqual(alias_lookup.reference_price, 7.5)
        self.assertEqual(alias_lookup.source, "alpaca_bars")

        empty_lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": []})), "NVDA"
        )
        self.assertEqual(empty_lookup.reference_price, 1.0)
        self.assertEqual(empty_lookup.error, "bars_empty")

        invalid_lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"close": "bad", "c": 0}]})),
            "NVDA",
        )
        self.assertEqual(invalid_lookup.reference_price, 1.0)
        self.assertEqual(invalid_lookup.error, "valid_close_missing")

    def test_resolve_broker_credentials_uses_paper_environment(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "APCA_PAPER_API_KEY_ID": "key",
                "APCA_PAPER_API_SECRET_KEY": "secret",
                "APCA_PAPER_API_BASE_URL": "https://paper.example",
            },
            clear=False,
        ):
            credentials = _resolve_broker_credentials("paper", "env-paper")

        self.assertEqual(credentials.label, "env-paper")
        self.assertEqual(credentials.mode, "paper")
        self.assertEqual(credentials.api_key, "key")
        self.assertEqual(credentials.secret_key, "secret")
        self.assertEqual(credentials.base_url, "https://paper.example")

    def test_write_output_and_proof_payload_include_price_provenance(self) -> None:
        payload = _proof_payload(
            credentials=BrokerCredentials(
                label="paper",
                mode="paper",
                api_key="key",
                secret_key="secret",
                base_url="https://paper.example",
            ),
            client=cast(Any, _ProofClient()),
            symbol="NVDA",
            qty=1,
            limit_price=10,
            lifecycle=[{"status": "canceled"}],
            account={"account_number": "PAPER123", "status": "ACTIVE"},
            order_id="order-1",
            client_order_id="client-1",
            verdict="success",
            snapshot_id=None,
            persisted_execution_id=None,
            persist_db=False,
            price_lookup=PriceLookup(
                reference_price=20,
                source="fallback_default",
                error="bars_empty",
            ),
        )

        self.assertEqual(payload["price_source"], "fallback_default")
        self.assertEqual(payload["price_error"], "bars_empty")
        self.assertEqual(payload["final_status"], "canceled")

        with TemporaryDirectory() as root:
            output = Path(root) / "proof" / "payload.json"
            _write_output(output, payload)
            written = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(written["client_order_id"], "client-1")

    def test_main_writes_successful_cancelled_order_proof(self) -> None:
        with TemporaryDirectory() as root:
            output = Path(root) / "broker-proof.json"
            with (
                patch.dict(
                    "os.environ",
                    {
                        "APCA_PAPER_API_KEY_ID": "key",
                        "APCA_PAPER_API_SECRET_KEY": "secret",
                    },
                    clear=False,
                ),
                patch(
                    "sys.argv",
                    [
                        "verify_alpaca_broker.py",
                        "--mode",
                        "paper",
                        "--account-label",
                        "env-paper",
                        "--symbol",
                        "NVDA",
                        "--qty",
                        "1",
                        "--limit-price",
                        "100",
                        "--poll-seconds",
                        "0.1",
                        "--max-wait-seconds",
                        "1",
                        "--output",
                        str(output),
                    ],
                ),
                patch(
                    "scripts.verify_alpaca_broker.TorghutAlpacaClient",
                    return_value=cast(Any, _ProofClient()),
                ),
                patch("scripts.verify_alpaca_broker.OrderFirewall", _FakeFirewall),
                patch("scripts.verify_alpaca_broker.time.time", return_value=42),
            ):
                main()

            payload = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(payload["symbol"], "NVDA")
        self.assertEqual(payload["limit_price"], 50.0)
        self.assertEqual(payload["price_source"], "explicit_limit_price")
        self.assertEqual(payload["final_status"], "canceled")
        self.assertEqual(payload["verdict"], "success")
