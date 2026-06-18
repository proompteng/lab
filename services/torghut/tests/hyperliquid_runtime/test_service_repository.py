from __future__ import annotations

from collections.abc import Iterator, Sequence
from datetime import datetime, timezone
from decimal import Decimal

from pytest import MonkeyPatch

from app.hyperliquid_runtime import service as service_module
from app.hyperliquid_runtime.clickhouse import ClickHouseStatus
from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.ledger import HyperliquidJournalEvent
from app.hyperliquid_runtime.models import (
    AccountSnapshot,
    AccountState,
    DecisionRecord,
    FeatureSnapshot,
    Fill,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
    PerformanceSnapshot,
    PositionSnapshot,
    RiskState,
    RuntimeDependencyStatus,
)
from app.hyperliquid_runtime.repository import HyperliquidRuntimeRepository
from app.hyperliquid_runtime.runtime_session import RuntimeSession
from app.hyperliquid_runtime.service import HyperliquidRuntimeService
from app.hyperliquid_runtime.strategy import generate_signal


def _config(**overrides: str) -> HyperliquidRuntimeConfig:
    env = {
        "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "false",
        "HYPERLIQUID_RUNTIME_EXECUTION_NETWORK": "testnet",
        "TORGHUT_TIGERBEETLE_ENABLED": "true",
        "TORGHUT_TIGERBEETLE_REQUIRED": "true",
        "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED": "true",
    }
    env.update(overrides)
    return HyperliquidRuntimeConfig.from_env(env)


def _feature() -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id="hl:perp:cash:cash:AAPL",
        coin="cash:AAPL",
        dex="cash",
        event_ts=datetime(2026, 6, 18, tzinfo=timezone.utc),
        price=Decimal("200"),
        momentum_1m_bps=Decimal("3"),
        momentum_3m_bps=Decimal("7"),
        momentum_5m_bps=Decimal("12"),
        momentum_15m_bps=Decimal("20"),
        momentum_1h_bps=Decimal("45"),
        volatility_bps=Decimal("60"),
        vwap_distance_bps=Decimal("5"),
        spread_bps=Decimal("4"),
        book_imbalance=Decimal("0.10"),
        liquidity_usd=Decimal("500000"),
        funding_rate=Decimal("0.0001"),
        open_interest_usd=Decimal("1000000"),
        regime="trend",
        source_lag_seconds=10,
    )


def _market() -> HyperliquidMarket:
    return HyperliquidMarket(
        market_id="hl:perp:cash:cash:AAPL",
        coin="cash:AAPL",
        dex="cash",
        asset_class="stocks",
        network="mainnet",
        day_notional_volume_usd=Decimal("500000"),
        mark_price=Decimal("200"),
        mid_price=None,
        open_interest_usd=Decimal("1000000"),
        max_leverage=3,
        payload={"dayNtlVlm": "500000"},
    )


def _fill() -> Fill:
    return Fill(
        market_id="hl:perp:cash:cash:AAPL",
        coin="cash:AAPL",
        side="buy",
        price=Decimal("200"),
        size=Decimal("0.1"),
        notional_usd=Decimal("20"),
        fee_usd=Decimal("0.01"),
        closed_pnl_usd=Decimal("0.50"),
        exchange_order_id="42",
        fill_hash="fill-hash",
        event_ts=datetime(2026, 6, 18, tzinfo=timezone.utc),
        raw_payload={"hash": "fill-hash"},
    )


def _account_state() -> AccountState:
    observed_at = datetime(2026, 6, 18, tzinfo=timezone.utc)
    return AccountState(
        account=AccountSnapshot(
            observed_at=observed_at,
            account_value_usd=Decimal("1000"),
            withdrawable_usd=Decimal("900"),
            gross_exposure_usd=Decimal("20"),
            raw_payload={"marginSummary": {"accountValue": "1000"}},
        ),
        positions=(
            PositionSnapshot(
                market_id="hl:perp:cash:cash:AAPL",
                coin="cash:AAPL",
                size=Decimal("0.1"),
                entry_price=Decimal("200"),
                notional_usd=Decimal("20"),
                unrealized_pnl_usd=Decimal("0.75"),
                observed_at=observed_at,
                raw_payload={"coin": "cash:AAPL"},
            ),
        ),
    )


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
        decision_id="decision-id",
    )


