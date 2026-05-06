from __future__ import annotations

from typing import Any, cast
from unittest import TestCase

from scripts.verify_alpaca_broker import (
    BrokerCredentials,
    PriceLookup,
    _load_reference_price,
    _proof_payload,
    _resolve_limit_price,
    _resolve_price_lookup,
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


class _PayloadClient:
    endpoint_class = "paper"


class TestVerifyAlpacaBroker(TestCase):
    def test_load_reference_price_uses_latest_alpaca_bar_close(self) -> None:
        lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"close": "123.45"}]})),
            "NVDA",
        )

        self.assertEqual(lookup.reference_price, 123.45)
        self.assertEqual(lookup.source, "alpaca_bars")
        self.assertIsNone(lookup.error)

    def test_load_reference_price_uses_c_field_when_close_missing(self) -> None:
        lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"c": "101.25"}]})),
            "NVDA",
        )

        self.assertEqual(lookup.reference_price, 101.25)
        self.assertEqual(lookup.source, "alpaca_bars")

    def test_load_reference_price_falls_back_on_empty_bars(self) -> None:
        lookup = _load_reference_price(cast(Any, _BarsClient({"NVDA": []})), "NVDA")

        self.assertEqual(lookup.reference_price, 1.0)
        self.assertEqual(lookup.source, "fallback_default")
        self.assertEqual(lookup.error, "bars_empty")

    def test_load_reference_price_falls_back_on_invalid_close(self) -> None:
        lookup = _load_reference_price(
            cast(Any, _BarsClient({"NVDA": [{"close": "not-a-price", "c": "-1"}]})),
            "NVDA",
        )

        self.assertEqual(lookup.reference_price, 1.0)
        self.assertEqual(lookup.source, "fallback_default")
        self.assertEqual(lookup.error, "valid_close_missing")

    def test_load_reference_price_falls_back_when_market_data_fails(self) -> None:
        lookup = _load_reference_price(cast(Any, _FailingBarsClient()), "NVDA")

        self.assertEqual(lookup.reference_price, 1.0)
        self.assertEqual(lookup.source, "fallback_default")
        self.assertIn("RuntimeError:market data unavailable", lookup.error or "")

    def test_resolve_price_lookup_prefers_explicit_limit_price(self) -> None:
        lookup = _resolve_price_lookup(
            cast(Any, _FailingBarsClient()),
            "NVDA",
            12.34,
        )

        self.assertEqual(lookup.reference_price, 12.34)
        self.assertEqual(lookup.source, "explicit_limit_price")
        self.assertIsNone(lookup.error)

    def test_resolve_price_lookup_loads_reference_price_without_explicit_price(
        self,
    ) -> None:
        lookup = _resolve_price_lookup(
            cast(Any, _BarsClient({"NVDA": [{"close": "123.45"}]})),
            "NVDA",
            None,
        )

        self.assertEqual(lookup.reference_price, 123.45)
        self.assertEqual(lookup.source, "alpaca_bars")

    def test_resolve_limit_price_applies_discount_to_reference_price(self) -> None:
        limit_price, lookup = _resolve_limit_price(
            cast(Any, _BarsClient({"NVDA": [{"close": "123.45"}]})),
            "NVDA",
            None,
            0.5,
        )

        self.assertEqual(limit_price, 61.73)
        self.assertEqual(lookup.reference_price, 123.45)
        self.assertEqual(lookup.source, "alpaca_bars")

    def test_proof_payload_includes_price_lookup_provenance(self) -> None:
        payload = _proof_payload(
            credentials=BrokerCredentials(
                label="TORGHUT_SIM",
                mode="paper",
                api_key="key",
                secret_key="secret",
                base_url="https://paper-api.alpaca.markets",
            ),
            client=cast(Any, _PayloadClient()),
            symbol="NVDA",
            qty=1,
            limit_price=1.0,
            lifecycle=[{"phase": "poll", "status": "canceled"}],
            account={"account_number": "acct-1", "status": "ACTIVE"},
            order_id="order-1",
            client_order_id="client-1",
            verdict="success",
            snapshot_id="snapshot-1",
            persisted_execution_id="execution-1",
            persist_db=True,
            price_lookup=PriceLookup(
                reference_price=1.0,
                source="fallback_default",
                error="bars_empty",
            ),
        )

        self.assertEqual(payload["reference_price"], 1.0)
        self.assertEqual(payload["price_source"], "fallback_default")
        self.assertEqual(payload["price_error"], "bars_empty")
        self.assertEqual(payload["final_status"], "canceled")
