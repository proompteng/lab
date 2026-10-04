from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Never, cast

from pytest import MonkeyPatch, raises
from sqlalchemy.exc import SQLAlchemyError

from app.hyperliquid_execution import api
from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.feed_reader import FeedStatus
from app.hyperliquid_execution.models import (
    AccountSnapshot,
    AccountState,
    ExecutionMarket,
    FeatureSnapshot,
    Fill,
    RuntimeDependencyStatus,
)
from app.hyperliquid_execution.metrics import HyperliquidExecutionMetrics
from app.hyperliquid_execution.repository import HyperliquidExecutionRepository
from app.hyperliquid_execution.service import HyperliquidExecutionService


def test_dependency_reads_finish_before_cycle_database_transaction() -> None:
    events: list[str] = []
    observed_at = datetime(2026, 7, 11, 22, 0, tzinfo=timezone.utc)
    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_TRADE_COINS": "BTC"}
    )
    service = HyperliquidExecutionService(
        config=config,
        feed=_RecordingFeed(events, observed_at),
        exchange=_RecordingExchange(events, observed_at),
    )
    repository = _RecordingRepository(events)

    context = service._load_context(  # pylint: disable=protected-access
        cast(HyperliquidExecutionRepository, repository),
        observed_at,
    )

    first_database_call = next(
        index for index, event in enumerate(events) if event.startswith("db:")
    )
    assert events[:first_database_call] == [
        "external:feed_status",
        "external:catalog",
        "external:execution_metadata",
        "external:liquidity",
        "external:features",
        "external:fills",
        "external:account",
        "external:open_orders",
        "external:exchange_status",
        "external:execution_details",
    ]
    assert events[first_database_call:] == [
        "db:markets",
        "db:fills",
        "db:account",
    ]
    assert context.markets[0].coin == "BTC"
    assert context.dependencies[-2].name == "hyperliquid_open_orders"
    assert context.dependencies[-1].name == "hyperliquid_exchange"


def test_cycle_failure_truth_survives_broken_connection_cleanup(
    monkeypatch: MonkeyPatch,
) -> None:
    session = _RollbackFailingSession()
    old_service = api.runtime_state.service
    old_error = api.runtime_state.latest_error
    old_metrics = api.runtime_state.metrics
    try:
        api.runtime_state.service = _FailingCycleService()
        api.runtime_state.latest_error = None
        api.runtime_state.metrics = HyperliquidExecutionMetrics()
        monkeypatch.setattr(api, "SessionLocal", lambda: session)

        with raises(TimeoutError, match="clickhouse timed out"):
            api._run_one_cycle()  # pylint: disable=protected-access

        assert api.runtime_state.latest_error == "TimeoutError:clickhouse timed out"
        assert session.rollback_calls == 1
        assert session.close_calls == 1
        assert session.closed
        assert (
            'torghut_hyperliquid_execution_errors_total{error="TimeoutError"} 1'
            in api.runtime_state.metrics.render("torghut_hyperliquid_execution")
        )
    finally:
        api.runtime_state.service = old_service
        api.runtime_state.latest_error = old_error
        api.runtime_state.metrics = old_metrics


class _RecordingRepository:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def upsert_markets(self, _markets: object) -> int:
        self._events.append("db:markets")
        return 1

    def upsert_fills(self, _fills: object) -> int:
        self._events.append("db:fills")
        return 0

    def upsert_account_state(self, _state: object) -> None:
        self._events.append("db:account")


class _FailingCycleService:
    def run_once(self, _session: object) -> Never:
        raise TimeoutError("clickhouse timed out")


class _RollbackFailingSession:
    def __init__(self) -> None:
        self.rollback_calls = 0
        self.close_calls = 0
        self.closed = False

    def rollback(self) -> None:
        self.rollback_calls += 1
        raise SQLAlchemyError("connection was terminated")

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True
        raise SQLAlchemyError("connection close failed")


class _RecordingFeed:
    def __init__(self, events: list[str], observed_at: datetime) -> None:
        self._events = events
        self._observed_at = observed_at

    def status(self) -> FeedStatus:
        self._events.append("external:feed_status")
        return FeedStatus(
            True,
            (RuntimeDependencyStatus("feed", True, observed_at=self._observed_at),),
        )

    def load_catalog_rows(self) -> list[dict[str, object]]:
        self._events.append("external:catalog")
        return [
            {
                "market_id": "hl:perp:default:BTC",
                "coin": "BTC",
                "dex": "default",
                "network": "mainnet",
                "market_type": "perp",
                "dayNtlVlm": "1000000",
            }
        ]

    def load_feature_rows(self, _market_ids: list[str]) -> list[FeatureSnapshot]:
        self._events.append("external:features")
        return [
            FeatureSnapshot(
                market_id="hl:perp:default:BTC",
                coin="BTC",
                dex="default",
                event_ts=self._observed_at,
                price=Decimal("50000"),
                momentum_5m_bps=Decimal("5"),
                spread_bps=Decimal("1"),
                liquidity_usd=Decimal("1000000"),
                volatility_bps=Decimal("10"),
                book_imbalance=Decimal("0"),
                source_lag_seconds=1,
            )
        ]


class _RecordingExchange:
    def __init__(self, events: list[str], observed_at: datetime) -> None:
        self._events = events
        self._observed_at = observed_at

    def filter_supported_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        self._events.append("external:execution_metadata")
        return markets, RuntimeDependencyStatus("metadata", True)

    def filter_crossable_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        self._events.append("external:liquidity")
        return markets, RuntimeDependencyStatus("liquidity", True)

    def reconcile_fills(self, _market_id_by_coin: dict[str, str]) -> list[Fill]:
        self._events.append("external:fills")
        return []

    def reconcile_account(self, _market_id_by_coin: dict[str, str]) -> AccountState:
        self._events.append("external:account")
        return AccountState(
            account=AccountSnapshot(
                observed_at=self._observed_at,
                account_value_usd=Decimal("0"),
                withdrawable_usd=Decimal("0"),
                gross_exposure_usd=Decimal("0"),
                raw_payload={},
            ),
            positions=(),
        )

    def reconcile_open_order_coins(self, _coins: frozenset[str]) -> frozenset[str]:
        self._events.append("external:open_orders")
        return frozenset()

    def dependency_status(self) -> RuntimeDependencyStatus:
        self._events.append("external:exchange_status")
        return RuntimeDependencyStatus(
            "hyperliquid_exchange", True, observed_at=self._observed_at
        )

    def execution_metadata_details(self) -> dict[str, object]:
        self._events.append("external:execution_details")
        return {}