class _MappingResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def mappings(self) -> "_MappingResult":
        return self

    def one(self) -> dict[str, object]:
        return self._rows[0]

    def __iter__(self) -> Iterator[dict[str, object]]:
        return iter(self._rows)


class _FakeSession:
    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, object] | None]] = []
        self.committed = False
        self.closed_order_rows: list[dict[str, object]] = []

    def execute(
        self, statement: object, params: dict[str, object] | None = None
    ) -> _MappingResult:
        sql = str(statement)
        self.executed.append((sql, params))
        if "gross_exposure_usd" in sql:
            return _MappingResult(
                [
                    {
                        "gross_exposure_usd": "25.5",
                        "daily_realized_pnl_usd": "-1.25",
                        "unrealized_pnl_usd": "0.75",
                        "daily_fees_usd": "0.01",
                    }
                ]
            )
        if "SELECT DISTINCT market_id" in sql:
            return _MappingResult([{"market_id": "hl:perp:cash:cash:AAPL"}])
        if "FROM hyperliquid_runtime_orders o" in sql:
            return _MappingResult(self.closed_order_rows)
        if "fill_summary AS" in sql:
            return _MappingResult(
                [
                    {
                        "trade_count": "50",
                        "net_pnl_usd": "5.25",
                        "max_drawdown_usd": "1.50",
                        "stale_period_count": "0",
                        "reconciliation_gap_count": "0",
                    }
                ]
            )
        return _MappingResult([])

    def commit(self) -> None:
        self.committed = True


def test_repository_writes_runtime_tables_and_reads_risk_state() -> None:
    session = _FakeSession()
    repository = HyperliquidRuntimeRepository(session)
    signal = generate_signal(_feature(), parameter_version="test-v1")

    repository.upsert_markets([_market()])
    signal_id = repository.insert_signal(signal)
    decision_id = repository.insert_decision(
        DecisionRecord(
            signal_id=signal_id,
            signal=signal,
            status="allowed",
            reason="allowed",
            order_notional_usd=Decimal("20"),
        )
    )
    order_id = repository.insert_order(
        _intent(),
        OrderResult(
            status="accepted",
            exchange_order_id="42",
            rejection_reason=None,
            raw_response={"ok": True},
        ),
    )
    fill_count = repository.upsert_fills([_fill()])
    repository.upsert_account_state(_account_state())
    repository.insert_performance_snapshot(
        PerformanceSnapshot(
            observed_at=datetime(2026, 6, 18, tzinfo=timezone.utc),
            gross_exposure_usd=Decimal("20"),
            realized_pnl_usd=Decimal("1"),
            unrealized_pnl_usd=Decimal("0"),
            fees_usd=Decimal("0.01"),
            trade_count=1,
            reconciliation_status="pass",
        )
    )
    risk_state = repository.risk_state(
        dependencies=(RuntimeDependencyStatus("clickhouse", True),)
    )

    assert signal_id
    assert decision_id
    assert order_id
    assert fill_count == 1
    assert risk_state.gross_exposure_usd == Decimal("25.5")
    assert risk_state.daily_realized_pnl_usd == Decimal("-1.25")
    assert risk_state.unrealized_pnl_usd == Decimal("0.75")
    assert risk_state.daily_fees_usd == Decimal("0.01")
    assert risk_state.open_order_markets == frozenset({"hl:perp:cash:cash:AAPL"})
    assert any(
        params and params.get("coin") == "cash:AAPL" for _, params in session.executed
    )


