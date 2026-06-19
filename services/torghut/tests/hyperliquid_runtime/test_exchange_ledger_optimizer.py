from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.exchange import (
    HyperliquidSdkExchange,
    ShadowHyperliquidExchange,
    _ExecutionMarketMetadata,
    _account_state_from_payload,
    exchange_from_config,
)
from app.hyperliquid_runtime.ledger import (
    HyperliquidJournalEvent,
    HyperliquidTigerBeetleJournal,
)
from app.hyperliquid_runtime.models import (
    Fill,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
)
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


def test_sdk_exchange_normalizes_perp_price_and_size_precision() -> None:
    config = HyperliquidRuntimeConfig.from_env(
        {
            "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true",
            "HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS": "0x1111111111111111111111111111111111111111",
            "HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY": (
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
            "TORGHUT_TIGERBEETLE_ENABLED": "true",
            "TORGHUT_TIGERBEETLE_REQUIRED": "true",
            "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED": "true",
        }
    )
    exchange = HyperliquidSdkExchange(config)
    exchange._sz_decimals_by_dex_coin = {"xyz": {"xyz:SMSN": 1}}
    intent = OrderIntent(
        market_id="hl:perp:xyz:xyz:SMSN",
        coin="xyz:SMSN",
        dex="xyz",
        side="sell",
        size=Decimal("0.141976"),
        limit_price=Decimal("176.080123"),
        notional_usd=Decimal("24.992235"),
        cloid="0x1234567890abcdef1234567890abcdef",
        reduce_only=False,
        decision_id="decision",
    )

    normalized = exchange.normalize_order_intent(intent)

    assert normalized.limit_price == Decimal("176.09")
    assert normalized.size == Decimal("0.1")
    assert normalized.notional_usd == Decimal("17.609000")


def test_sdk_exchange_filters_delisted_testnet_execution_markets() -> None:
    exchange = HyperliquidSdkExchange(_trading_config())
    exchange._sdk_info = _FakeInfo(
        {
            "xyz": {
                "universe": [
                    {
                        "name": "xyz:AVGO",
                        "isDelisted": True,
                        "szDecimals": 2,
                        "maxLeverage": 10,
                    },
                    {
                        "name": "xyz:NVDA",
                        "szDecimals": 3,
                        "maxLeverage": 20,
                    },
                    {
                        "name": "xyz:TSLA",
                        "isDelisted": "false",
                        "szDecimals": 3,
                        "maxLeverage": 10,
                    },
                ]
            }
        }
    )
    markets = (
        _market("xyz:AVGO"),
        _market("xyz:NVDA"),
        _market("xyz:TSLA"),
    )

    supported, status = exchange.filter_supported_markets(markets)

    assert [market.coin for market in supported] == ["xyz:NVDA", "xyz:TSLA"]
    assert status.ready
    assert status.details == {
        "requested": 3,
        "active": 2,
        "delisted": 1,
        "halted_cooldown": 0,
        "missing": 0,
    }
    assert exchange._sz_decimals_by_dex_coin["xyz"] == {
        "xyz:NVDA": 3,
        "xyz:TSLA": 3,
    }


def test_sdk_exchange_prepares_isolated_and_cross_markets_once() -> None:
    exchange = HyperliquidSdkExchange(_trading_config())
    exchange._execution_universe_by_dex = {"xyz": frozenset({"xyz:CRCL", "xyz:NVDA"})}
    exchange._metadata_by_dex_coin = {
        "xyz": {
            "xyz:CRCL": exchange_module_metadata(
                sz_decimals=3,
                only_isolated=True,
                margin_mode="noCross",
                max_leverage=10,
            ),
            "xyz:NVDA": exchange_module_metadata(
                sz_decimals=3,
                only_isolated=False,
                margin_mode="",
                max_leverage=20,
            ),
        }
    }
    sdk = _FakeSdkExchange()
    exchange._sdk_exchange = sdk
    exchange._sdk_exchange_perp_dexs = ("", "xyz")

    assert exchange.prepare_order_market(_intent(coin="xyz:CRCL", dex="xyz")) is None
    assert exchange.prepare_order_market(_intent(coin="xyz:CRCL", dex="xyz")) is None
    assert exchange.prepare_order_market(_intent(coin="xyz:NVDA", dex="xyz")) is None

    assert sdk.leverage_updates == [
        {"leverage": 1, "name": "xyz:CRCL", "is_cross": False},
        {"leverage": 1, "name": "xyz:NVDA", "is_cross": True},
    ]


def test_sdk_exchange_cools_down_halted_markets_after_exchange_reject() -> None:
    exchange = HyperliquidSdkExchange(_trading_config())
    exchange._last_execution_universe_at = datetime.now(timezone.utc)
    exchange._execution_universe_by_dex = {"xyz": frozenset({"xyz:NVDA"})}
    exchange._sz_decimals_by_dex_coin = {"xyz": {"xyz:NVDA": 3}}
    exchange._metadata_by_dex_coin = {
        "xyz": {
            "xyz:NVDA": exchange_module_metadata(
                sz_decimals=3,
                only_isolated=False,
                margin_mode="",
                max_leverage=20,
            )
        }
    }
    sdk = _FakeSdkExchange(
        order_response={
            "status": "ok",
            "response": {
                "type": "order",
                "data": {"statuses": [{"error": "Trading is halted."}]},
            },
        }
    )
    exchange._sdk_exchange = sdk
    exchange._sdk_exchange_perp_dexs = ("", "xyz")

    result = exchange.submit_ioc_limit(_intent(coin="xyz:NVDA", dex="xyz"))
    supported, status = exchange.filter_supported_markets((_market("xyz:NVDA"),))

    assert result.status == "rejected"
    assert result.rejection_reason == "Trading is halted."
    assert supported == ()
    assert not status.ready
    assert status.details["halted_cooldown"] == 1


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


def _trading_config() -> HyperliquidRuntimeConfig:
    return HyperliquidRuntimeConfig.from_env(
        {
            "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true",
            "HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS": "0x1111111111111111111111111111111111111111",
            "HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY": (
                "0x2222222222222222222222222222222222222222222222222222222222222222"
            ),
            "TORGHUT_TIGERBEETLE_ENABLED": "true",
            "TORGHUT_TIGERBEETLE_REQUIRED": "true",
            "TORGHUT_TIGERBEETLE_JOURNAL_ENABLED": "true",
        }
    )


def _market(coin: str, *, dex: str = "xyz") -> HyperliquidMarket:
    return HyperliquidMarket(
        market_id=f"hl:perp:{dex}:{coin}",
        coin=coin,
        dex=dex,
        asset_class="stocks",
        network="mainnet",
        day_notional_volume_usd=Decimal("1000000"),
        mark_price=Decimal("200"),
        mid_price=Decimal("200"),
        open_interest_usd=Decimal("1000000"),
        max_leverage=10,
    )


def _intent(*, coin: str = "xyz:NVDA", dex: str = "xyz") -> OrderIntent:
    return OrderIntent(
        market_id=f"hl:perp:{dex}:{coin}",
        coin=coin,
        dex=dex,
        side="buy",
        size=Decimal("0.1"),
        limit_price=Decimal("200"),
        notional_usd=Decimal("20"),
        cloid="0x1234567890abcdef1234567890abcdef",
        reduce_only=False,
        decision_id="decision",
    )


def exchange_module_metadata(
    *,
    sz_decimals: int,
    only_isolated: bool,
    margin_mode: str,
    max_leverage: int,
) -> _ExecutionMarketMetadata:
    return _ExecutionMarketMetadata(
        sz_decimals=sz_decimals,
        only_isolated=only_isolated,
        margin_mode=margin_mode,
        max_leverage=max_leverage,
    )


class _FakeInfo:
    def __init__(self, metas_by_dex: dict[str, dict[str, object]]) -> None:
        self._metas_by_dex = metas_by_dex

    def meta(self, dex: str = "") -> dict[str, object]:
        return self._metas_by_dex[dex]


class _FakeSdkExchange:
    def __init__(self, *, order_response: dict[str, object] | None = None) -> None:
        self.leverage_updates: list[dict[str, object]] = []
        self.order_response = order_response or {
            "status": "ok",
            "response": {
                "type": "order",
                "data": {"statuses": [{"resting": {"oid": 123}}]},
            },
        }

    def update_leverage(
        self, leverage: int, name: str, is_cross: bool
    ) -> dict[str, str]:
        self.leverage_updates.append(
            {"leverage": leverage, "name": name, "is_cross": is_cross}
        )
        return {"status": "ok"}

    def order(self, **_kwargs: object) -> dict[str, object]:
        return self.order_response


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
