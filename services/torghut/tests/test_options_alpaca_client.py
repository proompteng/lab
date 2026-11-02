from __future__ import annotations

from datetime import date
import json
from unittest import TestCase
from unittest.mock import patch

from app.options_lane.alpaca import AlpacaOptionsClient, OptionsContractsQuery


class _FakeResponse:
    def __init__(self, payload: object, *, status: int = 200) -> None:
        self.status = status
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False


class TestOptionsAlpacaClient(TestCase):
    def test_splits_contracts_and_market_data_hosts(self) -> None:
        requests: list[str] = []

        def fake_urlopen(request: object, timeout: int = 30) -> _FakeResponse:
            full_url = getattr(request, "full_url")
            requests.append(str(full_url))
            if "/v2/options/contracts" in str(full_url):
                return _FakeResponse(
                    {"option_contracts": [{"symbol": "AA260313C00030000"}]}
                )
            return _FakeResponse({"snapshots": {"AA260313C00030000": {}}})

        client = AlpacaOptionsClient(
            key_id="key-id",
            secret_key="secret-key",
            contracts_base_url="https://paper-api.alpaca.markets",
            data_base_url="https://data.alpaca.markets",
            feed="indicative",
        )

        with patch("app.options_lane.alpaca.urlopen", side_effect=fake_urlopen):
            contracts, _ = client.list_contracts(
                query=OptionsContractsQuery(
                    status="active",
                    limit=1,
                    expiration_date_gte=date(2026, 3, 8),
                    expiration_date_lte=date(2026, 3, 15),
                ),
                underlying_symbols=["AA"],
            )
            snapshots = client.get_snapshots(["AA260313C00030000"])

        self.assertEqual(contracts[0]["symbol"], "AA260313C00030000")
        self.assertIn(
            "https://paper-api.alpaca.markets/v2/options/contracts", requests[0]
        )
        self.assertIn(
            "https://data.alpaca.markets/v1beta1/options/snapshots", requests[1]
        )
        self.assertIn("feed=indicative", requests[1])
        self.assertIn("AA260313C00030000", snapshots)

    def test_normalizes_contracts_base_url_with_v2_suffix(self) -> None:
        requests: list[str] = []

        def fake_urlopen(request: object, timeout: int = 30) -> _FakeResponse:
            full_url = getattr(request, "full_url")
            requests.append(str(full_url))
            return _FakeResponse(
                {"option_contracts": [{"symbol": "AA260313C00030000"}]}
            )

        client = AlpacaOptionsClient(
            key_id="key-id",
            secret_key="secret-key",
            contracts_base_url="https://paper-api.alpaca.markets/v2",
            data_base_url="https://data.alpaca.markets",
            feed="indicative",
        )

        with patch("app.options_lane.alpaca.urlopen", side_effect=fake_urlopen):
            contracts, _ = client.list_contracts(
                query=OptionsContractsQuery(
                    status="active",
                    limit=1,
                    expiration_date_gte=date(2026, 3, 8),
                    expiration_date_lte=date(2026, 3, 15),
                ),
                underlying_symbols=["AA"],
            )

        self.assertEqual(contracts[0]["symbol"], "AA260313C00030000")
        self.assertEqual(
            requests[0],
            "https://paper-api.alpaca.markets/v2/options/contracts?status=active&limit=1&underlying_symbols=AA&expiration_date_gte=2026-03-08&expiration_date_lte=2026-03-15",
        )

    def test_rejects_unbounded_contract_request(self) -> None:
        client = AlpacaOptionsClient(
            key_id="key-id",
            secret_key="secret-key",
            contracts_base_url="https://paper-api.alpaca.markets",
            data_base_url="https://data.alpaca.markets",
            feed="indicative",
        )

        with self.assertRaisesRegex(ValueError, "requires underlying symbols"):
            client.list_contracts(
                query=OptionsContractsQuery(
                    status="active",
                    limit=100,
                    expiration_date_gte=date(2026, 3, 8),
                    expiration_date_lte=date(2026, 3, 15),
                ),
                underlying_symbols=[],
            )
