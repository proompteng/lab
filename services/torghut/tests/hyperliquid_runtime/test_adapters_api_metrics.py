from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import Response

from app.hyperliquid_runtime import api as runtime_api
from app.hyperliquid_runtime import clickhouse as clickhouse_module
from app.hyperliquid_runtime import exchange as exchange_module
from app.hyperliquid_runtime.clickhouse import ClickHouseRuntimeReader
from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.exchange import (
    HyperliquidSdkExchange,
    ShadowHyperliquidExchange,
    UnavailableHyperliquidExchange,
    exchange_from_config,
)
from app.hyperliquid_runtime.metrics import HyperliquidRuntimeMetrics
from app.hyperliquid_runtime.models import (
    CycleResult,
    HyperliquidMarket,
    OrderIntent,
    RuntimeDependencyStatus,
)
from app.hyperliquid_runtime.optimizer import OptimizerGateResult


def _config(**overrides: str) -> HyperliquidRuntimeConfig:
    env = {
        "HYPERLIQUID_RUNTIME_EXECUTION_NETWORK": "testnet",
        "HYPERLIQUID_RUNTIME_EXCHANGE_API_URL": "https://api.hyperliquid-testnet.xyz",
        "HYPERLIQUID_RUNTIME_CLICKHOUSE_DATABASE": "torghut",
        "HYPERLIQUID_RUNTIME_MARKET_DATA_NETWORK": "mainnet",
        "TORGHUT_TIGERBEETLE_ENABLED": "true",
        "TORGHUT_TIGERBEETLE_REQUIRED": "true",
        "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED": "true",
    }
    env.update(overrides)
    return HyperliquidRuntimeConfig.from_env(env)


def _intent(
    *,
    coin: str = "SPX",
    dex: str = "default",
    market_id: str = "hl:perp:default:SPX",
    limit_price: Decimal = Decimal("5000"),
) -> OrderIntent:
    return OrderIntent(
        market_id=market_id,
        coin=coin,
        dex=dex,
        side="buy",
        size=Decimal("0.1"),
        limit_price=limit_price,
        notional_usd=Decimal("20"),
        cloid="0x1234567890abcdef1234567890abcdef",
        reduce_only=False,
        decision_id="decision",
    )


def _market(
    *,
    coin: str = "cash:AAPL",
    dex: str = "cash",
    market_id: str = "hl:perp:cash:cash:AAPL",
) -> HyperliquidMarket:
    return HyperliquidMarket(
        market_id=market_id,
        coin=coin,
        dex=dex,
        asset_class="stocks",
        network="mainnet",
        day_notional_volume_usd=Decimal("500000"),
        mark_price=Decimal("200"),
        mid_price=None,
        open_interest_usd=Decimal("1000000"),
        max_leverage=3,
        payload={},
    )


def _cycle() -> CycleResult:
    return CycleResult(
        observed_at=datetime.now(timezone.utc),
        markets_seen=2,
        signals_written=3,
        decisions_written=3,
        orders_submitted=1,
        blocked_decisions=2,
        dependency_statuses=(
            RuntimeDependencyStatus("clickhouse", True, lag_seconds=1),
        ),
    )


def test_execution_metadata_dexes_keeps_all_dexes() -> None:
    markets = (
        _market(coin="SPX", dex="default", market_id="hl:perp:default:SPX"),
        _market(),
        _market(coin="xyz:NVDA", dex="xyz", market_id="hl:perp:xyz:xyz:NVDA"),
    )

    assert exchange_module._execution_metadata_dexes(
        markets, execution_network="mainnet"
    ) == (
        "",
        "cash",
        "xyz",
    )
    assert exchange_module._execution_metadata_dexes(
        markets, execution_network="testnet"
    ) == (
        "",
        "cash",
        "xyz",
    )


