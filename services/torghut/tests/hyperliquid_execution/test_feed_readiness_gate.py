from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

from pytest import MonkeyPatch, raises

from app.hyperliquid_execution import feed_reader as feed_reader_module
from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.feed_reader import ClickHouseFeedReader, FeedStatus
from app.hyperliquid_execution.models import (
    AccountSnapshot,
    AccountState,
    ExecutionMarket,
    FeatureSnapshot,
    Fill,
    OrderIntent,
    OrderResult,
    PositionSnapshot,
    RuntimeDependencyStatus,
)
from app.trading.broker_mutation_receipts import BrokerMutationIoPermit
from app.hyperliquid_execution.service import HyperliquidExecutionService
from tests.hyperliquid_execution.test_runtime_surfaces import _ready_recovery_worker


def test_feed_reader_includes_feed_service_readiness(
    monkeypatch: MonkeyPatch,
) -> None:
    responses = {
        "http://feed/readyz": (
            503,
            '{"ready":false,"readinessBlockers":["market_data_stale"],'
            '"websocket":true,"kafka":true,"clickhouse":true}',
        )
    }

    def fake_request_http_get(*, url: str, timeout_seconds: int) -> tuple[int, str]:
        assert timeout_seconds == 7
        return responses[url]

    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_FEED_READINESS_URL": "http://feed/readyz",
            "HYPERLIQUID_EXECUTION_FEED_READINESS_TIMEOUT_SECONDS": "7",
        }
    )
    monkeypatch.setattr(
        feed_reader_module,
        "_request_http_get",
        fake_request_http_get,
    )
    reader = _FeedStatusReader(config)

    status = reader.status()

    assert status.ready is False
    feed_status = status.statuses[-1]
    assert feed_status.name == "hyperliquid_feed_service"
    assert feed_status.reason == "market_data_stale"
    assert feed_status.details == {
        "http_status": 503,
        "readinessBlockers": ["market_data_stale"],
        "websocket": True,
        "kafka": True,
        "clickhouse": True,
    }

    responses["http://feed/readyz"] = (
        200,
        '{"ready":true,"websocket":true,"kafka":true,"clickhouse":true}',
    )
    ready_status = reader.status()
    assert ready_status.ready is True
    assert ready_status.statuses[-1].name == "hyperliquid_feed_service"
    assert ready_status.statuses[-1].ready is True


def test_feed_reader_reports_feed_service_query_failures(
    monkeypatch: MonkeyPatch,
) -> None:
    def fake_request_http_get(*, url: str, timeout_seconds: int) -> tuple[int, str]:
        assert url == "http://feed/readyz"
        assert timeout_seconds == 3
        raise OSError("connection refused")

    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_FEED_READINESS_URL": "http://feed/readyz"}
    )
    monkeypatch.setattr(
        feed_reader_module,
        "_request_http_get",
        fake_request_http_get,
    )

    status = _FeedStatusReader(config).status()

    assert status.ready is False
    assert status.statuses[-1] == RuntimeDependencyStatus(
        "hyperliquid_feed_service",
        False,
        reason="feed_readiness_query_failed:OSError",
    )


def test_feed_reader_handles_invalid_feed_service_payload(
    monkeypatch: MonkeyPatch,
) -> None:
    def fake_request_http_get(*, url: str, timeout_seconds: int) -> tuple[int, str]:
        assert url == "http://feed/readyz"
        assert timeout_seconds == 3
        return 503, "{not-json"

    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_FEED_READINESS_URL": "http://feed/readyz"}
    )
    monkeypatch.setattr(
        feed_reader_module,
        "_request_http_get",
        fake_request_http_get,
    )

    status = _FeedStatusReader(config).status()

    assert status.ready is False
    assert status.statuses[-1] == RuntimeDependencyStatus(
        "hyperliquid_feed_service",
        False,
        reason="feed_readiness_http_503",
        details={"http_status": 503},
    )


