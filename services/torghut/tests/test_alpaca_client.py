from __future__ import annotations

import uuid
from typing import Any, cast
from unittest import TestCase
from unittest.mock import Mock, patch

from alpaca.common.exceptions import APIError
from alpaca.data.requests import StockBarsRequest
from alpaca.trading.requests import GetOrdersRequest
from requests import Response
from requests.exceptions import HTTPError

from app.alpaca_client import (
    AlpacaStrictOrderLookupMalformedError,
    OrderFirewallViolation,
    TorghutAlpacaClient,
)
from app.alpaca_client import OrderFirewallToken
from app.config import settings
from app.trading.firewall import OrderFirewall


class DummyModel:
    def __init__(self, **data: Any) -> None:
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        return self._data


class AttributeOnlyModel:
    def __init__(self) -> None:
        self.equity = "12000"
        self.cash = "3000"
        self._internal_cache = "hidden"


class DummyTradingClient:
    def __init__(self) -> None:
        self.cancelled: list[str] = []

    def get_account(self) -> DummyModel:
        return DummyModel(equity="10000", cash="5000", buying_power="20000")

    def get_all_positions(self) -> list[DummyModel]:
        return [DummyModel(symbol="AAPL", qty="1")]

    def get_asset(self, symbol_or_asset_id: str) -> DummyModel:
        return DummyModel(symbol=symbol_or_asset_id, tradable=True)

    def get_orders(self, filter: GetOrdersRequest | None = None) -> list[DummyModel]:
        return [DummyModel(id="order-1", symbol="AAPL", uuid_id=uuid.uuid4())]

    def get_order_by_id(self, order_id: str) -> DummyModel:
        return DummyModel(id=order_id, symbol="AAPL")

    def get_order_by_client_id(self, client_id: str) -> DummyModel | None:
        return DummyModel(id="order-xyz", client_order_id=client_id)

    def submit_order(self, order_data: Any) -> DummyModel:
        return DummyModel(
            id="order-123",
            symbol=order_data.symbol,
            side=str(order_data.side),
            qty=order_data.qty,
            type=str(order_data.type),
            time_in_force=str(order_data.time_in_force),
            status="accepted",
        )

    def cancel_order_by_id(self, order_id: str) -> None:
        self.cancelled.append(order_id)

    def cancel_orders(self) -> list[DummyModel]:
        return [DummyModel(id="order-1"), DummyModel(id="order-2")]


class DummyBarsResponse:
    def __init__(self, data: dict[str, list[DummyModel]]) -> None:
        self.data = data


class DummyDataClient:
    def __init__(self) -> None:
        self.requested: list[StockBarsRequest] = []

    def get_stock_bars(self, request_params: StockBarsRequest) -> DummyBarsResponse:
        self.requested.append(request_params)
        return DummyBarsResponse(
            data={"AAPL": [DummyModel(symbol="AAPL", open=1, close=2)]}
        )


