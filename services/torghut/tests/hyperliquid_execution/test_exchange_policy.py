"""Fake exchange tests for order submission behavior."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast

import pytest
from sqlalchemy.orm import Session

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange
from app.hyperliquid_execution.models import (
    ExecutionMarket,
    OpenOrder,
    OrderIntent,
    OrderResult,
)
from app.hyperliquid_execution.reconciliation_keys import (
    market_id_by_reconciliation_coin,
)
from app.hyperliquid_execution.reduction_mutations import (
    HyperliquidReductionMutationExecutor,
)
from tests.broker_mutation_test_support import (
    PassthroughBrokerMutationCoordinator,
    hyperliquid_broker_mutation_test_permit,
)


def _submit(exchange: _FakeExchange, intent: OrderIntent) -> OrderResult:
    return exchange.submit_order(
        intent,
        mutation_permit=hyperliquid_broker_mutation_test_permit(exchange, intent),
    )


def _reduction_executor(
    exchange: _FakeExchange,
) -> HyperliquidReductionMutationExecutor:
    return HyperliquidReductionMutationExecutor(
        exchange=exchange,
        session=cast(Session, object()),
        coordinator=PassthroughBrokerMutationCoordinator(),
        account_label=exchange.account_label,
        endpoint_url=exchange.broker_endpoint_url,
    )


def _order_status_payload(
    *,
    oid: int = 123,
    cloid: str = "0xabc",
    coin: str = "NVDA",
    status: str = "open",
) -> dict[str, object]:
    return {
        "status": "order",
        "order": {
            "order": {
                "cloid": cloid,
                "coin": coin,
                "limitPx": "100",
                "oid": oid,
                "side": "B",
                "sz": "1",
            },
            "status": status,
        },
    }


def test_exchange_filters_metadata_reconciles_account_and_tracks_halts() -> None:
    sdk = _FakeSdk()
    info = _FakeInfo()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=sdk,
        info=info,
    )
    markets = (
        _market("NVDA", "xyz"),
        _market("OLD", "xyz"),
        _market("HALT", "xyz"),
    )

    selected, status = exchange.filter_supported_markets(markets)
    assert [market.coin for market in selected] == ["NVDA", "HALT"]
    assert selected[0].max_leverage == Decimal("20")
    assert selected[0].payload["execution_max_leverage"] == "20"
    assert status.ready is True
    assert "OLD" in status.details["delisted"]
    assert status.details["max_leverage_by_coin"]["NVDA"] == "20"

    halted_intent = _intent("HALT")
    sdk.next_order_response = {
        "response": {"data": {"statuses": [{"error": "Trading is halted."}]}}
    }
    halted = _submit(exchange, halted_intent)
    assert halted.status == "rejected"

    selected_after_halt, status_after_halt = exchange.filter_supported_markets(markets)
    assert [market.coin for market in selected_after_halt] == ["NVDA"]
    assert "HALT" in status_after_halt.details["halted"]

    fills = exchange.reconcile_fills({"NVDA": "hl:perp:xyz:NVDA"})
    account = exchange.reconcile_account({"NVDA": "hl:perp:xyz:NVDA"})
    open_coins = exchange.reconcile_open_order_coins(frozenset({"NVDA"}))
    dependency = exchange.dependency_status()

    assert fills[0].notional_usd == Decimal("10.000000")
    assert account.account.gross_exposure_usd == Decimal("30.000000")
    assert [position.coin for position in account.positions] == ["NVDA"]
    assert open_coins == frozenset({"NVDA"})
    assert dependency.ready is True
    assert exchange.execution_metadata_details()


def test_exchange_reconciles_unified_account_spot_and_perp_dex_state() -> None:
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=_FakeSdk(),
        info=_UnifiedAccountInfo(),
    )
    exchange.filter_supported_markets((_market("AMD", "xyz"),))

    account = exchange.reconcile_account({"AMD": "hl:perp:xyz:AMD"})

    assert account.account.account_value_usd == Decimal("997.945380")
    assert account.account.withdrawable_usd == Decimal("987.602738")
    assert account.account.gross_exposure_usd == Decimal("10.024656")
    assert [position.coin for position in account.positions] == ["AMD"]
    assert "spotUserState" in account.account.raw_payload
    assert "xyz" in account.account.raw_payload["dexStates"]


def test_exchange_canonicalizes_scoped_reconciliation_rows() -> None:
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=_FakeSdk(),
        info=_ScopedReconciliationInfo(),
    )
    market = _market("NVDA", "xyz")
    exchange.filter_supported_markets((market,))
    market_id_by_coin = market_id_by_reconciliation_coin((market,))

    fills = exchange.reconcile_fills(market_id_by_coin)
    account = exchange.reconcile_account(market_id_by_coin)

    assert fills[0].market_id == "hl:perp:xyz:NVDA"
    assert fills[0].coin == "NVDA"
    assert fills[0].raw_payload["coin"] == "xyz:NVDA"
    assert account.positions[0].market_id == "hl:perp:xyz:NVDA"
    assert account.positions[0].coin == "NVDA"
    assert account.positions[0].sdk_coin == "xyz:NVDA"
    assert account.positions[0].raw_payload["coin"] == "xyz:NVDA"


def test_exchange_reconciles_spot_state_fallback_paths() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
        }
    )

    failing_spot = _FakeExchange(config, sdk=_FakeSdk(), info=_FailingSpotInfo())
    failing_spot.filter_supported_markets((_market("AMD", "xyz"),))
    failing_account = failing_spot.reconcile_account({"AMD": "hl:perp:xyz:AMD"})

    malformed_spot = _FakeExchange(config, sdk=_FakeSdk(), info=_MalformedSpotInfo())
    malformed_spot.filter_supported_markets((_market("AMD", "xyz"),))
    malformed_account = malformed_spot.reconcile_account({"AMD": "hl:perp:xyz:AMD"})

    missing_balances = _FakeExchange(
        config, sdk=_FakeSdk(), info=_MissingSpotBalancesInfo()
    )
    missing_balances.filter_supported_markets((_market("AMD", "xyz"),))
    missing_balance_account = missing_balances.reconcile_account(
        {"AMD": "hl:perp:xyz:AMD"}
    )

    assert failing_account.account.account_value_usd == Decimal("10.342642")
    assert failing_account.account.withdrawable_usd == Decimal("0.102402")
    assert failing_account.account.raw_payload["spotUserState"] == {}
    assert malformed_account.account.account_value_usd == Decimal("13.500000")
    assert malformed_account.account.withdrawable_usd == Decimal("10.250000")
    assert missing_balance_account.account.account_value_usd == Decimal("10.342642")
    assert missing_balance_account.account.withdrawable_usd == Decimal("0.102402")


def test_exchange_rejects_unsupported_tif_and_recovers_cancel_id_from_broker() -> None:
    sdk = _FakeSdk()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc"}
        ),
        sdk=sdk,
    )

    unsupported_tif = _submit(exchange, _intent("NVDA", tif="Alo"))
    missing_key = _submit(exchange, _intent("NVDA", tif="Ioc"))
    local_cancel = _reduction_executor(exchange).cancel_order(
        OpenOrder(
            order_id="order",
            coin="NVDA",
            dex="xyz",
            exchange_order_id=None,
            cloid="0xabc",
            status="accepted",
            expires_at=datetime.now(timezone.utc),
        )
    )

    assert unsupported_tif.rejection_reason == "unsupported_limit_tif"
    assert missing_key.rejection_reason == "api_wallet_private_key_missing"
    assert local_cancel.status == "cancelled"
    assert local_cancel.exchange_order_id == "123"
    assert sdk.cancels == [("xyz:NVDA", 123)]


def test_fenced_reduce_only_close_uses_sdk_market_close() -> None:
    sdk = _FakeSdk()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_API_WALLET_PRIVATE_KEY": "0x1",
                "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc",
            }
        ),
        sdk=sdk,
    )
    exchange.filter_supported_markets((_market("NVDA", "xyz"),))

    default_result = _reduction_executor(exchange).close_position_reduce_only(
        "NVDA",
        size=Decimal("0.1"),
        slippage=Decimal("0.02"),
        expected_signed_quantity=Decimal("0.1"),
    )
    scoped_exchange = _FakeExchange(
        exchange._config,
        sdk=sdk,
        info=_ScopedReconciliationInfo(),
    )
    scoped_exchange.filter_supported_markets((_market("NVDA", "xyz"),))
    scoped_result = _reduction_executor(scoped_exchange).close_position_reduce_only(
        "xyz:NVDA",
        size=Decimal("0.1"),
        slippage=Decimal("0.02"),
        expected_signed_quantity=Decimal("0.1"),
    )
    with pytest.raises(ValueError, match="broker_symbol_changed"):
        _reduction_executor(scoped_exchange).close_position_reduce_only(
            "XYZ:NVDA",
            size=Decimal("0.1"),
            expected_signed_quantity=Decimal("0.1"),
        )

    assert default_result.status == "filled"
    assert scoped_result.status == "filled"
    assert sdk.market_closes == [
        ("NVDA", 0.1, 0.02),
        ("xyz:NVDA", 0.1, 0.02),
    ]


@pytest.mark.parametrize(
    ("size", "slippage", "reason"),
    [
        (Decimal("-0.1"), Decimal("0.05"), "close_size_invalid"),
        (Decimal("0.1"), Decimal("-0.01"), "close_slippage_invalid"),
        (Decimal("0.1"), Decimal("1"), "close_slippage_invalid"),
    ],
)
def test_reduce_only_close_rejects_invalid_size_and_slippage(
    size: Decimal,
    slippage: Decimal,
    reason: str,
) -> None:
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc"}
        ),
        sdk=_FakeSdk(),
    )

    with pytest.raises(ValueError, match=reason):
        _reduction_executor(exchange).close_position_reduce_only(
            "NVDA",
            size=size,
            slippage=slippage,
        )


def test_reduction_observation_reads_every_authoritative_perp_dex() -> None:
    info = _CompleteDexInfo()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc"}
        ),
        sdk=_FakeSdk(),
        info=info,
    )

    _observed_at, positions = exchange.observe_reduction_positions()

    assert info.state_reads == ["", "xyz", "hedge"]
    assert {position.symbol for position in positions} == {
        "BTC",
        "HEDGE:AMD",
        "NVDA",
    }


def test_open_order_observation_binds_exact_broker_identity() -> None:
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc"}
        ),
        sdk=_FakeSdk(),
        info=_FakeInfo(),
    )
    order = _open_order()

    observed = exchange.observe_open_order(order)

    assert observed is not None
    assert observed.order_id == "123"
    assert observed.client_order_id == "0xabc"
    assert observed.symbol == "NVDA"


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (["not-a-row"], "order_status_invalid"),
        ({"status": "unexpected"}, "order_status_invalid"),
        ({"status": "order", "order": "bad"}, "order_status_payload_invalid"),
        (
            _order_status_payload(oid=456),
            "open_order_id_mismatch",
        ),
        (
            _order_status_payload(cloid="wrong"),
            "open_order_cloid_mismatch",
        ),
        (
            _order_status_payload(coin="AMD"),
            "open_order_coin_mismatch",
        ),
    ],
)
def test_open_order_observation_rejects_incomplete_or_mismatched_payload(
    payload: object,
    reason: str,
) -> None:
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc"}
        ),
        sdk=_FakeSdk(),
        info=_OpenOrdersPayloadInfo(payload),
    )

    with pytest.raises(ValueError, match=reason):
        exchange.observe_open_order(_open_order())


@pytest.mark.parametrize(
    ("info_factory", "reason"),
    [
        (lambda: _MalformedPerpDexInfo(), "perp_dex_catalog_invalid"),
        (lambda: _MalformedPositionInfo(), "asset_positions_invalid"),
    ],
)
def test_reduction_observation_rejects_incomplete_broker_shapes(
    info_factory: Callable[[], _FakeInfo],
    reason: str,
) -> None:
    info = info_factory()
    exchange = _FakeExchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0xabc"}
        ),
        sdk=_FakeSdk(),
        info=info,
    )

    with pytest.raises(ValueError, match=reason):
        exchange.observe_reduction_positions()


class _FakeSdkInfo:
    def __init__(self) -> None:
        self.name_to_coin: dict[str, object] = {
            "NVDA": 0,
            "HALT": 1,
            "AMD": 2,
            "SPX": 3,
        }
        self.coin_to_asset: dict[object, int] = {
            0: 110000,
            1: 110001,
            2: 110002,
            3: 110003,
        }


class _FakeSdk:
    def __init__(self) -> None:
        self.info = _FakeSdkInfo()
        self.market_opens: list[dict[str, object]] = []
        self.cancels: list[tuple[str, int]] = []
        self.market_closes: list[tuple[str, float | None, float]] = []
        self.next_order_response: dict[str, object] = {
            "response": {"data": {"statuses": [{"resting": {"oid": 123}}]}}
        }

    def market_open(self, **kwargs: object) -> dict[str, object]:
        self.info.name_to_coin[str(kwargs["name"])]
        self.market_opens.append(dict(kwargs))
        return self.next_order_response

    def cancel(self, name: str, oid: int) -> dict[str, object]:
        self.info.name_to_coin[name]
        self.cancels.append((name, oid))
        return {"status": "ok"}

    def market_close(
        self,
        coin: str,
        *,
        sz: float | None = None,
        slippage: float = 0.05,
    ) -> dict[str, object]:
        self.info.name_to_coin[coin]
        self.market_closes.append((coin, sz, slippage))
        return {"response": {"data": {"statuses": [{"filled": {"oid": 789}}]}}}


class _FakeInfo:
    def perp_dexs(self) -> list[object]:
        return [None, {"name": "xyz"}]

    def meta(self, *, dex: str = "") -> dict[str, object]:
        if dex == "xyz":
            return {
                "universe": [
                    {"name": "NVDA", "szDecimals": 2, "maxLeverage": 20},
                    {"name": "OLD", "isDelisted": True, "szDecimals": 2},
                    {"name": "HALT", "szDecimals": 2, "maxLeverage": 10},
                ]
            }
        return {"universe": [{"name": "BTC", "szDecimals": 3, "maxLeverage": 40}]}

    def user_fills(self, _account: str) -> list[dict[str, object]]:
        return [
            {
                "coin": "NVDA",
                "px": "100",
                "sz": "0.1",
                "fee": "0.01",
                "closedPnl": "0.50",
                "oid": "123",
                "hash": "fill-1",
                "side": "B",
                "time": "1781870400000",
            },
            {"coin": "BTC", "px": "100", "sz": "1"},
        ]

    def user_state(self, _account: str, dex: str = "") -> dict[str, object]:
        if dex == "xyz":
            return {
                "marginSummary": {
                    "accountValue": "1000",
                    "totalNtlPos": "20",
                },
                "withdrawable": "900",
                "assetPositions": [
                    {
                        "position": {
                            "coin": "NVDA",
                            "szi": "0.1",
                            "entryPx": "100",
                            "positionValue": "20",
                            "unrealizedPnl": "0.25",
                        }
                    },
                    {"position": {"coin": "BTC", "szi": "1", "entryPx": "10"}},
                ],
            }
        return {
            "marginSummary": {"accountValue": "0", "totalNtlPos": "0"},
            "withdrawable": "0",
            "assetPositions": [],
        }

    def spot_user_state(self, _account: str) -> dict[str, object]:
        return {"balances": [], "tokenToAvailableAfterMaintenance": []}

    def open_orders(self, _account: str, *, dex: str = "") -> list[dict[str, object]]:
        if dex == "xyz":
            return [
                {
                    "cloid": "0xabc",
                    "coin": "NVDA",
                    "oid": 123,
                    "side": "B",
                    "sz": "1",
                }
            ]
        return [{"coin": "BTC"}]

    def query_order_by_oid(self, _account: str, oid: int) -> dict[str, object]:
        assert oid == 123
        return _order_status_payload()

    def query_order_by_cloid(
        self,
        _account: str,
        _cloid: object,
    ) -> dict[str, object]:
        return _order_status_payload()


class _CompleteDexInfo(_FakeInfo):
    def __init__(self) -> None:
        self.state_reads: list[str] = []

    def perp_dexs(self) -> list[object]:
        return [None, {"name": "xyz"}, {"name": "hedge"}]

    def user_state(self, account: str, dex: str = "") -> dict[str, object]:
        self.state_reads.append(dex)
        if dex == "hedge":
            return {
                "assetPositions": [
                    {
                        "position": {
                            "coin": "hedge:AMD",
                            "positionValue": "50",
                            "szi": "-0.5",
                        }
                    }
                ]
            }
        return super().user_state(account, dex=dex)


class _MalformedPerpDexInfo(_FakeInfo):
    def perp_dexs(self) -> list[object]:
        return [{"name": "missing-core-marker"}]


class _MalformedPositionInfo(_FakeInfo):
    def user_state(self, _account: str, dex: str = "") -> dict[str, object]:
        return {"assetPositions": "not-a-list"}


class _OpenOrdersPayloadInfo(_FakeInfo):
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def open_orders(self, _account: str, *, dex: str = "") -> list[dict[str, object]]:
        del dex
        return cast(list[dict[str, object]], self.payload)

    def query_order_by_oid(self, _account: str, _oid: int) -> object:
        return self.payload

    def query_order_by_cloid(self, _account: str, _cloid: object) -> object:
        return self.payload


class _UnifiedAccountInfo(_FakeInfo):
    def meta(self, *, dex: str = "") -> dict[str, object]:
        if dex == "xyz":
            return {"universe": [{"name": "AMD", "szDecimals": 3, "maxLeverage": 20}]}
        return {"universe": []}

    def user_state(self, _account: str, dex: str = "") -> dict[str, object]:
        if dex == "xyz":
            return {
                "marginSummary": {
                    "accountValue": "10.342642",
                    "totalNtlPos": "10.024656",
                },
                "withdrawable": "0.102402",
                "assetPositions": [
                    {
                        "position": {
                            "coin": "AMD",
                            "szi": "0.0186",
                            "entryPx": "538.96",
                            "positionValue": "10.024656",
                            "unrealizedPnl": "0",
                        }
                    }
                ],
            }
        return {
            "marginSummary": {
                "accountValue": "0",
                "totalNtlPos": "0",
            },
            "withdrawable": "0",
            "assetPositions": [],
        }

    def spot_user_state(self, _account: str) -> dict[str, object]:
        return {
            "balances": [
                {
                    "coin": "USDC",
                    "token": 0,
                    "total": "997.94538",
                    "hold": "10.342642",
                }
            ],
            "tokenToAvailableAfterMaintenance": [[0, "987.602738"]],
        }


class _ScopedReconciliationInfo(_FakeInfo):
    def user_fills(self, _account: str) -> list[dict[str, object]]:
        return [
            {
                "coin": "xyz:NVDA",
                "px": "100",
                "sz": "0.1",
                "fee": "0.01",
                "closedPnl": "0.50",
                "oid": "123",
                "hash": "fill-1",
                "side": "B",
                "time": "1781870400000",
            }
        ]

    def user_state(self, _account: str, dex: str = "") -> dict[str, object]:
        if dex == "xyz":
            return {
                "marginSummary": {
                    "accountValue": "1000",
                    "totalNtlPos": "20",
                },
                "withdrawable": "900",
                "assetPositions": [
                    {
                        "position": {
                            "coin": "xyz:NVDA",
                            "szi": "0.1",
                            "entryPx": "100",
                            "positionValue": "20",
                            "unrealizedPnl": "0.25",
                        }
                    }
                ],
            }
        return {
            "marginSummary": {
                "accountValue": "0",
                "totalNtlPos": "0",
            },
            "withdrawable": "0",
            "assetPositions": [],
        }


class _FailingSpotInfo(_UnifiedAccountInfo):
    def spot_user_state(self, _account: str) -> dict[str, object]:
        raise RuntimeError("spot_down")


class _MalformedSpotInfo(_UnifiedAccountInfo):
    def spot_user_state(self, _account: str) -> dict[str, object]:
        return {
            "balances": [
                "bad-balance-row",
                {"coin": "BTC", "total": "100", "hold": "0"},
                {"coin": "USDC", "total": "13.5", "hold": "3.25"},
            ],
            "tokenToAvailableAfterMaintenance": [
                "bad-available-row",
                [0],
                [1, "99"],
            ],
        }


class _MissingSpotBalancesInfo(_UnifiedAccountInfo):
    def spot_user_state(self, _account: str) -> dict[str, object]:
        return {"balances": "not-a-list", "tokenToAvailableAfterMaintenance": []}


class _FakeExchange(HyperliquidSdkExecutionExchange):
    def __init__(
        self,
        config: HyperliquidExecutionConfig,
        *,
        sdk: _FakeSdk,
        info: _FakeInfo | None = None,
    ) -> None:
        super().__init__(config)
        self._sdk = sdk
        self._fake_info = info or _FakeInfo()

    def _exchange(self) -> _FakeSdk:
        return self._sdk

    def _info(self) -> _FakeInfo:
        return self._fake_info

    def _cloid(self, raw: str) -> str:
        return raw


def _intent(coin: str, *, tif: str = "Ioc") -> OrderIntent:
    return OrderIntent(
        market_id=f"hl:perp:xyz:{coin}",
        coin=coin,
        dex="xyz",
        side="buy",
        size=Decimal("0.1234"),
        limit_price=Decimal("100.1234567"),
        notional_usd=Decimal("12.34"),
        cloid="0xabc",
        tif=tif,
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=45),
    )


def _open_order() -> OpenOrder:
    return OpenOrder(
        order_id="123",
        coin="NVDA",
        dex="xyz",
        exchange_order_id="123",
        cloid="0xabc",
        status="accepted",
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=45),
    )


def _market(coin: str, dex: str) -> ExecutionMarket:
    return ExecutionMarket(
        market_id=f"hl:perp:{dex}:{coin}",
        coin=coin,
        dex=dex,
        network="mainnet",
        day_notional_volume_usd=Decimal("1000"),
    )