def test_clickhouse_reader_parses_queries_status_and_features(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queries: list[str] = []

    def fake_request(**kwargs: object) -> str:
        query = str(kwargs["query"])
        queries.append(query)
        if "UNION ALL" in query:
            return (
                '{"name":"hyperliquid_candles","observed_at":"2026-06-18T00:00:00Z","lag_seconds":7}\n'
                '{"name":"hyperliquid_ta_features","observed_at":"2026-06-18T00:00:00","lag_seconds":8}\n'
            )
        if "feature_rows" in query and "hyperliquid_ta_features" in query:
            return (
                '{"feature_rows":"1000","market_count":"44","stale_feature_rows":"0",'
                '"avg_momentum_5m_bps":"1.5","avg_spread_bps":"4.0"}\n'
            )
        if "runtime_latest_features" in query and "SELECT" in query:
            return (
                '{"market_id":"hl:perp:cash:cash:AAPL","coin":"cash:AAPL","dex":"cash",'
                '"event_ts":"2026-06-18T00:00:00Z","price":"200",'
                '"momentum_1m_bps":"1","momentum_3m_bps":"3","momentum_5m_bps":"12",'
                '"momentum_15m_bps":"15","momentum_1h_bps":"30","volatility_bps":"40",'
                '"vwap_distance_bps":"2","spread_bps":"3","book_imbalance":"0.2",'
                '"liquidity_usd":"500000","funding_rate":"0.0001",'
                '"open_interest_usd":"1000000","regime":"trend","source_lag_seconds":"7"}\n'
            )
        return (
            '{"market_id":"hl:perp:cash:cash:AAPL","coin":"cash:AAPL",'
            '"payload":"{}","dayNtlVlm":"500000","markPx":"200"}\n\n'
        )

    monkeypatch.setattr(clickhouse_module, "_request_clickhouse", fake_request)
    reader = ClickHouseRuntimeReader(_config())

    catalog = reader.load_catalog_rows()
    assert catalog[0]["coin"] == "cash:AAPL"
    assert catalog[0]["dayNtlVlm"] == "500000"
    assert reader.load_feature_rows([]) == []
    features = reader.load_feature_rows(["hl:perp:cash:cash:AAPL"])
    optimizer_history = reader.load_optimizer_history_summary()
    status = reader.status()

    assert features[0].price == Decimal("200")
    assert features[0].event_ts.tzinfo is not None
    assert optimizer_history["feature_rows"] == "1000"
    assert status.ready
    assert {dependency.name for dependency in status.statuses} == {
        "hyperliquid_candles",
        "hyperliquid_ta_features",
    }
    assert any("hyperliquid_asset_contexts" in query for query in queries)
    assert any("JSONExtractRaw(a.payload, 'ctx')" in query for query in queries)
    assert any("max(parseDateTimeBestEffort(ingest_ts))" in query for query in queries)
    assert any("FROM torghut.hyperliquid_ta_features" in query for query in queries)
    assert any("INTERVAL 24 HOUR" in query for query in queries)
    assert any("FORMAT JSONEachRow" in query for query in queries)


def test_clickhouse_status_rejects_future_event_lag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_request(**_kwargs: object) -> str:
        return (
            '{"name":"hyperliquid_candles","observed_at":"2026-06-18T00:00:00Z","lag_seconds":-120}\n'
            '{"name":"hyperliquid_ta_features","observed_at":"2026-06-18T00:00:00Z","lag_seconds":2}\n'
        )

    monkeypatch.setattr(clickhouse_module, "_request_clickhouse", fake_request)

    status = ClickHouseRuntimeReader(_config()).status()

    assert not status.ready
    assert status.statuses[0].reason == "stale_or_missing"


def test_clickhouse_status_reports_query_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_request(**_kwargs: object) -> str:
        raise RuntimeError("boom")

    monkeypatch.setattr(clickhouse_module, "_request_clickhouse", fail_request)

    status = ClickHouseRuntimeReader(_config()).status()

    assert not status.ready
    assert status.statuses[0].reason == "clickhouse_query_failed:RuntimeError"


def test_clickhouse_optional_parsers_return_none_for_bad_values() -> None:
    assert clickhouse_module._optional_decimal("12.5") == Decimal("12.5")
    assert clickhouse_module._optional_decimal("bad") is None
    assert clickhouse_module._optional_int("7") == 7
    assert clickhouse_module._optional_int("bad") is None


def test_clickhouse_http_request_auth_success_and_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        status = 200

        def read(self) -> bytes:
            return b'{"ok":true}\n'

    class FakeConnection:
        def __init__(
            self, host: str, port: int | None = None, timeout: int = 0
        ) -> None:
            self.host = host
            self.port = port
            self.timeout = timeout
            self.request_args: tuple[object, ...] | None = None

        def request(self, *args: object, **kwargs: object) -> None:
            self.request_args = args + (kwargs,)

        def getresponse(self) -> FakeResponse:
            return FakeResponse()

        def close(self) -> None:
            self.closed = True

    monkeypatch.setattr(clickhouse_module.http.client, "HTTPConnection", FakeConnection)
    payload = clickhouse_module._request_clickhouse(
        url="http://clickhouse.local:8123",
        username="torghut",
        password="secret",
        timeout_seconds=3,
        query="SELECT 1",
    )

    assert payload == '{"ok":true}\n'
    with pytest.raises(RuntimeError, match="unsupported_clickhouse_url_scheme"):
        clickhouse_module._request_clickhouse(
            url="ftp://clickhouse.local",
            username="torghut",
            password=None,
            timeout_seconds=3,
            query="SELECT 1",
        )
    with pytest.raises(RuntimeError, match="invalid_clickhouse_url_host"):
        clickhouse_module._request_clickhouse(
            url="http:///bad",
            username="torghut",
            password=None,
            timeout_seconds=3,
            query="SELECT 1",
        )


def test_exchange_shadow_unavailable_and_sdk_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shadow = ShadowHyperliquidExchange()
    assert shadow.reconcile_fills({"cash:AAPL": "hl:perp:cash:cash:AAPL"}) == []
    assert (
        shadow.reconcile_open_order_market_ids({"cash:AAPL": "hl:perp:cash:cash:AAPL"})
        == frozenset()
    )
    shadow_markets, shadow_status = shadow.filter_supported_markets((_market(),))
    assert shadow_markets == (_market(),)
    assert shadow_status.ready
    shadow.schedule_dead_man_cancel(seconds_from_now=30)
    assert shadow.dependency_status().ready

    unavailable = UnavailableHyperliquidExchange(["missing_secret"])
    assert not unavailable.dependency_status().ready
    unavailable_setup = unavailable.prepare_order_market(_intent())
    assert unavailable_setup is not None
    assert unavailable_setup.status == "rejected"
    assert unavailable_setup.rejection_reason == "missing_secret"
    unavailable_markets, unavailable_status = unavailable.filter_supported_markets(
        (_market(),)
    )
    assert unavailable_markets == ()
    assert not unavailable_status.ready
    with pytest.raises(RuntimeError, match="hyperliquid_exchange_unavailable"):
        unavailable.submit_ioc_limit(_intent())
    with pytest.raises(RuntimeError, match="hyperliquid_exchange_unavailable"):
        unavailable.reconcile_open_order_market_ids(
            {"cash:AAPL": "hl:perp:cash:cash:AAPL"}
        )
    unavailable.schedule_dead_man_cancel(seconds_from_now=30)

    sdk_calls: dict[str, object] = {}

    class FakeAccount:
        @staticmethod
        def from_key(key: str) -> str:
            return f"wallet:{key}"

    class FakeSdkExchange:
        def __init__(self, wallet: str, **kwargs: object) -> None:
            sdk_calls["exchange_init"] = (wallet, kwargs)

        def order(self, **kwargs: object) -> dict[str, object]:
            orders = sdk_calls.setdefault("orders", [])
            assert isinstance(orders, list)
            orders.append(kwargs)
            return {"response": {"data": {"statuses": [{"resting": {"oid": 42}}]}}}

        def schedule_cancel(self, cancel_at_ms: int) -> None:
            sdk_calls["cancel_at_ms"] = cancel_at_ms

    class FakeInfo:
        def __init__(self, url: str, *, skip_ws: bool) -> None:
            sdk_calls["info_init"] = (url, skip_ws)

        def user_fills(self, account: str) -> list[dict[str, object]]:
            sdk_calls["fills_account"] = account
            return [
                {
                    "coin": "cash:AAPL",
                    "side": "B",
                    "px": "200",
                    "sz": "0.1",
                    "fee": "-0.02",
                    "closedPnl": "0.50",
                    "oid": 42,
                    "hash": "fill-hash",
                    "time": 1781740800000,
                },
                {"coin": "BTC", "side": "A", "px": "1", "sz": "1", "time": 0},
            ]

        def open_orders(self, account: str, dex: str = "") -> list[dict[str, object]]:
            sdk_calls["open_orders_account"] = account
            open_order_dexes = sdk_calls.setdefault("open_order_dexes", [])
            assert isinstance(open_order_dexes, list)
            open_order_dexes.append(dex)
            if dex == "":
                return [{"coin": "SPX"}, {"coin": "BTC"}]
            return [{"coin": "cash:AAPL"}]

        def meta(self, dex: str = "") -> dict[str, object]:
            meta_dexes = sdk_calls.setdefault("meta_dexes", [])
            assert isinstance(meta_dexes, list)
            meta_dexes.append(dex)
            if dex == "":
                return {
                    "universe": [
                        "malformed-asset",
                        {"name": "SPX"},
                    ]
                }
            return {
                "universe": [
                    "malformed-asset",
                    {"name": "cash:AAPL"},
                    {"name": "cash:TSLA"},
                ]
            }

    class FakeCloid:
        @staticmethod
        def from_str(raw: str) -> str:
            return f"cloid:{raw}"

    def fake_import(name: str) -> object:
        modules = {
            "eth_account": SimpleNamespace(Account=FakeAccount),
            "hyperliquid.exchange": SimpleNamespace(Exchange=FakeSdkExchange),
            "hyperliquid.info": SimpleNamespace(Info=FakeInfo),
            "hyperliquid.utils.types": SimpleNamespace(Cloid=FakeCloid),
        }
        return modules[name]

    monkeypatch.setattr(exchange_module.importlib, "import_module", fake_import)
    config = _config(
        HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
        HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0xabc",
        HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY="0xdef",
    )
    sdk_exchange = HyperliquidSdkExchange(config)

    supported_markets, universe_status = sdk_exchange.filter_supported_markets(
        (
            _market(),
            _market(
                coin="SPX",
                dex="default",
                market_id="hl:perp:default:SPX",
            ),
            _market(
                coin="cash:UNSUPPORTED",
                market_id="hl:perp:cash:cash:UNSUPPORTED",
            ),
        )
    )
    default_market = _market(
        coin="SPX",
        dex="default",
        market_id="hl:perp:default:SPX",
    )
    cached_markets, cached_status = sdk_exchange.filter_supported_markets(
        (default_market,)
    )
    empty_markets, empty_status = sdk_exchange.filter_supported_markets(())
    result = sdk_exchange.submit_ioc_limit(_intent())
    non_default_result = sdk_exchange.submit_ioc_limit(
        _intent(
            coin="cash:AAPL",
            dex="cash",
            market_id="hl:perp:cash:cash:AAPL",
            limit_price=Decimal("200"),
        )
    )
    fills = sdk_exchange.reconcile_fills({"cash:AAPL": "hl:perp:cash:cash:AAPL"})
    open_market_ids = sdk_exchange.reconcile_open_order_market_ids(
        {
            "SPX": "hl:perp:default:SPX",
            "cash:AAPL": "hl:perp:cash:cash:AAPL",
        }
    )
    sdk_exchange.schedule_dead_man_cancel(seconds_from_now=30)

    assert supported_markets == (
        _market(),
        _market(coin="SPX", dex="default", market_id="hl:perp:default:SPX"),
    )
    assert universe_status.ready
    assert cached_markets == (default_market,)
    assert cached_status.ready
    assert empty_markets == ()
    assert empty_status.ready
    assert sdk_calls["meta_dexes"] == ["", "cash"]
    assert sdk_calls["exchange_init"][1]["perp_dexs"] == ["", "cash"]
    assert sdk_calls["open_order_dexes"] == ["", "cash"]
    assert sdk_calls["open_orders_account"] == "0xabc"
    assert result.status == "accepted"
    assert result.exchange_order_id == "42"
    assert non_default_result.status == "accepted"
    assert non_default_result.exchange_order_id == "42"
    assert len(sdk_calls["orders"]) == 2
    assert sdk_calls["orders"][1]["name"] == "cash:AAPL"
    assert fills[0].notional_usd == Decimal("20.0")
    assert fills[0].fee_usd == Decimal("0.02")
    assert open_market_ids == frozenset(
        {"hl:perp:default:SPX", "hl:perp:cash:cash:AAPL"}
    )
    assert sdk_exchange.dependency_status().ready
    assert isinstance(exchange_from_config(config), HyperliquidSdkExchange)


def test_sdk_execution_universe_reports_metadata_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeInfo:
        def __init__(self, _url: str, *, skip_ws: bool) -> None:
            assert skip_ws

        def meta(self, dex: str = "") -> dict[str, object]:
            _ = dex
            raise TimeoutError("metadata unavailable")

    def fake_import(name: str) -> object:
        if name == "hyperliquid.info":
            return SimpleNamespace(Info=FakeInfo)
        raise AssertionError(f"unexpected import {name}")

    monkeypatch.setattr(exchange_module.importlib, "import_module", fake_import)
    sdk_exchange = HyperliquidSdkExchange(
        _config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0xabc",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY="0xdef",
        )
    )

    supported_markets, status = sdk_exchange.filter_supported_markets(
        (
            _market(
                coin="SPX",
                dex="default",
                market_id="hl:perp:default:SPX",
            ),
        )
    )

    assert supported_markets == ()
    assert not status.ready
    assert status.reason == "execution_market_metadata_unavailable:TimeoutError"