def test_request_http_get_supports_http_and_https(
    monkeypatch: MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, int | None, int, bool]] = []

    class Response:
        status = 204

        def read(self) -> bytes:
            return b'{"ready":true}'

    class Connection:
        is_https = False

        def __init__(
            self,
            hostname: str,
            port: int | None = None,
            *,
            timeout: int,
        ) -> None:
            self.hostname = hostname
            self.port = port
            self.timeout = timeout

        def request(
            self,
            method: str,
            path: str,
            *,
            headers: Mapping[str, str],
        ) -> None:
            assert headers == {"Accept": "application/json"}
            calls.append(
                (
                    method,
                    path,
                    self.port,
                    self.timeout,
                    self.is_https,
                )
            )

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            calls.append(
                ("CLOSE", self.hostname, self.port, self.timeout, self.is_https)
            )

    class HttpsConnection(Connection):
        is_https = True

    monkeypatch.setattr(feed_reader_module.http.client, "HTTPConnection", Connection)
    monkeypatch.setattr(
        feed_reader_module.http.client, "HTTPSConnection", HttpsConnection
    )

    assert feed_reader_module._request_http_get(
        url="http://feed:8080/readyz?probe=1",
        timeout_seconds=4,
    ) == (204, '{"ready":true}')
    assert feed_reader_module._request_http_get(
        url="https://feed/readyz",
        timeout_seconds=9,
    ) == (204, '{"ready":true}')

    assert calls == [
        ("GET", "/readyz?probe=1", 8080, 4, False),
        ("CLOSE", "feed", 8080, 4, False),
        ("GET", "/readyz", None, 9, True),
        ("CLOSE", "feed", None, 9, True),
    ]


def test_request_http_get_rejects_invalid_urls() -> None:
    with raises(RuntimeError, match="unsupported_http_url_scheme:ftp"):
        feed_reader_module._request_http_get(
            url="ftp://feed/readyz",
            timeout_seconds=3,
        )
    with raises(RuntimeError, match="invalid_http_url_host"):
        feed_reader_module._request_http_get(
            url="http:///readyz",
            timeout_seconds=3,
        )