def test_repository_reconciles_orders_not_open_on_exchange() -> None:
    session = _FakeSession()
    session.closed_order_rows = [
        {
            "decision_id": "decision-cancelled",
            "network": "testnet",
            "market_id": "hl:perp:cash:cash:AAPL",
            "coin": "cash:AAPL",
            "cloid": "0x11111111111111111111111111111111",
            "exchange_order_id": "41",
            "side": "buy",
            "size": "0.1",
            "limit_price": "200",
            "notional_usd": "20",
            "reduce_only": False,
            "has_fill": False,
        },
        {
            "decision_id": "decision-filled",
            "network": "testnet",
            "market_id": "hl:perp:cash:cash:MSFT",
            "coin": "cash:MSFT",
            "cloid": "0x22222222222222222222222222222222",
            "exchange_order_id": "42",
            "side": "sell",
            "size": "0.2",
            "limit_price": "300",
            "notional_usd": "60",
            "reduce_only": False,
            "has_fill": True,
        },
        {
            "decision_id": "decision-open",
            "network": "testnet",
            "market_id": "hl:perp:cash:cash:TSLA",
            "coin": "cash:TSLA",
            "cloid": "0x33333333333333333333333333333333",
            "exchange_order_id": "43",
            "side": "buy",
            "size": "0.1",
            "limit_price": "250",
            "notional_usd": "25",
            "reduce_only": False,
            "has_fill": False,
        },
    ]
    repository = HyperliquidRuntimeRepository(session)

    release_orders = repository.reconcile_closed_orders(
        open_order_market_ids=frozenset({"hl:perp:cash:cash:TSLA"})
    )

    assert len(release_orders) == 1
    intent, result = release_orders[0]
    assert intent.market_id == "hl:perp:cash:cash:AAPL"
    assert intent.dex == "cash"
    assert result.status == "cancelled"
    assert result.rejection_reason == "not_open_on_exchange_reconciliation"
    update_params = [
        params
        for sql, params in session.executed
        if "UPDATE hyperliquid_runtime_orders" in sql
    ]
    assert [params["status"] for params in update_params if params] == [
        "cancelled",
        "filled",
    ]


class _FakeRepository:
    def __init__(self, _session: _FakeSession) -> None:
        self.orders: list[tuple[OrderIntent, OrderResult]] = []
        self.performance: list[PerformanceSnapshot] = []
        self.account_states: list[AccountState] = []
        self.closed_order_releases: list[tuple[OrderIntent, OrderResult]] = []
        self.reconciled_open_order_market_ids: list[frozenset[str]] = []

    def upsert_markets(self, markets: list[HyperliquidMarket]) -> None:
        self.markets = markets

    def upsert_fills(self, fills: list[Fill]) -> int:
        self.fills = fills
        return len(fills)

    def upsert_account_state(self, account_state: AccountState) -> None:
        self.account_states.append(account_state)

    def reconcile_closed_orders(
        self, *, open_order_market_ids: frozenset[str]
    ) -> list[tuple[OrderIntent, OrderResult]]:
        self.reconciled_open_order_market_ids.append(open_order_market_ids)
        return self.closed_order_releases

    def risk_state(
        self, *, dependencies: tuple[RuntimeDependencyStatus, ...]
    ) -> RiskState:
        return RiskState(
            gross_exposure_usd=Decimal("0"),
            daily_realized_pnl_usd=Decimal("0"),
            unrealized_pnl_usd=Decimal("0"),
            daily_fees_usd=Decimal("0"),
            open_order_markets=frozenset(),
            dependencies=dependencies,
        )

    def insert_signal(self, _signal: object) -> str:
        return "signal-id"

    def insert_decision(self, decision: DecisionRecord) -> str:
        self.decision = decision
        return "decision-id"

    def insert_order(self, intent: OrderIntent, result: OrderResult) -> str:
        self.orders.append((intent, result))
        return "order-id"

    def insert_performance_snapshot(self, snapshot: PerformanceSnapshot) -> None:
        self.performance.append(snapshot)


class _FakeClickHouse:
    def __init__(self, *, features: list[FeatureSnapshot] | None = None) -> None:
        self._features = features if features is not None else [_feature()]

    def status(self) -> ClickHouseStatus:
        return ClickHouseStatus(
            ready=True,
            statuses=(RuntimeDependencyStatus("clickhouse", True),),
        )

    def load_catalog_rows(self) -> list[dict[str, object]]:
        return [
            {
                "market_type": "perp",
                "market_id": "hl:perp:cash:cash:AAPL",
                "coin": "cash:AAPL",
                "dex": "cash",
                "payload": '{"dayNtlVlm":"500000","markPx":"200","openInterest":"1000000"}',
            }
        ]

    def load_feature_rows(self, _market_ids: list[str]) -> list[FeatureSnapshot]:
        return self._features

    def load_optimizer_history_summary(self) -> dict[str, object]:
        return {
            "feature_rows": "1000",
            "market_count": "44",
            "stale_feature_rows": "0",
        }