def test_sdk_execution_universe_loads_supported_non_default_testnet_dexes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sdk_calls: dict[str, object] = {}

    class FakeInfo:
        def __init__(self, _url: str, *, skip_ws: bool) -> None:
            assert skip_ws

        def meta(self, dex: str = "") -> dict[str, object]:
            meta_dexes = sdk_calls.setdefault("meta_dexes", [])
            assert isinstance(meta_dexes, list)
            meta_dexes.append(dex)
            if dex == "xyz":
                return {"universe": [{"name": "xyz:NVDA"}]}
            return {"universe": [{"name": "SPX"}]}

    def fake_import(name: str) -> object:
        if name == "hyperliquid.info":
            return SimpleNamespace(Info=FakeInfo)
        raise AssertionError(f"unexpected import {name}")

    monkeypatch.setattr(exchange_module.importlib, "import_module", fake_import)
    sdk_exchange = HyperliquidSdkExchange(
        _config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0xabc",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY="0xdef",
        )
    )

    supported_markets, status = sdk_exchange.filter_supported_markets(
        (
            _market(coin="xyz:NVDA", dex="xyz", market_id="hl:perp:xyz:xyz:NVDA"),
            _market(coin="SPX", dex="default", market_id="hl:perp:default:SPX"),
        )
    )

    assert supported_markets == (
        _market(coin="xyz:NVDA", dex="xyz", market_id="hl:perp:xyz:xyz:NVDA"),
        _market(coin="SPX", dex="default", market_id="hl:perp:default:SPX"),
    )
    assert status.ready
    assert sdk_calls["meta_dexes"] == ["", "xyz"]
    assert sdk_exchange.dependency_status().ready


