"""Coverage for v2 API, feed, repository, and service surfaces."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import Response

from app.hyperliquid_execution import api
from app.hyperliquid_execution import feed_reader as feed_reader_module
from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.feed_reader import ClickHouseFeedReader, FeedStatus
from app.hyperliquid_execution.metrics import HyperliquidExecutionMetrics
from app.hyperliquid_execution.models import (
    AccountSnapshot,
    AccountState,
    CycleRecord,
    CycleResult,
    ExecutionMarket,
    FeatureSnapshot,
    Fill,
    OrderIntent,
    OrderResult,
    PositionSnapshot,
    RuntimeDependencyStatus,
    Signal,
)
from tests import broker_mutation_test_support as mutation_support
from tests.hyperliquid_execution.runtime_surface_test_support import (
    _FakeResult,
    _now,
)
from tests.hyperliquid_execution.submit_recovery_test_support import (
    _ready_recovery_worker,
)

from app.hyperliquid_execution.repository import HyperliquidExecutionRepository
from app.hyperliquid_execution.runtime_details import _string_list_detail
from app.hyperliquid_execution.service import (
    HyperliquidExecutionService,
    _CycleCounts,
    _feature_status,
    runtime_readiness,
)


def test_api_readiness_metrics_report_and_cycle_paths(monkeypatch: Any) -> None:
    now = _now()
    session = _FakeSession()
    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_ENABLED": "false"}
    )
    cycle = CycleResult(
        observed_at=now,
        markets_seen=1,
        selected_coins=("NVDA",),
        signals_written=1,
        orders_submitted=1,
        orders_cancelled=1,
        dependencies=(RuntimeDependencyStatus("feed", True),),
        universe_details={
            "selected": ["NVDA"],
            "profitability_gate": {"coin": "NVDA", "allowed": True},
        },
    )

    old_config = api.runtime_state.config
    old_cycle = api.runtime_state.latest_cycle
    old_error = api.runtime_state.latest_error
    old_metrics = api.runtime_state.metrics
    old_service = api.runtime_state.service
    try:
        api.runtime_state.config = config
        api.runtime_state.latest_cycle = None
        api.runtime_state.latest_error = None
        assert api.readyz(Response())["ready"] is False

        api.runtime_state.latest_cycle = cycle
        ready_response = Response()
        ready_payload = api.readyz(ready_response)
        assert ready_payload["ready"] is True
        assert (
            ready_payload["selected_coins"]
            if "selected_coins" in ready_payload
            else True
        )

        metrics = HyperliquidExecutionMetrics()
        metrics.record_cycle(cycle)
        metrics.record_error(ValueError("bad"))
        api.runtime_state.metrics = metrics
        assert "hyperliquid_execution_cycles_total 1" in api.metrics().body.decode()
        assert (
            'hyperliquid_execution_errors_total{error="ValueError"} 1'
            in api.metrics().body.decode()
        )

        monkeypatch.setattr(api, "SessionLocal", lambda: session)
        report = api.report()
        assert report["schema_version"] == "torghut.hyperliquid-execution-report.v2"
        assert report["runtime"]["selected_coins"] == ["NVDA"]
        assert report["config"]["signal_staleness_seconds"] == 120
        assert report["config"]["max_daily_loss_usd"] == "25"
        assert report["profitability_gate"] == {"coin": "NVDA", "allowed": True}
        status = api.trading_status()
        assert status["profitability_gate"] == {"coin": "NVDA", "allowed": True}
        assert session.closed

        service = _SingleCycleService(cycle)
        api.runtime_state.service = service
        session = _FakeSession()
        monkeypatch.setattr(api, "SessionLocal", lambda: session)
        assert api._run_one_cycle().orders_submitted == 1
        assert api.runtime_state.latest_error is None
        assert session.closed

        failing = _FailingService()
        api.runtime_state.service = failing
        session = _FakeSession()
        monkeypatch.setattr(api, "SessionLocal", lambda: session)
        try:
            api._run_one_cycle()
        except RuntimeError:
            pass
        assert api.runtime_state.latest_error == "RuntimeError:cycle_failed"
        assert session.rolled_back
    finally:
        api.runtime_state.config = old_config
        api.runtime_state.latest_cycle = old_cycle
        api.runtime_state.latest_error = old_error
        api.runtime_state.metrics = old_metrics
        api.runtime_state.service = old_service


def test_cycle_result_ignores_malformed_reduce_only_action_report() -> None:
    counts = _CycleCounts()

    counts.record_maintenance_reduce_only({"actions": "not-a-list"})

    assert counts.maintenance_reduce_only == {"actions": "not-a-list"}
    assert counts.orders_submitted == 0


def test_feed_reader_builds_queries_parses_features_and_reports_status() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_CLICKHOUSE_DATABASE": "torghut",
            "HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK": "mainnet",
        }
    )
    reader = _FakeFeedReader(config)

    assert reader.load_catalog_rows()[0]["coin"] == "NVDA"
    features = reader.load_feature_rows(["hl:perp:xyz:NVDA"])
    assert features[0].coin == "NVDA"
    assert features[0].bid_price == Decimal("99.5")
    status = reader.status()
    assert status.ready is True
    assert status.statuses[0].name == "hyperliquid_candles"
    assert "hyperliquid_market_catalog" in reader.queries[0]
    assert "FROM torghut.hyperliquid_ta_features" in reader.queries[1]
    assert "PREWHERE network = 'mainnet'" in reader.queries[1]
    assert "FROM torghut.hyperliquid_bbo" in reader.queries[1]
    assert "now() - toIntervalSecond(120)" in reader.queries[1]

    failing = _FailingFeedReader(config)
    assert failing.status().statuses[0].reason == "clickhouse_query_failed:RuntimeError"


def test_feed_reader_json_each_row_http_path(monkeypatch: Any) -> None:
    captured: dict[str, object] = {}

    def fake_request(**kwargs: object) -> str:
        captured.update(kwargs)
        return '\n{"coin":"NVDA","value":1}\n["ignored"]\n{"coin":"AMD"}\n'

    config = HyperliquidExecutionConfig.from_env({})
    monkeypatch.setattr(feed_reader_module, "_request_clickhouse", fake_request)
    reader = ClickHouseFeedReader(config)

    rows = reader.query_json_each_row("SELECT 1")

    assert captured["username"] == config.clickhouse_username
    assert "FORMAT JSONEachRow" in captured["query"]
    assert rows[0]["coin"] == "NVDA"
    assert rows[1]["coin"] == "AMD"


def test_repository_writes_runtime_evidence_and_report_rows() -> None:
    session = _FakeSession(
        reject_count=3,
        risk_open_coin=True,
        risk_exposure_usd=Decimal("25"),
        risk_cooldown=True,
    )
    repo = HyperliquidExecutionRepository(session)
    now = _now()
    market = _market()
    feature = _feature()
    signal = Signal(
        market_id=market.market_id,
        coin=market.coin,
        generated_at=now,
        action="buy",
        edge_bps=Decimal("12"),
        reason="positive_edge",
        feature=feature,
    )
    intent = _intent(now)
    accepted = OrderResult("accepted", "123", {"resting": True})
    fill = _fill(now)
    state = _account_state(now)

    repo.upsert_markets((market,))
    signal_id = repo.insert_signal(cycle_id="cycle", signal=signal)
    order_id = repo.insert_order(intent, accepted)
    repo.update_reject_cooldown(
        coin="NVDA",
        rejection_reason="could not immediately match",
        config=HyperliquidExecutionConfig.from_env({}),
    )
    repo.update_reject_cooldown(
        coin="NVDA",
        rejection_reason="Trading is halted.",
        config=HyperliquidExecutionConfig.from_env({}),
    )
    repo.update_reject_cooldown(
        coin="NVDA",
        rejection_reason=None,
        config=HyperliquidExecutionConfig.from_env({}),
    )
    expired = repo.expired_open_orders(now=now)
    repo.mark_order_cancelled(expired[0], OrderResult("cancelled", "123", {"ok": True}))
    assert repo.upsert_fills((fill,)) == 1
    repo.upsert_account_state(state)
    risk = repo.risk_state(
        trading_enabled=True,
        dependencies=(RuntimeDependencyStatus("feed", True),),
    )
    repo.insert_performance_snapshot(observed_at=now)
    repo.insert_cycle(
        CycleRecord(
            cycle_id="cycle",
            started_at=now,
            finished_at=now,
            trading_enabled=False,
            selected_coins=("NVDA",),
            signals_written=1,
            orders_submitted=1,
            orders_cancelled=1,
            dependency_statuses=(RuntimeDependencyStatus("feed", True),),
            universe_details={"selected": ["NVDA"]},
        )
    )
    report = repo.operational_report(
        runtime_payload={"selected_coins": ["NVDA"]},
        config_payload={"trading_enabled": False},
    )

    assert signal_id
    assert order_id
    assert risk.open_order_coins == frozenset({"NVDA"})
    assert risk.symbol_exposure_usd_by_coin["NVDA"] == Decimal("25")
    assert risk.cooldown_reason_by_coin["NVDA"] == "symbol_reject_cooldown"
    assert report["runtime"]["selected_coins"] == ["NVDA"]
    assert report["external_account_positions"][0]["coin"] == "SPX"
    assert report["external_account_positions"][0]["notional_usd"] == "99.32"
    assert any(
        params and params.get("reason") == "symbol_reject_cooldown"
        for _, params in session.calls
    )
    assert any(
        params and params.get("reason") == "trading_halted_until_metadata_refresh"
        for _, params in session.calls
    )


def test_repository_expired_open_orders_uses_order_market_id_dex() -> None:
    session = _FakeSession(open_order_market_id="hl:perp:legacy:NVDA")
    repo = HyperliquidExecutionRepository(session)

    expired = repo.expired_open_orders(now=_now())

    assert expired[0].dex == "legacy"
    assert not any(
        "JOIN hyperliquid_execution_symbol_state" in sql for sql, _ in session.calls
    )


def test_repository_cooldowns_repeated_broker_rejects() -> None:
    for rejection_reason, expected_sql in (
        ("Order must have minimum value of $10. asset=750014", "minimum value"),
        ("Insufficient margin to place order. asset=750002", "insufficient margin"),
    ):
        session = _FakeSession(reject_count=3)
        repo = HyperliquidExecutionRepository(session)

        repo.update_reject_cooldown(
            coin="NVDA",
            rejection_reason=rejection_reason,
            config=HyperliquidExecutionConfig.from_env({}),
        )

        assert any(expected_sql in sql for sql, _ in session.calls)
        assert any(
            params and params.get("reason") == "symbol_reject_cooldown"
            for _, params in session.calls
        )


_SUBMIT_COORDINATOR = mutation_support.PassthroughBrokerMutationSubmitCoordinator()


def test_service_cycle_cancels_reconciles_submits_and_records_cycle() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession()
    service = HyperliquidExecutionService(
        config=config,
        feed=_ServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.selected_coins == ("NVDA",)
    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert result.orders_cancelled == 1
    assert result.universe_details["risk_state"] == {
        "account_value_usd": "1000",
        "withdrawable_usd": "900",
        "gross_exposure_usd": "10",
        "daily_realized_pnl_usd": "1",
        "configured_daily_loss_floor_usd": "25",
        "effective_daily_loss_limit_usd": "350.000000",
    }
    assert session.committed
    cycle_calls = [
        index
        for index, (sql, _) in enumerate(session.calls)
        if "INSERT INTO hyperliquid_execution_cycles" in sql
    ]
    signal_call = next(
        index
        for index, (sql, _) in enumerate(session.calls)
        if "INSERT INTO hyperliquid_execution_signals" in sql
    )
    assert cycle_calls[0] < signal_call < cycle_calls[-1]


def test_service_selects_only_fresh_execution_markets() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA,xyz:MU",
        }
    )
    session = _FakeSession()
    exchange = _ServiceExchange(now)
    service = HyperliquidExecutionService(
        config=config,
        feed=_PartialFeatureServiceFeed(now),
        exchange=exchange,
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    dependencies = {dependency.name: dependency for dependency in result.dependencies}
    feature_dependency = dependencies["hyperliquid_mainnet_features"]
    assert result.selected_coins == ("NVDA",)
    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert feature_dependency.ready is True
    assert feature_dependency.reason is None
    assert feature_dependency.details["features"] == ["NVDA"]
    assert feature_dependency.details["missing"] == ["MU"]
    assert result.universe_details["selected"] == ["NVDA"]
    assert result.universe_details["selected_execution_metadata"] == ["NVDA", "MU"]
    assert result.universe_details["missing_fresh_features"] == ["MU"]
    assert exchange.reconciled_coins == {"NVDA", "xyz:NVDA"}


def test_service_reports_blocked_signal_reasons() -> None:
    now = _now()
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA",
        }
    )
    session = _FakeSession()
    service = HyperliquidExecutionService(
        config=config,
        feed=_SellServiceFeed(now),
        exchange=_ServiceExchange(now),
        submit_coordinator=_SUBMIT_COORDINATOR,
        recovery_worker=_ready_recovery_worker(),
    )

    result = service.run_once(session)

    assert result.orders_submitted == 0
    assert result.universe_details["risk_blocks_by_reason"] == {
        "short_entries_disabled": 1
    }
    assert result.universe_details["risk_blocks_by_coin"] == {
        "NVDA": {"short_entries_disabled": 1}
    }


def test_feature_status_and_detail_helpers_report_empty_paths() -> None:
    no_features = _feature_status((_market(),), ())
    no_markets = _feature_status((), ())

    assert no_features.ready is False
    assert no_features.reason == "no_fresh_features"
    assert no_markets.ready is False
    assert no_markets.reason == "no_execution_markets"
    assert _string_list_detail("NVDA") == []


def test_runtime_readiness_reports_config_errors_and_dependency_blockers() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK": "testnet",
        }
    )
    ready, reasons, dependencies = runtime_readiness(
        config=config,
        latest_cycle=None,
        latest_error="boom",
    )
    assert not ready
    assert "latest_cycle_error:boom" in reasons
    assert "no_successful_cycle" in reasons
    assert dependencies == ()

    cycle = CycleResult(
        observed_at=_now(),
        markets_seen=1,
        selected_coins=("NVDA",),
        signals_written=0,
        orders_submitted=0,
        orders_cancelled=0,
        dependencies=(RuntimeDependencyStatus("feed", False, reason="stale"),),
        universe_details={},
    )
    ready, reasons, dependencies = runtime_readiness(
        config=HyperliquidExecutionConfig.from_env({}),
        latest_cycle=cycle,
        latest_error=None,
    )
    assert not ready
    assert "dependency_not_ready:feed" in reasons
    assert dependencies == cycle.dependencies


class _SingleCycleService:
    def __init__(self, result: CycleResult) -> None:
        self.result = result

    def run_once(self, session: _FakeSession) -> CycleResult:
        session.commit()
        return self.result


class _FailingService:
    def run_once(self, _session: _FakeSession) -> CycleResult:
        raise RuntimeError("cycle_failed")


class _FakeFeedReader(ClickHouseFeedReader):
    def __init__(self, config: HyperliquidExecutionConfig) -> None:
        super().__init__(config)
        self.queries: list[str] = []

    def query_json_each_row(
        self,
        query: str,
        *,
        includes_format: bool = False,
    ) -> list[dict[str, object]]:
        self.queries.append(query)
        if "argMaxIf(momentum_5m_bps" in query:
            return [
                {
                    "market_id": "hl:perp:xyz:NVDA",
                    "coin": "NVDA",
                    "dex": "xyz",
                    "event_ts": "2026-06-19T12:00:00+00:00",
                    "price": "100",
                    "momentum_5m_bps": "12",
                    "spread_bps": "2",
                    "liquidity_usd": "100000",
                    "volatility_bps": "10",
                    "book_imbalance": "0.2",
                    "source_lag_seconds": "1",
                    "bid_price": "99.5",
                    "ask_price": "100.5",
                    "quote_lag_seconds": "1",
                }
            ]
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
        return [
            {
                "market_id": "hl:perp:xyz:NVDA",
                "coin": "NVDA",
                "dex": "xyz",
                "network": "mainnet",
                "market_type": "perp",
                "payload": {"dayNtlVlm": "100"},
                "dayNtlVlm": "100",
                "markPx": "100",
                "midPx": "100",
            }
        ]


class _FailingFeedReader(ClickHouseFeedReader):
    def query_json_each_row(
        self,
        _query: str,
        *,
        includes_format: bool = False,
    ) -> list[dict[str, object]]:
        raise RuntimeError("clickhouse_down")


class _ServiceFeed:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def status(self) -> FeedStatus:
        return FeedStatus(True, (RuntimeDependencyStatus("clickhouse", True),))

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
        return [_feature(event_ts=self.now)]


class _SellServiceFeed(_ServiceFeed):
    def load_feature_rows(self, _market_ids: list[str]) -> list[FeatureSnapshot]:
        return [_feature(event_ts=self.now, momentum_5m_bps=Decimal("-20"))]


class _LowEdgeServiceFeed(_ServiceFeed):
    def load_feature_rows(self, _market_ids: list[str]) -> list[FeatureSnapshot]:
        return [_feature(event_ts=self.now, momentum_5m_bps=Decimal("3"))]


class _PartialFeatureServiceFeed(_ServiceFeed):
    def load_catalog_rows(self) -> list[dict[str, object]]:
        return [
            {
                "market_id": "hl:perp:xyz:NVDA",
                "coin": "NVDA",
                "dex": "xyz",
                "network": "mainnet",
                "market_type": "perp",
                "dayNtlVlm": "1000",
            },
            {
                "market_id": "hl:perp:xyz:MU",
                "coin": "MU",
                "dex": "xyz",
                "network": "mainnet",
                "market_type": "perp",
                "dayNtlVlm": "900",
            },
        ]

    def load_feature_rows(self, market_ids: list[str]) -> list[FeatureSnapshot]:
        assert market_ids == ["hl:perp:xyz:NVDA", "hl:perp:xyz:MU"]
        return [_feature(event_ts=self.now)]


class _TwoExecutableServiceFeed(_PartialFeatureServiceFeed):
    def load_feature_rows(self, market_ids: list[str]) -> list[FeatureSnapshot]:
        assert set(market_ids) <= {"hl:perp:xyz:NVDA", "hl:perp:xyz:MU"}
        features_by_market_id = {
            "hl:perp:xyz:NVDA": _feature(event_ts=self.now),
            "hl:perp:xyz:MU": _feature(
                event_ts=self.now,
                market_id="hl:perp:xyz:MU",
                coin="MU",
            ),
        }
        return [features_by_market_id[market_id] for market_id in market_ids]


class _ServiceExchange:
    def __init__(
        self,
        now: datetime,
        *,
        account_state: AccountState | None = None,
    ) -> None:
        self.now = now
        self.account_state = account_state or _account_state(now)
        self.reconciled_coins: set[str] = set()
        self.submitted_coins: list[str] = []
        self.reduce_only_closes: list[tuple[str, Decimal | None, Decimal]] = []

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
                "max_leverage_by_coin": {
                    market.coin: str(market.max_leverage) for market in selected
                },
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

    def submit_order(self, intent: OrderIntent, **_kwargs: object) -> OrderResult:
        assert intent.tif == "Ioc"
        self.submitted_coins.append(intent.coin)
        return OrderResult("filled", "456", {"filled": {"oid": 456}})

    def close_position_reduce_only(
        self,
        coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
    ) -> OrderResult:
        self.reduce_only_closes.append((coin, size, slippage))
        return OrderResult("filled", "789", {"filled": {"oid": 789}})

    def cancel_order(self, _order: Any) -> OrderResult:
        return OrderResult("cancelled", "123", {"ok": True})

    def reconcile_fills(self, _market_id_by_coin: dict[str, str]) -> list[Fill]:
        self.reconciled_coins.update(_market_id_by_coin)
        return [_fill(self.now)]

    def reconcile_account(self, _market_id_by_coin: dict[str, str]) -> AccountState:
        self.reconciled_coins.update(_market_id_by_coin)
        return self.account_state

    def reconcile_open_order_coins(self, coins: frozenset[str]) -> frozenset[str]:
        self.reconciled_coins.update(coins)
        return frozenset()

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus(
            "hyperliquid_exchange", True, observed_at=self.now
        )

    def execution_metadata_details(self) -> dict[str, object]:
        return {}


class _FakeSession:
    def __init__(
        self,
        *,
        reject_count: int = 0,
        risk_open_coin: bool = False,
        risk_gross_exposure_usd: Decimal = Decimal("10"),
        risk_exposure_usd: Decimal = Decimal("0"),
        risk_cooldown: bool = False,
        profitability_net_pnl_24h: Decimal = Decimal("1"),
        profitability_notional_1h: Decimal = Decimal("10"),
        position_size: Decimal = Decimal("0"),
        position_sdk_coin: str | None = None,
        open_order_market_id: str = "hl:perp:xyz:NVDA",
    ) -> None:
        self.reject_count = reject_count
        self.risk_open_coin = risk_open_coin
        self.risk_gross_exposure_usd = risk_gross_exposure_usd
        self.risk_exposure_usd = risk_exposure_usd
        self.risk_cooldown = risk_cooldown
        self.profitability_net_pnl_24h = profitability_net_pnl_24h
        self.profitability_notional_1h = profitability_notional_1h
        self.position_size = position_size
        self.position_sdk_coin = position_sdk_coin
        self.open_order_market_id = open_order_market_id
        self.calls: list[tuple[str, Mapping[str, object] | None]] = []
        self.closed = False
        self.committed = False
        self.rolled_back = False

    def execute(
        self,
        statement: Any,
        params: Mapping[str, object] | None = None,
    ) -> "_FakeResult":
        sql = str(statement)
        self.calls.append((sql, params))
        return _FakeResult(self._rows_for(sql))

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True

    def _rows_for(self, sql: str) -> list[dict[str, object]]:
        if "INSERT INTO hyperliquid_execution_orders" in sql and "RETURNING id" in sql:
            return [{"id": "order-1"}]
        if "SELECT count(*) AS rejects" in sql:
            return [{"rejects": self.reject_count}]
        if "daily_realized_pnl_usd" in sql:
            return [
                {
                    "account_value_usd": "1000",
                    "withdrawable_usd": "900",
                    "gross_exposure_usd": str(self.risk_gross_exposure_usd),
                    "daily_realized_pnl_usd": "1",
                }
            ]
        if "SELECT DISTINCT coin" in sql:
            return [{"coin": "NVDA"}] if self.risk_open_coin else []
        if "SUM(ABS(notional_usd))" in sql:
            return [{"coin": "NVDA", "exposure_usd": str(self.risk_exposure_usd)}]
        if "GROUP BY coin" in sql and "exposures" in sql:
            return [{"coin": "NVDA", "exposure_usd": str(self.risk_exposure_usd)}]
        if "cooldown_reason" in sql and "cooldown_until > now()" in sql:
            if self.risk_cooldown:
                return [{"coin": "NVDA", "cooldown_reason": "symbol_reject_cooldown"}]
            return []
        if "net_pnl_after_fees_usd_24h" in sql and "notional_usd_1h" in sql:
            return self._profitability_rows()
        if "FROM hyperliquid_execution_positions" in sql and "LIMIT 1" in sql:
            return self._position_rows()
        if "expires_at <= :now" in sql:
            return [
                {
                    "id": "order-1",
                    "market_id": self.open_order_market_id,
                    "coin": "NVDA",
                    "exchange_order_id": "123",
                    "cloid": "0xabc",
                    "status": "accepted",
                    "expires_at": _now() - timedelta(seconds=1),
                }
            ]
        if "WITH" in sql and "fills_24h" in sql:
            return [
                {
                    "fills_24h": 1,
                    "notional_24h": "10",
                    "fees_24h": "0.01",
                    "net_pnl_24h": "0.50",
                    "fills_7d": 1,
                    "notional_7d": "10",
                    "fees_7d": "0.01",
                    "net_pnl_7d": "0.50",
                    "orders_24h": 2,
                    "filled_orders_24h": 1,
                    "cancelled_orders_24h": 1,
                    "rejected_orders_24h": 0,
                    "all_fills": 41,
                }
            ]
        if "FROM hyperliquid_execution_fills" in sql and "GROUP BY coin" in sql:
            return [
                {
                    "coin": "NVDA",
                    "fills": 1,
                    "notional_usd": "10",
                    "fees_usd": "0.01",
                    "net_pnl_after_fees_usd": "0.50",
                }
            ]
        if (
            "FROM hyperliquid_execution_account_snapshots" in sql
            and "raw_payload" in sql
        ):
            return [
                {
                    "observed_at": str(_now()),
                    "account_value_usd": "1000",
                    "withdrawable_usd": "900",
                    "gross_exposure_usd": "99.32",
                    "raw_payload": {
                        "assetPositions": [
                            {
                                "position": {
                                    "coin": "SPX",
                                    "szi": "275.2",
                                    "entryPx": "0.36091",
                                    "positionValue": "99.32",
                                    "unrealizedPnl": "-0.1",
                                }
                            }
                        ]
                    },
                }
            ]
        return [{"coin": "NVDA", "value": Decimal("1"), "observed_at": _now()}]

    def _profitability_rows(self) -> list[dict[str, object]]:
        return [
            {
                "net_pnl_after_fees_usd_24h": str(self.profitability_net_pnl_24h),
                "notional_usd_1h": str(self.profitability_notional_1h),
                "last_entry_at": None,
                "last_side": None,
                "last_side_at": None,
                "last_position_close_side": None,
                "last_position_close_at": None,
            }
        ]

    def _position_rows(self) -> list[dict[str, object]]:
        if self.position_size == Decimal("0"):
            return []
        return [
            {
                "market_id": "hl:perp:xyz:NVDA",
                "coin": "NVDA",
                "size": str(self.position_size),
                "entry_price": "100",
                "notional_usd": "10",
                "unrealized_pnl_usd": "0.25",
                "observed_at": _now(),
                "raw_payload": {"coin": self.position_sdk_coin or "NVDA"},
            }
        ]


def _market() -> ExecutionMarket:
    return ExecutionMarket(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        network="mainnet",
        day_notional_volume_usd=Decimal("1000"),
        mark_price=Decimal("100"),
        mid_price=Decimal("100"),
        payload={"source": "test"},
    )


def _feature(
    *,
    event_ts: datetime | None = None,
    momentum_5m_bps: Decimal = Decimal("30"),
    market_id: str = "hl:perp:xyz:NVDA",
    coin: str = "NVDA",
) -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id=market_id,
        coin=coin,
        dex="xyz",
        event_ts=event_ts or _now(),
        price=Decimal("100"),
        momentum_5m_bps=momentum_5m_bps,
        spread_bps=Decimal("1"),
        liquidity_usd=Decimal("100000"),
        volatility_bps=Decimal("12"),
        book_imbalance=Decimal("0.2"),
        source_lag_seconds=1,
        bid_price=Decimal("99.5"),
        ask_price=Decimal("100.5"),
        quote_lag_seconds=1,
        raw_features={"momentum": str(momentum_5m_bps)},
    )


def _intent(now: datetime) -> OrderIntent:
    return OrderIntent(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        side="buy",
        size=Decimal("0.1"),
        limit_price=Decimal("99.5"),
        notional_usd=Decimal("9.95"),
        cloid="0xabc",
        tif="Ioc",
        reduce_only=False,
        signal_id="signal",
        expires_at=now + timedelta(seconds=45),
    )


def _fill(now: datetime) -> Fill:
    return Fill(
        fill_hash="fill-1",
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        side="buy",
        price=Decimal("100"),
        size=Decimal("0.1"),
        notional_usd=Decimal("10"),
        fee_usd=Decimal("0.01"),
        closed_pnl_usd=Decimal("0.50"),
        exchange_order_id="123",
        event_ts=now,
        raw_payload={"hash": "fill-1"},
    )


def _account_state(
    now: datetime,
    *,
    gross_exposure_usd: Decimal = Decimal("10"),
    position_size: Decimal = Decimal("0.1"),
    position_notional_usd: Decimal = Decimal("10"),
) -> AccountState:
    return AccountState(
        account=AccountSnapshot(
            observed_at=now,
            account_value_usd=Decimal("1000"),
            withdrawable_usd=Decimal("900"),
            gross_exposure_usd=gross_exposure_usd,
            raw_payload={"account": "test"},
        ),
        positions=(
            PositionSnapshot(
                market_id="hl:perp:xyz:NVDA",
                coin="NVDA",
                size=position_size,
                entry_price=Decimal("100"),
                notional_usd=position_notional_usd,
                unrealized_pnl_usd=Decimal("0.25"),
                observed_at=now,
                raw_payload={"coin": "NVDA", "maxLeverage": "20"},
            ),
        ),
    )