class _FakeExchange:
    def __init__(
        self,
        *,
        fills: bool = True,
        supports_markets: bool = True,
        fail_submit: bool = False,
        open_order_market_ids: frozenset[str] | None = None,
    ) -> None:
        self.submitted: list[OrderIntent] = []
        self.open_order_reconcile_inputs: list[dict[str, str]] = []
        self._fills = fills
        self._supports_markets = supports_markets
        self._fail_submit = fail_submit
        self._open_order_market_ids = open_order_market_ids or frozenset()

    def filter_supported_markets(
        self,
        markets: tuple[HyperliquidMarket, ...],
    ) -> tuple[tuple[HyperliquidMarket, ...], RuntimeDependencyStatus]:
        if self._supports_markets:
            return (
                markets,
                RuntimeDependencyStatus("hyperliquid_execution_universe", True),
            )
        return (
            (),
            RuntimeDependencyStatus(
                "hyperliquid_execution_universe",
                False,
                reason="no_execution_supported_markets",
            ),
        )

    def reconcile_fills(self, _market_id_by_coin: dict[str, str]) -> list[Fill]:
        if not self._fills:
            return []
        return [_fill()]

    def reconcile_account(self, _market_id_by_coin: dict[str, str]) -> AccountState:
        return _account_state()

    def reconcile_open_order_market_ids(
        self, market_id_by_coin: dict[str, str]
    ) -> frozenset[str]:
        self.open_order_reconcile_inputs.append(market_id_by_coin)
        return self._open_order_market_ids

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus("hyperliquid_exchange_shadow", True)

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        if self._fail_submit:
            raise TimeoutError("exchange down")
        self.submitted.append(intent)
        return OrderResult(status="submitted", exchange_order_id=None, raw_response={})

    def schedule_dead_man_cancel(self, *, seconds_from_now: int) -> None:
        self.dead_man_seconds = seconds_from_now


class _FakeJournal:
    def __init__(self, *, ready: bool = True) -> None:
        self.persisted: list[HyperliquidJournalEvent] = []
        self._ready = ready

    def fill_events(self, fill: Fill) -> list[HyperliquidJournalEvent]:
        return [_journal_event(fill.fill_hash, "fill")]

    def order_events(
        self, intent: OrderIntent, result: OrderResult
    ) -> list[HyperliquidJournalEvent]:
        return [_journal_event(intent.cloid, f"order_{result.status}")]

    def persist_refs(
        self,
        _session: RuntimeSession,
        events: Sequence[HyperliquidJournalEvent],
    ) -> int:
        self.persisted.extend(events)
        return len(events)

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus(
            "hyperliquid_tigerbeetle",
            self._ready,
            reason=None if self._ready else "tigerbeetle_unavailable:RuntimeError",
        )


def _journal_event(source_id: str, transfer_kind: str) -> HyperliquidJournalEvent:
    return HyperliquidJournalEvent(
        source_id=source_id,
        transfer_kind=transfer_kind,
        amount_usd=Decimal("1"),
        debit_account_key="testnet:debit",
        credit_account_key="testnet:credit",
        transfer_code=1,
    )


def test_runtime_service_orchestrates_signal_order_and_accounting(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange()
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
        ),
        clickhouse=_FakeClickHouse(),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 1
    assert result.signals_written == 1
    assert result.decisions_written == 1
    assert result.orders_submitted == 1
    assert result.blocked_decisions == 0
    assert exchange.submitted[0].side == "buy"
    assert repository.orders[0][0].decision_id == "decision-id"
    assert repository.account_states[0].positions[0].coin == "cash:AAPL"
    assert repository.performance[0].reconciliation_status == "pass"
    assert exchange.dead_man_seconds == 60
    assert exchange.open_order_reconcile_inputs == [
        {"cash:AAPL": "hl:perp:cash:cash:AAPL"}
    ]
    assert [event.transfer_kind for event in journal.persisted] == [
        "fill",
        "order_submitted",
    ]