def test_sdk_execution_universe_reports_no_markets_when_only_non_default_dexes_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sdk_calls: dict[str, object] = {}

    class FakeInfo:
        def __init__(self, _url: str, *, skip_ws: bool) -> None:
            assert skip_ws

        def meta(self, dex: str = "") -> dict[str, object]:
            meta_dexes = sdk_calls.setdefault("meta_dexes", [])
            assert isinstance(meta_dexes, list)
            meta_dexes.append(dex)
            raise RuntimeError(f"unsupported dex {dex}")

    def fake_import(name: str) -> object:
        if name == "hyperliquid.info":
            return SimpleNamespace(Info=FakeInfo)
        raise AssertionError(f"unexpected import {name}")

    monkeypatch.setattr(exchange_module.importlib, "import_module", fake_import)
    sdk_exchange = HyperliquidSdkExchange(
        _config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0xabc",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY="0xdef",
        )
    )

    supported_markets, status = sdk_exchange.filter_supported_markets(
        (
            _market(),
            _market(coin="xyz:NVDA", dex="xyz", market_id="hl:perp:xyz:xyz:NVDA"),
        )
    )

    assert supported_markets == ()
    assert not status.ready
    assert status.reason == "no_execution_supported_markets"
    assert sdk_calls.get("meta_dexes", []) == ["cash", "xyz"]
    assert not sdk_exchange.dependency_status().ready
    assert sdk_exchange.dependency_status().reason == "exchange_not_read"


