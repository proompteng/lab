"""Regression coverage for testnet crossable-liquidity selection."""

from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange
from app.hyperliquid_execution.models import ExecutionMarket, RuntimeDependencyStatus
from app.hyperliquid_execution.service import HyperliquidExecutionService
from tests.hyperliquid_execution.test_runtime_surfaces import (
    _FakeSession,
    _ServiceExchange,
    _TwoExecutableServiceFeed,
    _now,
)


def test_exchange_filters_uncrossable_testnet_books() -> None:
    sdk = _Sdk()
    sdk.slippage_prices = {
        ("NVDA", True): Decimal("100"),
        ("NVDA", False): Decimal("90"),
        ("MU", True): Decimal("105"),
        ("MU", False): Decimal("95"),
    }
    info = _Info(
        {
            "NVDA": {"levels": [[{"px": "80"}], [{"px": "120"}]]},
            "MU": {"levels": [[{"px": "99"}], [{"px": "101"}]]},
        }
    )
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "50"}
        ),
        sdk=sdk,
        info=info,
    )

    selected, status = exchange.filter_crossable_markets(
        (_market("NVDA", "xyz"), _market("MU", "xyz"))
    )

    assert [market.coin for market in selected] == ["MU"]
    assert status.ready is True
    assert status.details["selected"] == ["MU"]
    assert status.details["skipped"] == {
        "NVDA": "book_not_crossable:bid=80:ask=120:buy_limit=100.0:sell_limit=90.0"
    }


def test_exchange_reports_no_liquidity_markets_without_querying_sdk() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "75"}
        ),
        sdk=_Sdk(),
        info=_Info({}),
    )

    selected, status = exchange.filter_crossable_markets(())

    assert selected == ()
    assert status.ready is False
    assert status.reason == "no_execution_markets"
    assert status.details == {"slippage_bps": "75"}


def test_exchange_reports_unavailable_testnet_book_as_non_crossable() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env({}),
        sdk=_Sdk(),
        info=_Info({}),
    )

    selected, status = exchange.filter_crossable_markets((_market("MISSING", "xyz"),))

    assert selected == ()
    assert status.ready is False
    assert status.reason == "no_crossable_testnet_markets"
    assert status.details["skipped"] == {"MISSING": "book_unavailable:KeyError"}


def test_exchange_reports_malformed_testnet_books_as_empty() -> None:
    coins = ("NOLEVELS", "ONESIDE", "EMPTY", "BADLEVEL")
    sdk = _Sdk()
    for coin in coins:
        sdk.slippage_prices[(coin, True)] = Decimal("100")
        sdk.slippage_prices[(coin, False)] = Decimal("90")
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env({}),
        sdk=sdk,
        info=_Info(
            {
                "NOLEVELS": {},
                "ONESIDE": {"levels": [[{"px": "99"}]]},
                "EMPTY": {"levels": [[], [{"px": "101"}]]},
                "BADLEVEL": {"levels": [[42], [{"px": "101"}]]},
            }
        ),
    )

    selected, status = exchange.filter_crossable_markets(
        tuple(_market(coin, "xyz") for coin in coins)
    )

    assert selected == ()
    assert status.ready is False
    assert status.details["skipped"] == {coin: "book_empty" for coin in coins}


def test_service_skips_uncrossable_testnet_markets_before_signals() -> None:
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
    exchange = _LiquidityExchange(now)
    service = HyperliquidExecutionService(
        config=config,
        feed=_TwoExecutableServiceFeed(now),
        exchange=exchange,
    )

    result = service.run_once(session)

    dependencies = {dependency.name: dependency for dependency in result.dependencies}
    liquidity = dependencies["hyperliquid_testnet_liquidity"]
    assert result.selected_coins == ("MU",)
    assert result.signals_written == 1
    assert result.orders_submitted == 1
    assert exchange.submitted_coins == ["MU"]
    assert liquidity.ready is True
    assert liquidity.details["selected"] == ["MU"]
    assert liquidity.details["skipped"] == {"NVDA": "book_not_crossable"}
    assert result.universe_details["liquidity"]["selected"] == ["MU"]


class _Sdk:
    def __init__(self) -> None:
        self.info: _Info | None = None
        self.slippage_prices: dict[tuple[str, bool], Decimal] = {}

    def _slippage_price(self, name: str, is_buy: bool, _slippage: float) -> float:
        return float(self.slippage_prices[(name, is_buy)])


class _Info:
    def __init__(self, books: dict[str, dict[str, object]]) -> None:
        self._books = books

    def l2_snapshot(self, name: str) -> dict[str, object]:
        return self._books[name]


class _Exchange(HyperliquidSdkExecutionExchange):
    def __init__(
        self,
        config: HyperliquidExecutionConfig,
        *,
        sdk: _Sdk,
        info: _Info,
    ) -> None:
        super().__init__(config)
        self._sdk = sdk
        self._book_info = info
        self._sdk.info = self._book_info

    def _exchange(self) -> _Sdk:
        return self._sdk


class _LiquidityExchange(_ServiceExchange):
    def filter_crossable_markets(
        self,
        markets: tuple[ExecutionMarket, ...],
    ) -> tuple[tuple[ExecutionMarket, ...], RuntimeDependencyStatus]:
        selected = tuple(market for market in markets if market.coin == "MU")
        skipped = {
            market.coin: "book_not_crossable"
            for market in markets
            if market.coin != "MU"
        }
        return selected, RuntimeDependencyStatus(
            "hyperliquid_testnet_liquidity",
            bool(selected),
            details={
                "selected": [market.coin for market in selected],
                "skipped": skipped,
            },
        )


def _market(coin: str, dex: str) -> ExecutionMarket:
    return ExecutionMarket(
        market_id=f"hl:perp:{dex}:{coin}",
        coin=coin,
        dex=dex,
        network="mainnet",
        day_notional_volume_usd=Decimal("1000"),
    )