def test_runtime_service_releases_reconciled_closed_orders(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    repository.closed_order_releases = [
        (
            _intent(),
            OrderResult(
                status="cancelled",
                exchange_order_id="42",
                raw_response={
                    "reconciliation": {
                        "source": "exchange_open_orders",
                        "open_on_exchange": False,
                    }
                },
                rejection_reason="not_open_on_exchange_reconciliation",
            ),
        )
    ]
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
        ),
        clickhouse=_FakeClickHouse(features=[]),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert result.orders_submitted == 0
    assert repository.reconciled_open_order_market_ids == [frozenset()]
    assert [event.transfer_kind for event in journal.persisted] == ["order_cancelled"]
    assert session.committed


def test_runtime_service_persists_guarded_optimizer_run() -> None:
    service = HyperliquidRuntimeService(
        config=_config(HYPERLIQUID_RUNTIME_OPTIMIZER_MIN_TRADES="10"),
        clickhouse=_FakeClickHouse(),
        exchange=_FakeExchange(),
        journal=_FakeJournal(),
    )
    session = _FakeSession()

    result = service.run_optimizer_once(session)

    assert result is not None
    assert result.promoted
    assert session.committed
    optimizer_insert = [
        params
        for sql, params in session.executed
        if "hyperliquid_runtime_optimizer_runs" in sql
    ]
    assert optimizer_insert
    assert optimizer_insert[0]
    assert optimizer_insert[0]["parameter_version"] == (
        "hl-equity-momentum-v1-offline-v1"
    )
    assert optimizer_insert[0]["promoted"] is True


def test_runtime_service_releases_hold_when_submit_raises(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False, fail_submit=True)
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
        ),
        clickhouse=_FakeClickHouse(),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert result.orders_submitted == 1
    assert repository.orders[0][1].status == "rejected"
    assert repository.orders[0][1].rejection_reason == (
        "exchange_submit_failed:TimeoutError"
    )
    assert [event.transfer_kind for event in journal.persisted] == [
        "order_submitted",
        "order_rejected",
    ]
    assert session.committed


def test_runtime_service_shadow_mode_does_not_submit_or_journal_orders(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(),
        clickhouse=_FakeClickHouse(),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 1
    assert result.signals_written == 1
    assert result.decisions_written == 1
    assert result.orders_submitted == 0
    assert result.blocked_decisions == 1
    assert repository.decision.reason == "trading_disabled_shadow"
    assert exchange.submitted == []
    assert repository.orders == []
    assert journal.persisted == []


def test_runtime_service_blocks_when_tigerbeetle_is_not_ready(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal(ready=False)
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
        ),
        clickhouse=_FakeClickHouse(),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.orders_submitted == 0
    assert result.blocked_decisions == 1
    assert repository.decision.reason == "dependency_not_ready:hyperliquid_tigerbeetle"
    assert repository.performance[0].reconciliation_status == "tigerbeetle_stale"
    assert exchange.submitted == []
    assert journal.persisted == []


def test_runtime_service_blocks_when_no_testnet_execution_markets(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False, supports_markets=False)
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
        ),
        clickhouse=_FakeClickHouse(),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 0
    assert result.signals_written == 0
    assert result.decisions_written == 0
    assert result.orders_submitted == 0
    assert any(
        dependency.name == "hyperliquid_execution_universe"
        and not dependency.ready
        and dependency.reason == "no_execution_supported_markets"
        for dependency in result.dependency_statuses
    )
    assert exchange.submitted == []
    assert repository.orders == []
    assert journal.persisted == []


def test_runtime_service_marks_missing_execution_features_not_ready(
    monkeypatch: MonkeyPatch,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange(fills=False)
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(
            HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
            HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
            HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
        ),
        clickhouse=_FakeClickHouse(features=[]),
        exchange=exchange,
        journal=journal,
    )
    session = _FakeSession()

    result = service.run_once(session)

    assert session.committed
    assert result.markets_seen == 1
    assert result.signals_written == 0
    assert result.decisions_written == 0
    assert result.orders_submitted == 0
    assert any(
        dependency.name == "hyperliquid_execution_features"
        and not dependency.ready
        and dependency.reason == "missing_fresh_features_for_execution_markets"
        for dependency in result.dependency_statuses
    )
    assert exchange.submitted == []
    assert repository.orders == []