def test_order_result_status_variants() -> None:
    assert (
        exchange_module._order_result({"response": {"data": {"statuses": []}}}).status
        == "submitted"
    )
    assert (
        exchange_module._order_result(
            {"response": {"data": {"statuses": [{"filled": {"oid": 7}}]}}}
        ).status
        == "filled"
    )
    rejected = exchange_module._order_result(
        {"response": {"data": {"statuses": [{"error": "bad_size"}]}}}
    )
    assert rejected.status == "rejected"
    assert rejected.rejection_reason == "bad_size"
    assert (
        exchange_module._order_result(
            {"response": {"data": {"statuses": [{"resting": {}}]}}}
        ).exchange_order_id
        is None
    )


def test_metrics_and_api_readiness_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    metrics = HyperliquidRuntimeMetrics()
    cycle = _cycle()
    metrics.record_cycle(cycle)
    metrics.record_error(ValueError("bad"))
    rendered = metrics.render("torghut_hl")

    assert "torghut_hl_cycles_total 1" in rendered
    assert "torghut_hl_cycle_errors_total 1" in rendered
    assert "torghut_hl_optimizer_runs_total 0" in rendered
    assert runtime_api.healthz() == {"status": "ok"}

    fake_state = SimpleNamespace(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="false",
            HYPERLIQUID_RUNTIME_METRICS_NAMESPACE="torghut_hl",
        ),
        latest_cycle=None,
        latest_error=None,
        metrics=metrics,
    )
    monkeypatch.setattr(runtime_api, "runtime_state", fake_state)
    response = Response()
    not_ready = runtime_api.readyz(response)
    assert response.status_code == 503
    assert "cycle_not_completed" in not_ready["reasons"]

    fake_state.latest_cycle = cycle
    response = Response()
    ready = runtime_api.readyz(response)
    assert response.status_code == 200
    assert ready["ready"] is True
    assert "torghut_hl_last_cycle_ts_seconds" in runtime_api.metrics().body.decode()


