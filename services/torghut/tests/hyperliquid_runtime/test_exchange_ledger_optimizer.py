from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.exchange import (
    ShadowHyperliquidExchange,
    exchange_from_config,
)
from app.hyperliquid_runtime.ledger import HyperliquidTigerBeetleJournal
from app.hyperliquid_runtime.models import Fill, OrderIntent, OrderResult
from app.hyperliquid_runtime.optimizer import (
    OptimizerCandidate,
    evaluate_optimizer_candidate,
)


def test_exchange_from_invalid_enabled_config_reports_unavailable() -> None:
    config = HyperliquidRuntimeConfig.from_env(
        {"HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true"}
    )
    exchange = exchange_from_config(config)
    status = exchange.dependency_status()

    assert not status.ready
    assert "account_address_required_when_trading_enabled" in str(status.reason)


def test_shadow_exchange_never_requires_private_keys() -> None:
    exchange = ShadowHyperliquidExchange()
    result = exchange.submit_ioc_limit(
        OrderIntent(
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
    )

    assert result.status == "submitted"
    assert result.raw_response == {"shadow": True}


def test_tigerbeetle_journal_transfer_ids_are_deterministic() -> None:
    journal = HyperliquidTigerBeetleJournal(cluster_id=2001)
    intent = OrderIntent(
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
    events = journal.order_events(
        intent, OrderResult(status="submitted", exchange_order_id=None, raw_response={})
    )

    first = journal.transfer_spec(events[0])
    second = journal.transfer_spec(events[0])

    assert first.transfer_id == second.transfer_id
    assert first.amount == 20_000_000


def test_fill_events_include_fee_and_realized_pnl() -> None:
    journal = HyperliquidTigerBeetleJournal(cluster_id=2001)
    fill = Fill(
        market_id="hl:perp:cash:cash:AAPL",
        coin="cash:AAPL",
        side="buy",
        price=Decimal("200"),
        size=Decimal("0.1"),
        notional_usd=Decimal("20"),
        fee_usd=Decimal("0.02"),
        closed_pnl_usd=Decimal("-0.50"),
        exchange_order_id="10",
        fill_hash="fill-hash",
        event_ts=datetime(2026, 6, 18, tzinfo=timezone.utc),
        raw_payload={},
    )

    assert [event.transfer_kind for event in journal.fill_events(fill)] == [
        "fill_notional",
        "fee",
        "realized_pnl",
    ]


def test_optimizer_requires_all_promotion_gates() -> None:
    config = HyperliquidRuntimeConfig.from_env({})
    rejected = evaluate_optimizer_candidate(
        OptimizerCandidate(
            parameter_version="candidate",
            trade_count=2,
            net_pnl_usd=Decimal("-1"),
            max_drawdown_usd=Decimal("50"),
            reconciliation_gap_count=1,
            stale_period_count=1,
            payload={},
        ),
        config,
    )
    promoted = evaluate_optimizer_candidate(
        OptimizerCandidate(
            parameter_version="candidate",
            trade_count=100,
            net_pnl_usd=Decimal("5"),
            max_drawdown_usd=Decimal("2"),
            reconciliation_gap_count=0,
            stale_period_count=0,
            payload={},
        ),
        config,
    )

    assert not rejected.promoted
    assert set(rejected.reasons) == {
        "insufficient_trades",
        "net_pnl_below_gate",
        "drawdown_above_gate",
        "reconciliation_gaps",
        "stale_data_periods",
    }
    assert promoted.promoted
