from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.exchange import (
    ShadowHyperliquidExchange,
    _account_state_from_payload,
    exchange_from_config,
)
from app.hyperliquid_runtime.ledger import (
    HyperliquidJournalEvent,
    HyperliquidTigerBeetleJournal,
)
from app.hyperliquid_runtime.models import Fill, OrderIntent, OrderResult
from app.hyperliquid_runtime.optimizer import (
    OptimizerCandidate,
    evaluate_optimizer_candidate,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient


def test_exchange_from_invalid_enabled_config_reports_unavailable() -> None:
    config = HyperliquidRuntimeConfig.from_env(
        {"HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true"}
    )
    exchange = exchange_from_config(config)
    status = exchange.dependency_status()

    assert not status.ready
    assert "account_address_required_when_trading_enabled" in str(status.reason)


def test_trading_config_requires_tigerbeetle_accounting() -> None:
    config = HyperliquidRuntimeConfig.from_env(
        {
            "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true",
            "HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS": "0xabc",
            "HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY": "0xdef",
        }
    )

    assert {
        "tigerbeetle_enabled_required_when_trading_enabled",
        "tigerbeetle_journal_enabled_required_when_trading_enabled",
        "tigerbeetle_required_when_trading_enabled",
    }.issubset(set(config.validation_errors()))


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

    assert result.status == "rejected"
    assert result.rejection_reason == "trading_disabled_shadow"
    assert result.raw_response == {
        "shadow": True,
        "reason": "trading_disabled_shadow",
    }


def test_user_state_payload_materializes_account_and_positions() -> None:
    observed_at = datetime(2026, 6, 18, tzinfo=timezone.utc)
    state = _account_state_from_payload(
        {
            "marginSummary": {
                "accountValue": "1000.5",
                "totalNtlPos": "25.5",
            },
            "withdrawable": "900.25",
            "assetPositions": [
                {
                    "position": {
                        "coin": "SPX",
                        "szi": "0.01",
                        "entryPx": "6000",
                        "positionValue": "60",
                        "unrealizedPnl": "1.25",
                    }
                },
                {
                    "position": {
                        "coin": "MSFT",
                        "szi": "-0.02",
                        "entryPx": "500",
                        "unrealizedPnl": "-0.50",
                    }
                },
            ],
        },
        {"SPX": "hl:perp:default:SPX", "MSFT": "hl:perp:default:MSFT"},
        observed_at,
    )

    assert state.account.account_value_usd == Decimal("1000.5")
    assert state.account.withdrawable_usd == Decimal("900.25")
    assert state.account.gross_exposure_usd == Decimal("25.5")
    assert len(state.positions) == 2
    assert state.positions[0].market_id == "hl:perp:default:SPX"
    assert state.positions[0].coin == "SPX"
    assert state.positions[0].size == Decimal("0.01")
    assert state.positions[0].entry_price == Decimal("6000")
    assert state.positions[0].notional_usd == Decimal("60")
    assert state.positions[0].unrealized_pnl_usd == Decimal("1.25")
    assert state.positions[1].market_id == "hl:perp:default:MSFT"
    assert state.positions[1].notional_usd == Decimal("10.00")
    assert state.positions[1].unrealized_pnl_usd == Decimal("-0.50")


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


def test_tigerbeetle_journal_writes_fake_client_and_persists_status() -> None:
    client = FakeTigerBeetleClient()
    journal = HyperliquidTigerBeetleJournal(
        cluster_id=2001,
        enabled=True,
        required=True,
        journal_enabled=True,
        client=client,
    )
    session = _JournalSession()
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

    assert journal.dependency_status().ready
    count = journal.persist_refs(
        session,
        journal.order_events(
            intent,
            OrderResult(status="submitted", exchange_order_id=None, raw_response={}),
        ),
    )
    repeat_session = _JournalSession()
    repeat_count = journal.persist_refs(
        repeat_session,
        journal.order_events(
            intent,
            OrderResult(status="submitted", exchange_order_id=None, raw_response={}),
        ),
    )

    assert count == 1
    assert repeat_count == 1
    assert len(client.accounts) == 2
    assert len(client.transfers) == 1
    assert session.executed[0]["status"] == "created"
    assert repeat_session.executed[0]["status"] == "exists"


def test_tigerbeetle_required_journal_raises_when_write_fails() -> None:
    journal = HyperliquidTigerBeetleJournal(
        cluster_id=2001,
        enabled=True,
        required=True,
        journal_enabled=True,
        client=_FailingTigerBeetleClient(),
    )
    event = HyperliquidJournalEvent(
        source_id="source",
        transfer_kind="submitted_hold",
        amount_usd=Decimal("1"),
        debit_account_key="testnet:1001:testnet-cash",
        credit_account_key="testnet:1101:hl:perp:default:SPX",
        transfer_code=2000,
    )

    with pytest.raises(RuntimeError, match="down"):
        journal.persist_refs(_JournalSession(), [event])


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


class _JournalSession:
    def __init__(self) -> None:
        self.executed: list[dict[str, object]] = []

    def execute(
        self, _statement: object, params: dict[str, object] | None = None
    ) -> None:
        self.executed.append(params or {})


class _FailingTigerBeetleClient(FakeTigerBeetleClient):
    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]:
        del accounts
        raise RuntimeError("down")