def test_api_report_returns_configured_runtime_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    class FakeRepository:
        def __init__(self, session: FakeSession) -> None:
            self.session = session

        def operational_report(
            self, *, config_payload: dict[str, object]
        ) -> dict[str, object]:
            return {
                "schema_version": "torghut.hyperliquid-runtime-report.v1",
                "config": config_payload,
                "positions": [],
                "fills_by_coin": [],
                "rejects_by_coin_reason": [],
                "cooldowns": {},
            }

    session = FakeSession()
    monkeypatch.setattr(runtime_api, "SessionLocal", lambda: session)
    monkeypatch.setattr(runtime_api, "HyperliquidRuntimeRepository", FakeRepository)
    monkeypatch.setattr(
        runtime_api,
        "runtime_state",
        SimpleNamespace(
            config=_config(
                HYPERLIQUID_RUNTIME_TRADE_COINS="xyz:NVDA,xyz:AMD",
                HYPERLIQUID_RUNTIME_EXCLUDED_COINS="SPX",
                HYPERLIQUID_RUNTIME_MAX_ORDER_NOTIONAL_USD="10",
                HYPERLIQUID_RUNTIME_MIN_ORDER_NOTIONAL_USD="10",
                HYPERLIQUID_RUNTIME_MAX_SYMBOL_EXPOSURE_USD="25",
            )
        ),
    )

    payload = runtime_api.report()

    assert session.closed
    assert payload["config"]["market_data_network"] == "mainnet"
    assert payload["config"]["execution_network"] == "testnet"
    assert payload["config"]["trade_coins"] == ["xyz:NVDA", "xyz:AMD"]
    assert payload["config"]["excluded_coins"] == ["SPX"]
    assert payload["config"]["max_order_notional_usd"] == "10"
    assert payload["config"]["max_symbol_exposure_usd"] == "25"
    assert payload["config"]["halted_cooldown_seconds"] == 120