class TestAlpacaClient(TestCase):
    def setUp(self) -> None:
        self.original_kill_switch = settings.trading_kill_switch_enabled
        settings.trading_kill_switch_enabled = False

    def tearDown(self) -> None:
        settings.trading_kill_switch_enabled = self.original_kill_switch

    def test_alpaca_client_basic_wrappers(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        account = client.get_account()
        self.assertEqual(account["equity"], "10000")

        positions = client.list_positions()
        self.assertEqual(positions[0]["symbol"], "AAPL")

        orders = client.list_open_orders()
        self.assertEqual(orders[0]["id"], "order-1")
        self.assertIsInstance(orders[0]["uuid_id"], str)

        all_orders = client.list_orders()
        self.assertEqual(all_orders[0]["symbol"], "AAPL")

        order = client.get_order("order-abc")
        self.assertEqual(order["id"], "order-abc")

        firewall = OrderFirewall(client)
        submitted = firewall.submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
        )
        self.assertEqual(submitted["status"], "accepted")

        bars = client.get_bars(symbols=["AAPL"], timeframe="1Min", lookback_bars=1)
        self.assertIn("AAPL", bars)
        self.assertEqual(len(bars["AAPL"]), 1)

        cancelled = firewall.cancel_all_orders()
        self.assertEqual(len(cancelled), 2)

    def test_order_extra_params_cannot_override_wrapper_owned_fields(self) -> None:
        trading_client = DummyTradingClient()
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=trading_client,
            data_client=DummyDataClient(),
        )
        firewall = OrderFirewall(client)

        with patch.object(
            trading_client,
            "submit_order",
            wraps=trading_client.submit_order,
        ) as submit_order:
            reserved_values: dict[str, object] = {
                "limit_price": "200",
                "notional": "100",
                "order_type": "limit",
                "qty": "100",
                "side": "sell",
                "stop_price": "90",
                "symbol": "MSFT",
                "time_in_force": "gtc",
                "type": "limit",
            }
            for reserved_key, reserved_value in reserved_values.items():
                with (
                    self.subTest(reserved_key=reserved_key),
                    self.assertRaisesRegex(
                        ValueError,
                        rf"alpaca_order_extra_params_reserved:{reserved_key}",
                    ),
                ):
                    firewall.submit_order(
                        symbol="AAPL",
                        side="buy",
                        qty=1,
                        order_type="market",
                        time_in_force="day",
                        extra_params={reserved_key: reserved_value},
                    )

            with self.assertRaisesRegex(
                ValueError,
                "alpaca_order_extra_params_reserved:side,symbol,time_in_force",
            ):
                OrderFirewall(client).submit_order(
                    symbol="AAPL",
                    side="buy",
                    qty=1,
                    order_type="market",
                    time_in_force="day",
                    extra_params={
                        "side": "sell",
                        "symbol": "MSFT",
                        "time_in_force": "gtc",
                    },
                )

            with self.assertRaisesRegex(
                ValueError,
                "alpaca_order_extra_params_unsupported:simulation_context",
            ):
                OrderFirewall(client).submit_order(
                    symbol="AAPL",
                    side="buy",
                    qty=1,
                    order_type="market",
                    time_in_force="day",
                    extra_params={"simulation_context": {"source": "simulation"}},
                )

            submit_order.assert_not_called()

    def test_order_extra_params_preserve_supported_sdk_fields(self) -> None:
        class RecordingTradingClient(DummyTradingClient):
            def __init__(self) -> None:
                super().__init__()
                self.submitted_order: Any | None = None

            def submit_order(self, order_data: Any) -> DummyModel:
                self.submitted_order = order_data
                return super().submit_order(order_data)

        trading_client = RecordingTradingClient()
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=trading_client,
            data_client=DummyDataClient(),
        )

        submitted = OrderFirewall(client).submit_order(
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="market",
            time_in_force="day",
            extra_params={
                "client_order_id": "client-123",
                "extended_hours": False,
            },
        )

        self.assertEqual(submitted["status"], "accepted")
        submitted_order = trading_client.submitted_order
        assert submitted_order is not None
        self.assertEqual(
            submitted_order.client_order_id,
            "client-123",
        )
        self.assertFalse(submitted_order.extended_hours)

    def test_attribute_only_model_payload_uses_public_vars(self) -> None:
        class AttributeOnlyTradingClient(DummyTradingClient):
            def get_account(self) -> AttributeOnlyModel:
                return AttributeOnlyModel()

        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=AttributeOnlyTradingClient(),
            data_client=DummyDataClient(),
        )

        self.assertEqual(
            client.get_account(),
            {
                "cash": "3000",
                "equity": "12000",
            },
        )

    def test_unsupported_model_payload_raises_type_error(self) -> None:
        class UnsupportedAccountTradingClient(DummyTradingClient):
            def get_account(self) -> object:
                return object()

        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=UnsupportedAccountTradingClient(),
            data_client=DummyDataClient(),
        )

        with self.assertRaisesRegex(TypeError, "Unsupported model type"):
            client.get_account()

    def test_get_order_by_client_order_id_uses_alpaca_client_id_lookup(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        order = client.get_order_by_client_order_id("client-123")
        assert order is not None
        self.assertEqual(order["id"], "order-xyz")
        self.assertEqual(order["client_order_id"], "client-123")

        strict_order = client.get_order_by_client_order_id_strict("client-123")
        assert strict_order is not None
        self.assertEqual(strict_order["id"], "order-xyz")
        self.assertEqual(strict_order["client_order_id"], "client-123")

    def test_strict_client_order_lookup_rejects_missing_or_malformed_payload(
        self,
    ) -> None:
        class MalformedLookupTradingClient(DummyTradingClient):
            def __init__(self, payload: object) -> None:
                super().__init__()
                self.payload = payload

            def get_order_by_client_id(self, client_id: str) -> Any:
                del client_id
                return self.payload

        for payload, expected_error in (
            (None, "missing_payload"),
            ({1: "not-a-string-key"}, "non_string_key"),
        ):
            with self.subTest(expected_error=expected_error):
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    trading_client=MalformedLookupTradingClient(payload),
                    data_client=DummyDataClient(),
                )

                with self.assertRaisesRegex(
                    AlpacaStrictOrderLookupMalformedError,
                    expected_error,
                ):
                    client.get_order_by_client_order_id_strict("client-123")

    def test_strict_client_order_lookup_requires_non_empty_client_id(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        for client_order_id in ("", "   "):
            with (
                self.subTest(client_order_id=repr(client_order_id)),
                self.assertRaisesRegex(ValueError, "client_order_id_required"),
            ):
                client.get_order_by_client_order_id_strict(client_order_id)

    def test_strict_client_order_lookup_uses_exact_endpoint_and_only_404_is_absent(
        self,
    ) -> None:
        for status_code in (401, 403, 404, 429, 500, 503):
            with self.subTest(status_code=status_code):
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    data_client=DummyDataClient(),
                )
                response = Mock(spec=Response)
                response.status_code = status_code
                response.text = (
                    f'{{"code": {status_code}, "message": "lookup failure"}}'
                )
                response.raise_for_status.side_effect = HTTPError(response=response)

                with (
                    patch(
                        "alpaca.common.rest.Session.request", return_value=response
                    ) as mock_request,
                    patch("alpaca.common.rest.time.sleep") as mock_sleep,
                ):
                    if status_code == 404:
                        self.assertIsNone(
                            client.get_order_by_client_order_id_strict("client-123")
                        )
                    else:
                        with self.assertRaises(APIError) as raised:
                            client.get_order_by_client_order_id_strict("client-123")
                        self.assertEqual(raised.exception.status_code, status_code)

                mock_request.assert_called_once()
                self.assertEqual(mock_request.call_args.args[0], "GET")
                self.assertTrue(
                    mock_request.call_args.args[1].endswith(
                        "/orders:by_client_order_id"
                    )
                )
                self.assertEqual(
                    mock_request.call_args.kwargs["params"],
                    {"client_order_id": "client-123"},
                )
                mock_sleep.assert_not_called()

    def test_404_classification_rejects_404_like_non_integer_statuses(self) -> None:
        class IntLike404(int):
            pass

        class FailingReadTradingClient(DummyTradingClient):
            def __init__(self, error: APIError) -> None:
                super().__init__()
                self.error = error

            def get_asset(self, symbol_or_asset_id: str) -> DummyModel:
                del symbol_or_asset_id
                raise self.error

            def get_order_by_client_id(self, client_id: str) -> DummyModel | None:
                del client_id
                raise self.error

        for status_code in (True, "404", 404.0, IntLike404(404), None):
            with self.subTest(status_code=repr(status_code)):
                response = Mock(spec=Response)
                response.status_code = status_code
                error = APIError(
                    '{"code": 404, "message": "lookup failure"}',
                    HTTPError(response=response),
                )
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    trading_client=FailingReadTradingClient(error),
                    data_client=DummyDataClient(),
                )

                for lookup in (
                    lambda: client.get_asset("AAPL"),
                    lambda: client.get_order_by_client_order_id("client-123"),
                    lambda: client.get_order_by_client_order_id_strict("client-123"),
                ):
                    with self.assertRaises(APIError) as raised:
                        lookup()
                    self.assertIs(raised.exception, error)

    def test_explicit_http_404_is_not_found_for_optional_reads(self) -> None:
        response = Mock(spec=Response)
        response.status_code = 404
        error = APIError(
            '{"code": 404, "message": "not found"}',
            HTTPError(response=response),
        )

        class NotFoundTradingClient(DummyTradingClient):
            def get_asset(self, symbol_or_asset_id: str) -> DummyModel:
                del symbol_or_asset_id
                raise error

            def get_order_by_client_id(self, client_id: str) -> DummyModel | None:
                del client_id
                raise error

        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=NotFoundTradingClient(),
            data_client=DummyDataClient(),
        )

        self.assertIsNone(client.get_asset("AAPL"))
        self.assertIsNone(client.get_order_by_client_order_id("client-123"))
        self.assertIsNone(client.get_order_by_client_order_id_strict("client-123"))

    def test_get_asset_returns_model_from_read_surface(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        asset = client.get_asset("AAPL")
        assert asset is not None
        self.assertEqual(asset["symbol"], "AAPL")
        self.assertTrue(asset["tradable"])

    def test_mutating_methods_require_firewall_boundary(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )
        with self.assertRaises(OrderFirewallViolation):
            client.submit_order(
                symbol="AAPL",
                side="buy",
                qty=1,
                order_type="market",
                time_in_force="day",
                firewall_token=cast(OrderFirewallToken, object()),
            )

    def test_read_only_trading_client_does_not_expose_mutations(self) -> None:
        client = TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=DummyTradingClient(),
            data_client=DummyDataClient(),
        )

        account = client.trading.get_account()
        self.assertEqual(account.model_dump()["equity"], "10000")

        self.assertFalse(hasattr(client.trading, "submit_order"))
        self.assertFalse(hasattr(client.trading, "cancel_order_by_id"))
        self.assertFalse(hasattr(client.trading, "cancel_orders"))

        with self.assertRaises(AttributeError):
            getattr(client.trading, "submit_order")

        with self.assertRaises(AttributeError):
            getattr(client.trading, "cancel_order_by_id")

        with self.assertRaises(AttributeError):
            getattr(client.trading, "cancel_orders")

    def test_service_created_trading_client_makes_one_broker_mutation_attempt(
        self,
    ) -> None:
        for status_code in (429, 504):
            with self.subTest(status_code=status_code):
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    data_client=DummyDataClient(),
                )
                response = Mock(spec=Response)
                response.status_code = status_code
                response.text = (
                    f'{{"code": {status_code}, "message": "retryable failure"}}'
                )
                response.raise_for_status.side_effect = HTTPError(response=response)

                with (
                    patch(
                        "alpaca.common.rest.Session.request", return_value=response
                    ) as mock_request,
                    patch("alpaca.common.rest.time.sleep") as mock_sleep,
                    self.assertRaises(APIError) as raised,
                ):
                    OrderFirewall(client).submit_order(
                        symbol="AAPL",
                        side="buy",
                        qty=1,
                        order_type="market",
                        time_in_force="day",
                    )

                self.assertEqual(raised.exception.status_code, status_code)
                mock_request.assert_called_once()
                self.assertEqual(mock_request.call_args.args[0], "POST")
                mock_sleep.assert_not_called()

    def test_service_created_read_client_keeps_sdk_retry_behavior(self) -> None:
        for status_code in (429, 504):
            with self.subTest(status_code=status_code):
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    data_client=DummyDataClient(),
                )
                response = Mock(spec=Response)
                response.status_code = status_code
                response.text = (
                    f'{{"code": {status_code}, "message": "retryable failure"}}'
                )
                response.raise_for_status.side_effect = HTTPError(response=response)

                with (
                    patch(
                        "alpaca.common.rest.Session.request", return_value=response
                    ) as mock_request,
                    patch("alpaca.common.rest.time.sleep") as mock_sleep,
                    self.assertRaises(APIError) as raised,
                ):
                    client.get_account()

                self.assertEqual(raised.exception.status_code, status_code)
                self.assertEqual(mock_request.call_count, 4)
                self.assertEqual(
                    [request.args[0] for request in mock_request.call_args_list],
                    ["GET"] * 4,
                )
                self.assertEqual(mock_sleep.call_count, 3)

    def test_service_created_trading_client_fails_closed_without_retry_control(
        self,
    ) -> None:
        with (
            patch("alpaca.trading.client.TradingClient.__init__", return_value=None),
            self.assertRaisesRegex(
                RuntimeError, "alpaca_sdk_retry_control_unavailable"
            ),
        ):
            TorghutAlpacaClient(
                api_key="k",
                secret_key="s",
                base_url="https://paper-api.alpaca.markets",
                data_client=DummyDataClient(),
            )

    def test_injected_trading_client_retry_configuration_is_untouched(self) -> None:
        class RetryConfiguredTradingClient(DummyTradingClient):
            def __init__(self) -> None:
                super().__init__()
                self._retry = 7

            @property
            def configured_retry_attempts(self) -> int:
                return self._retry

        trading_client = RetryConfiguredTradingClient()

        TorghutAlpacaClient(
            api_key="k",
            secret_key="s",
            base_url="https://paper-api.alpaca.markets",
            trading_client=trading_client,
            data_client=DummyDataClient(),
        )

        self.assertEqual(trading_client.configured_retry_attempts, 7)

    def test_market_data_uses_data_endpoint_by_default(self) -> None:
        with patch("app.alpaca_client.StockHistoricalDataClient") as mock_data_client:
            TorghutAlpacaClient(
                api_key="k",
                secret_key="s",
                base_url="https://paper-api.alpaca.markets",
                trading_client=DummyTradingClient(),
            )

            called_kwargs = mock_data_client.call_args.kwargs
            self.assertIsNone(called_kwargs.get("url_override"))
            self.assertTrue(called_kwargs.get("sandbox"))

    def test_live_mode_uses_live_endpoints(self) -> None:
        from app import config

        original = config.settings.trading_mode
        config.settings.trading_mode = "live"

        try:
            with (
                patch("app.alpaca_client.TradingClient") as mock_read_trading_client,
                patch(
                    "app.alpaca_client._SingleAttemptTradingClient"
                ) as mock_mutation_trading_client,
                patch(
                    "app.alpaca_client.StockHistoricalDataClient"
                ) as mock_data_client,
            ):
                TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://api.alpaca.markets",
                )

                read_trading_kwargs = mock_read_trading_client.call_args.kwargs
                mutation_trading_kwargs = mock_mutation_trading_client.call_args.kwargs
                data_kwargs = mock_data_client.call_args.kwargs

                self.assertFalse(read_trading_kwargs.get("paper"))
                self.assertFalse(mutation_trading_kwargs.get("paper"))
                self.assertFalse(data_kwargs.get("sandbox"))
        finally:
            config.settings.trading_mode = original

    def test_explicit_paper_override_beats_live_runtime_mode(self) -> None:
        from app import config

        original = config.settings.trading_mode
        config.settings.trading_mode = "live"

        try:
            with (
                patch("app.alpaca_client.TradingClient") as mock_read_trading_client,
                patch(
                    "app.alpaca_client._SingleAttemptTradingClient"
                ) as mock_mutation_trading_client,
                patch(
                    "app.alpaca_client.StockHistoricalDataClient"
                ) as mock_data_client,
            ):
                client = TorghutAlpacaClient(
                    api_key="k",
                    secret_key="s",
                    base_url="https://paper-api.alpaca.markets",
                    paper=True,
                )

                read_trading_kwargs = mock_read_trading_client.call_args.kwargs
                mutation_trading_kwargs = mock_mutation_trading_client.call_args.kwargs
                data_kwargs = mock_data_client.call_args.kwargs

                self.assertTrue(read_trading_kwargs.get("paper"))
                self.assertTrue(mutation_trading_kwargs.get("paper"))
                self.assertTrue(data_kwargs.get("sandbox"))
                self.assertEqual(client.endpoint_class, "paper")
        finally:
            config.settings.trading_mode = original

    def test_alpaca_base_url_strips_v2_suffix(self) -> None:
        with (
            patch("app.alpaca_client.TradingClient") as mock_read_trading_client,
            patch(
                "app.alpaca_client._SingleAttemptTradingClient"
            ) as mock_mutation_trading_client,
        ):
            TorghutAlpacaClient(
                api_key="k",
                secret_key="s",
                base_url="https://paper-api.alpaca.markets/v2",
            )

            read_trading_kwargs = mock_read_trading_client.call_args.kwargs
            mutation_trading_kwargs = mock_mutation_trading_client.call_args.kwargs
            self.assertEqual(
                read_trading_kwargs.get("url_override"),
                "https://paper-api.alpaca.markets",
            )
            self.assertEqual(
                mutation_trading_kwargs.get("url_override"),
                "https://paper-api.alpaca.markets",
            )
