from __future__ import annotations

from unittest import TestCase
from unittest.mock import Mock

from alpaca.common.exceptions import APIError
from requests import Response
from requests.exceptions import HTTPError

from app.alpaca_client import (
    AlpacaStrictOrderLookupMalformedError,
    TorghutAlpacaClient,
)


class _StrictLookupTradingClient:
    def __init__(self, result: object) -> None:
        self.result = result

    def get_order_by_id(self, order_id: str) -> object:
        del order_id
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def _client(recovery_client: object | None = None) -> TorghutAlpacaClient:
    return TorghutAlpacaClient(
        api_key="k",
        secret_key="s",
        base_url="https://paper-api.alpaca.markets",
        trading_client=Mock(),
        recovery_trading_client=recovery_client,
        data_client=Mock(),
    )


class TestAlpacaStrictOrderLookup(TestCase):
    def test_rejects_missing_or_malformed_payload(self) -> None:
        for payload, expected_error in (
            (None, "missing_payload"),
            ({1: "not-a-string-key"}, "non_string_key"),
        ):
            with self.subTest(expected_error=expected_error):
                client = _client(_StrictLookupTradingClient(payload))

                with self.assertRaisesRegex(
                    AlpacaStrictOrderLookupMalformedError,
                    expected_error,
                ):
                    client.get_order_by_id_strict("order-123")

    def test_only_explicit_404_is_absence(self) -> None:
        for status_code in (404, 500):
            with self.subTest(status_code=status_code):
                response = Mock(spec=Response)
                response.status_code = status_code
                error = APIError(
                    f'{{"code": {status_code}, "message": "lookup failure"}}',
                    HTTPError(response=response),
                )
                client = _client(_StrictLookupTradingClient(error))

                if status_code == 404:
                    self.assertIsNone(client.get_order_by_id_strict("order-123"))
                else:
                    with self.assertRaises(APIError) as raised:
                        client.get_order_by_id_strict("order-123")
                    self.assertIs(raised.exception, error)

    def test_requires_non_empty_id(self) -> None:
        client = _client()

        for order_id in ("", "   "):
            with (
                self.subTest(order_id=repr(order_id)),
                self.assertRaisesRegex(ValueError, "order_id_required"),
            ):
                client.get_order_by_id_strict(order_id)