def test_api_run_one_cycle_success_and_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.rolled_back = False
            self.closed = False

        def rollback(self) -> None:
            self.rolled_back = True

        def close(self) -> None:
            self.closed = True

    class FakeService:
        def __init__(self, *, fail: bool = False) -> None:
            self.fail = fail
            self.optimizer_calls = 0

        def run_once(self, _session: FakeSession) -> CycleResult:
            if self.fail:
                raise RuntimeError("cycle_failed")
            return _cycle()

        def run_optimizer_once(self, _session: FakeSession) -> OptimizerGateResult:
            self.optimizer_calls += 1
            return OptimizerGateResult(promoted=False, reasons=("insufficient",))

    session = FakeSession()
    state = SimpleNamespace(
        config=_config(HYPERLIQUID_RUNTIME_OPTIMIZER_ENABLED="false"),
        service=FakeService(),
        latest_cycle=None,
        latest_error=None,
        latest_optimizer_at=None,
        metrics=HyperliquidRuntimeMetrics(),
    )
    monkeypatch.setattr(runtime_api, "SessionLocal", lambda: session)
    monkeypatch.setattr(runtime_api, "runtime_state", state)

    result = runtime_api._run_one_cycle()
    assert result.markets_seen == 2
    assert state.latest_error is None
    assert session.closed

    failing_session = FakeSession()
    state.service = FakeService(fail=True)
    monkeypatch.setattr(runtime_api, "SessionLocal", lambda: failing_session)
    with pytest.raises(RuntimeError, match="cycle_failed"):
        runtime_api._run_one_cycle()
    assert failing_session.rolled_back
    assert failing_session.closed
    assert state.latest_error == "RuntimeError:cycle_failed"


def test_api_run_one_cycle_runs_optimizer_when_due(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

        def rollback(self) -> None:
            raise AssertionError("rollback should not run")

    class FakeService:
        def __init__(self) -> None:
            self.optimizer_calls = 0

        def run_once(self, _session: FakeSession) -> CycleResult:
            return _cycle()

        def run_optimizer_once(self, _session: FakeSession) -> OptimizerGateResult:
            self.optimizer_calls += 1
            return OptimizerGateResult(promoted=True, reasons=())

    session = FakeSession()
    service = FakeService()
    state = SimpleNamespace(
        config=_config(
            HYPERLIQUID_RUNTIME_OPTIMIZER_ENABLED="true",
            HYPERLIQUID_RUNTIME_OPTIMIZER_INTERVAL_SECONDS="1",
        ),
        service=service,
        latest_cycle=None,
        latest_error=None,
        latest_optimizer_at=None,
        metrics=HyperliquidRuntimeMetrics(),
    )
    monkeypatch.setattr(runtime_api, "SessionLocal", lambda: session)
    monkeypatch.setattr(runtime_api, "runtime_state", state)

    runtime_api._run_one_cycle()

    assert service.optimizer_calls == 1
    assert state.latest_optimizer_at is not None
    assert state.metrics.optimizer_runs_total == 1
    assert state.metrics.optimizer_promoted_total == 1
    assert session.closed


def test_runtime_loop_continues_after_cycle_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    state = SimpleNamespace(
        config=_config(HYPERLIQUID_RUNTIME_POLL_INTERVAL_SECONDS="1")
    )

    async def fake_to_thread(_func: object) -> None:
        calls.append("cycle")
        if calls.count("cycle") == 1:
            raise RuntimeError("cycle_failed")
        raise asyncio.CancelledError

    async def fake_sleep(_seconds: float) -> None:
        calls.append("sleep")

    monkeypatch.setattr(runtime_api, "runtime_state", state)
    monkeypatch.setattr(runtime_api.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(runtime_api.asyncio, "sleep", fake_sleep)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(runtime_api._runtime_loop())

    assert calls == ["cycle", "sleep", "cycle"]


def test_runtime_readiness_stale_cycle() -> None:
    stale_cycle = CycleResult(
        observed_at=datetime.now(timezone.utc) - timedelta(seconds=1000),
        markets_seen=0,
        signals_written=0,
        decisions_written=0,
        orders_submitted=0,
        blocked_decisions=0,
        dependency_statuses=(RuntimeDependencyStatus("clickhouse", False),),
    )

    ready, reasons, dependencies = runtime_api.runtime_readiness(
        config=_config(HYPERLIQUID_RUNTIME_DEPENDENCY_STALENESS_SECONDS="1"),
        latest_cycle=stale_cycle,
        latest_error="boom",
    )

    assert not ready
    assert dependencies == stale_cycle.dependency_statuses
    assert "latest_cycle_failed" in reasons
    assert "dependency_not_ready:clickhouse" in reasons
    assert "runtime_cycle_stale" in reasons
