from __future__ import annotations

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
    OrderIntent,
    RuntimeDependencyStatus,
)


def _config(**overrides: str) -> HyperliquidRuntimeConfig:
    env = {
        "HYPERLIQUID_RUNTIME_EXECUTION_NETWORK": "testnet",
        "HYPERLIQUID_RUNTIME_EXCHANGE_API_URL": "https://api.hyperliquid-testnet.xyz",
        "HYPERLIQUID_RUNTIME_CLICKHOUSE_DATABASE": "torghut",
        "HYPERLIQUID_RUNTIME_MARKET_DATA_NETWORK": "mainnet",
    }
    env.update(overrides)
    return HyperliquidRuntimeConfig.from_env(env)


def _intent() -> OrderIntent:
    return OrderIntent(
        market_id="hl:perp:cash:cash:AAPL",
        coin="cash:AAPL",
        dex="cash",
        side="buy",
        size=Decimal("0.1"),
        limit_price=Decimal("200"),
        notional_usd=Decimal("20"),
        cloid="0x1234567890abcdef1234567890abcdef",
        reduce_only=False,
        decision_id="decision",
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
                '{"name":"hyperliquid_runtime_latest_features","observed_at":"2026-06-18T00:00:00","lag_seconds":8}\n'
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
    status = reader.status()

    assert features[0].price == Decimal("200")
    assert features[0].event_ts.tzinfo is not None
    assert status.ready
    assert {dependency.name for dependency in status.statuses} == {
        "hyperliquid_candles",
        "hyperliquid_runtime_latest_features",
    }
    assert any("hyperliquid_asset_contexts" in query for query in queries)
    assert any("JSONExtractRaw(a.payload, 'ctx')" in query for query in queries)
    assert any("FORMAT JSONEachRow" in query for query in queries)


def test_clickhouse_status_reports_query_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_request(**_kwargs: object) -> str:
        raise RuntimeError("boom")

    monkeypatch.setattr(clickhouse_module, "_request_clickhouse", fail_request)

    status = ClickHouseRuntimeReader(_config()).status()

    assert not status.ready
    assert status.statuses[0].reason == "clickhouse_query_failed:RuntimeError"


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
    shadow.schedule_dead_man_cancel(seconds_from_now=30)
    assert shadow.dependency_status().ready

    unavailable = UnavailableHyperliquidExchange(["missing_secret"])
    assert not unavailable.dependency_status().ready
    with pytest.raises(RuntimeError, match="hyperliquid_exchange_unavailable"):
        unavailable.submit_ioc_limit(_intent())
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
            sdk_calls["order"] = kwargs
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

    result = sdk_exchange.submit_ioc_limit(_intent())
    fills = sdk_exchange.reconcile_fills({"cash:AAPL": "hl:perp:cash:cash:AAPL"})
    sdk_exchange.schedule_dead_man_cancel(seconds_from_now=30)

    assert result.status == "accepted"
    assert result.exchange_order_id == "42"
    assert sdk_calls["order"]  # SDK received a real order payload.
    assert fills[0].notional_usd == Decimal("20.0")
    assert fills[0].fee_usd == Decimal("0.02")
    assert sdk_exchange.dependency_status().ready
    assert isinstance(exchange_from_config(config), HyperliquidSdkExchange)


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

        def run_once(self, _session: FakeSession) -> CycleResult:
            if self.fail:
                raise RuntimeError("cycle_failed")
            return _cycle()

    session = FakeSession()
    state = SimpleNamespace(
        service=FakeService(),
        latest_cycle=None,
        latest_error=None,
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