def test_service_blocks_orders_when_feed_service_is_not_ready() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    exchange = _Exchange(now)
    service = HyperliquidExecutionService(
        config=config,
        feed=_UnavailableFeed(now),
        exchange=exchange,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(_Session())

    assert result.signals_written == 1
    assert result.orders_submitted == 0
    assert exchange.submitted_coins == []
    assert result.universe_details["risk_blocks_by_reason"] == {
        "dependency_not_ready:hyperliquid_feed_service": 1
    }


class _FeedStatusReader(ClickHouseFeedReader):
    def query_json_each_row(
        self,
        query: str,
        *,
        includes_format: bool = False,
    ) -> list[dict[str, object]]:
        if "UNION ALL" in query or includes_format:
            return [
                {
                    "name": "hyperliquid_candles",
                    "observed_at": "2026-06-19T12:00:00+00:00",
                    "lag_seconds": 1,
                },
                {
                    "name": "hyperliquid_ta_features",
                    "observed_at": "2026-06-19T12:00:00+00:00",
                    "lag_seconds": 2,
                },
            ]
        return []


class _UnavailableFeed:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def status(self) -> FeedStatus:
        return FeedStatus(
            False,
            (
                RuntimeDependencyStatus(
                    "hyperliquid_feed_service",
                    False,
                    reason="market_data_stale",
                ),
            ),
        )

    def load_catalog_rows(self) -> list[dict[str, object]]:
        return [
            {
                "market_id": "hl:perp:xyz:NVDA",
                "coin": "NVDA",
                "dex": "xyz",
                "network": "mainnet",
                "market_type": "perp",
                "dayNtlVlm": "1000",
            }
        ]

    def load_feature_rows(self, _market_ids: list[str]) -> list[FeatureSnapshot]:
        return [_feature(self.now)]


class _Exchange:
    def __init__(self, now: datetime) -> None:
        self.now = now
        self.submitted_coins: list[str] = []

    def filter_supported_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        selected = tuple(
            replace(market, max_leverage=Decimal("20")) for market in markets
        )
        return selected, RuntimeDependencyStatus(
            "hyperliquid_execution_metadata",
            True,
            details={
                "active_execution_metadata": [market.coin for market in selected],
                "selected": [market.coin for market in selected],
            },
        )

    def filter_crossable_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        return markets, RuntimeDependencyStatus(
            "hyperliquid_testnet_liquidity",
            True,
            details={"selected": [market.coin for market in markets]},
        )

    def submit_order(
        self,
        intent: OrderIntent,
        *,
        mutation_permit: BrokerMutationIoPermit,
    ) -> OrderResult:
        del mutation_permit
        self.submitted_coins.append(intent.coin)
        return OrderResult("filled", "456", {"filled": {"oid": 456}})

    def close_position_reduce_only(
        self,
        _coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
    ) -> OrderResult:
        return OrderResult(
            "rejected",
            None,
            {"error": f"unexpected reduce-only call {size} {slippage}"},
        )

    def cancel_order(self, _order: object) -> OrderResult:
        return OrderResult("cancelled", "123", {"ok": True})

    def reconcile_fills(self, _market_id_by_coin: dict[str, str]) -> list[Fill]:
        return []

    def reconcile_account(self, _market_id_by_coin: dict[str, str]) -> AccountState:
        return _account_state(self.now)

    def reconcile_open_order_coins(self, _coins: frozenset[str]) -> frozenset[str]:
        return frozenset()

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus(
            "hyperliquid_exchange", True, observed_at=self.now
        )

    def execution_metadata_details(self) -> dict[str, object]:
        return {}


class _Session:
    def __init__(self) -> None:
        self.committed = False
        self.calls: list[tuple[str, Mapping[str, object] | None]] = []

    def execute(
        self,
        statement: object,
        params: Mapping[str, object] | None = None,
    ) -> "_Result":
        sql = str(statement)
        self.calls.append((sql, params))
        return _Result(self._rows_for(sql))

    def commit(self) -> None:
        self.committed = True

    def _rows_for(self, sql: str) -> list[dict[str, object]]:
        if "daily_realized_pnl_usd" in sql:
            return [
                {
                    "account_value_usd": "1000",
                    "withdrawable_usd": "900",
                    "gross_exposure_usd": "10",
                    "daily_realized_pnl_usd": "1",
                }
            ]
        if "SELECT DISTINCT coin" in sql:
            return []
        if "GROUP BY coin" in sql and "exposures" in sql:
            return []
        if "cooldown_until IS NOT NULL" in sql:
            return []
        if "expires_at <= :now" in sql:
            return []
        if "WITH" in sql and "fills_24h" in sql:
            return [
                {
                    "fills_24h": 0,
                    "notional_24h": "0",
                    "fees_24h": "0",
                    "net_pnl_24h": "0",
                    "fills_7d": 0,
                    "notional_7d": "0",
                    "fees_7d": "0",
                    "net_pnl_7d": "0",
                    "orders_24h": 0,
                    "filled_orders_24h": 0,
                    "cancelled_orders_24h": 0,
                    "rejected_orders_24h": 0,
                    "all_fills": 0,
                }
            ]
        if "FROM hyperliquid_execution_fills" in sql and "GROUP BY coin" in sql:
            return []
        return []


class _Result:
    def __init__(self, rows: Iterable[Mapping[str, object]]) -> None:
        self.rows = [dict(row) for row in rows]

    def mappings(self) -> "_Rows":
        return _Rows(self.rows)


class _Rows:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = rows

    def __iter__(self) -> Iterable[dict[str, object]]:
        return iter(self.rows)

    def one(self) -> dict[str, object]:
        return self.rows[0]

    def all(self) -> list[dict[str, object]]:
        return self.rows


def _feature(now: datetime) -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        event_ts=now,
        price=Decimal("100"),
        momentum_5m_bps=Decimal("20"),
        spread_bps=Decimal("1"),
        liquidity_usd=Decimal("100000"),
        volatility_bps=Decimal("12"),
        book_imbalance=Decimal("0.2"),
        source_lag_seconds=1,
        bid_price=Decimal("99.5"),
        ask_price=Decimal("100.5"),
        quote_lag_seconds=1,
        raw_features={"momentum": "20"},
    )


def _account_state(now: datetime) -> AccountState:
    return AccountState(
        account=AccountSnapshot(
            observed_at=now,
            account_value_usd=Decimal("1000"),
            withdrawable_usd=Decimal("900"),
            gross_exposure_usd=Decimal("10"),
            raw_payload={"account": "test"},
        ),
        positions=(
            PositionSnapshot(
                market_id="hl:perp:xyz:NVDA",
                coin="NVDA",
                size=Decimal("0.1"),
                entry_price=Decimal("100"),
                notional_usd=Decimal("10"),
                unrealized_pnl_usd=Decimal("0.25"),
                observed_at=now,
                raw_payload={"coin": "NVDA"},
            ),
        ),
    )


def _now() -> datetime:
    return datetime(2026, 6, 19, 12, tzinfo=timezone.utc)
