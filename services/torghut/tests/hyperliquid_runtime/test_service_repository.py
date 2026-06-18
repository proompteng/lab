from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from app.hyperliquid_runtime import service as service_module
from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.models import (
    DecisionRecord,
    FeatureSnapshot,
    Fill,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
    PerformanceSnapshot,
    RiskState,
    RuntimeDependencyStatus,
)
from app.hyperliquid_runtime.repository import HyperliquidRuntimeRepository
from app.hyperliquid_runtime.service import HyperliquidRuntimeService
from app.hyperliquid_runtime.strategy import generate_signal


def _config(**overrides: str) -> HyperliquidRuntimeConfig:
    env = {
        "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "false",
        "HYPERLIQUID_RUNTIME_EXECUTION_NETWORK": "testnet",
    }
    env.update(overrides)
    return HyperliquidRuntimeConfig.from_env(env)


def _feature(**overrides: object) -> FeatureSnapshot:
    values: dict[str, object] = {
        "market_id": "hl:perp:cash:cash:AAPL",
        "coin": "cash:AAPL",
        "dex": "cash",
        "event_ts": datetime(2026, 6, 18, tzinfo=timezone.utc),
        "price": Decimal("200"),
        "momentum_1m_bps": Decimal("3"),
        "momentum_3m_bps": Decimal("7"),
        "momentum_5m_bps": Decimal("12"),
        "momentum_15m_bps": Decimal("20"),
        "momentum_1h_bps": Decimal("45"),
        "volatility_bps": Decimal("60"),
        "vwap_distance_bps": Decimal("5"),
        "spread_bps": Decimal("4"),
        "book_imbalance": Decimal("0.10"),
        "liquidity_usd": Decimal("500000"),
        "funding_rate": Decimal("0.0001"),
        "open_interest_usd": Decimal("1000000"),
        "regime": "trend",
        "source_lag_seconds": 10,
    }
    values.update(overrides)
    return FeatureSnapshot(**values)  # type: ignore[arg-type]


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

    def __iter__(self) -> Any:
        return iter(self._rows)


class _FakeSession:
    def __init__(self) -> None:
        self.executed: list[tuple[str, dict[str, object] | None]] = []
        self.committed = False

    def execute(
        self, statement: object, params: dict[str, object] | None = None
    ) -> _MappingResult:
        sql = str(statement)
        self.executed.append((sql, params))
        if "gross_exposure_usd" in sql:
            return _MappingResult(
                [{"gross_exposure_usd": "25.5", "daily_realized_pnl_usd": "-1.25"}]
            )
        if "SELECT DISTINCT market_id" in sql:
            return _MappingResult([{"market_id": "hl:perp:cash:cash:AAPL"}])
        return _MappingResult([])

    def commit(self) -> None:
        self.committed = True


def test_repository_writes_runtime_tables_and_reads_risk_state() -> None:
    session = _FakeSession()
    repository = HyperliquidRuntimeRepository(session)  # type: ignore[arg-type]
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
    assert risk_state.open_order_markets == frozenset({"hl:perp:cash:cash:AAPL"})
    assert any(
        params and params.get("coin") == "cash:AAPL" for _, params in session.executed
    )


class _FakeRepository:
    def __init__(self, _session: _FakeSession) -> None:
        self.orders: list[tuple[OrderIntent, OrderResult]] = []
        self.performance: list[PerformanceSnapshot] = []

    def upsert_markets(self, markets: list[HyperliquidMarket]) -> None:
        self.markets = markets

    def upsert_fills(self, fills: list[Fill]) -> int:
        self.fills = fills
        return len(fills)

    def risk_state(
        self, *, dependencies: tuple[RuntimeDependencyStatus, ...]
    ) -> RiskState:
        return RiskState(
            gross_exposure_usd=Decimal("0"),
            daily_realized_pnl_usd=Decimal("0"),
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
    def status(self) -> Any:
        return type(
            "Status",
            (),
            {"statuses": (RuntimeDependencyStatus("clickhouse", True),)},
        )()

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
        return [_feature()]


class _FakeExchange:
    def __init__(self) -> None:
        self.submitted: list[OrderIntent] = []

    def reconcile_fills(self, _market_id_by_coin: dict[str, str]) -> list[Fill]:
        return [_fill()]

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus("hyperliquid_exchange_shadow", True)

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        self.submitted.append(intent)
        return OrderResult(status="submitted", exchange_order_id=None, raw_response={})

    def schedule_dead_man_cancel(self, *, seconds_from_now: int) -> None:
        self.dead_man_seconds = seconds_from_now


class _FakeJournal:
    def __init__(self) -> None:
        self.persisted: list[object] = []

    def fill_events(self, fill: Fill) -> list[object]:
        return [("fill", fill.fill_hash)]

    def order_events(self, intent: OrderIntent, _result: OrderResult) -> list[object]:
        return [("order", intent.cloid)]

    def persist_refs(self, _session: _FakeSession, events: list[object]) -> None:
        self.persisted.extend(events)


def test_runtime_service_orchestrates_signal_order_and_accounting(
    monkeypatch: Any,
) -> None:
    repository = _FakeRepository(_FakeSession())
    exchange = _FakeExchange()
    journal = _FakeJournal()
    monkeypatch.setattr(
        service_module, "HyperliquidRuntimeRepository", lambda _session: repository
    )
    service = HyperliquidRuntimeService(
        config=_config(),
        clickhouse=_FakeClickHouse(),  # type: ignore[arg-type]
        exchange=exchange,
        journal=journal,  # type: ignore[arg-type]
    )
    session = _FakeSession()

    result = service.run_once(session)  # type: ignore[arg-type]

    assert session.committed
    assert result.markets_seen == 1
    assert result.signals_written == 1
    assert result.decisions_written == 1
    assert result.orders_submitted == 1
    assert result.blocked_decisions == 0
    assert exchange.submitted[0].side == "buy"
    assert repository.orders[0][0].decision_id == "decision-id"
    assert repository.performance[0].reconciliation_status == "pass"
    assert journal.persisted
