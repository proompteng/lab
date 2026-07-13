"""Regression coverage for testnet crossable-liquidity selection."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal, cast

import pytest
from pytest import MonkeyPatch

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import HyperliquidSdkExecutionExchange
from app.hyperliquid_execution.models import (
    ExecutionMarket,
    OrderIntent,
    RuntimeDependencyStatus,
)
from app.hyperliquid_execution.service import HyperliquidExecutionService
from tests.hyperliquid_execution.test_runtime_surfaces import (
    _FakeSession,
    _ServiceExchange,
    _TwoExecutableServiceFeed,
    _now,
)


def test_exchange_filters_uncrossable_testnet_books() -> None:
    sdk = _Sdk()
    info = _Info(
        {
            "xyz:NVDA": {"levels": [[{"px": "80"}], [{"px": "120"}]]},
            "xyz:MU": {"levels": [[{"px": "99"}], [{"px": "101"}]]},
        },
        mids={"NVDA": "100", "MU": "100"},
    )
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "200"}
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
        "NVDA": "book_not_crossable:sides=buy:bid=80:ask=120:buy_limit=102.0:sell_limit=98.0"
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
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env({}),
        sdk=sdk,
        info=_Info(
            {
                "xyz:NOLEVELS": {},
                "xyz:ONESIDE": {"levels": [[{"px": "99"}]]},
                "xyz:EMPTY": {"levels": [[], [{"px": "101"}]]},
                "xyz:BADLEVEL": {"levels": [[42], [{"px": "101"}]]},
            }
        ),
    )

    selected, status = exchange.filter_crossable_markets(
        tuple(_market(coin, "xyz") for coin in coins)
    )

    assert selected == ()
    assert status.ready is False
    assert status.details["skipped"] == {coin: "book_empty" for coin in coins}


def test_exchange_keeps_long_crossable_market_when_sell_side_is_not_crossable() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "200"}
        ),
        sdk=_Sdk(),
        info=_Info(
            {"xyz:NVDA": {"levels": [[{"px": "97"}], [{"px": "101"}]]}},
            mids={"NVDA": "100"},
        ),
    )

    selected, status = exchange.filter_crossable_markets((_market("NVDA", "xyz"),))

    assert [market.coin for market in selected] == ["NVDA"]
    assert status.ready is True
    assert status.details["skipped"] == {}
    assert exchange._book_info.mid_dexes == ["xyz"]


def test_exchange_applies_sdk_price_rounding_before_selecting_market() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "0"}
        ),
        sdk=_Sdk(),
        info=_Info(
            {"xyz:NVDA": {"levels": [[{"px": "100"}], [{"px": "100.004"}]]}},
            mids={"NVDA": "100.004"},
        ),
    )

    selected, status = exchange.filter_crossable_markets((_market("NVDA", "xyz"),))

    assert selected == ()
    assert status.ready is False
    assert status.details["skipped"] == {
        "NVDA": "book_not_crossable:sides=buy:bid=100:ask=100.004:buy_limit=100.0:sell_limit=100.0"
    }


def test_exchange_keeps_sell_crossable_market_when_short_entries_are_enabled() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true",
                "HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "200",
            }
        ),
        sdk=_Sdk(),
        info=_Info(
            {"xyz:NVDA": {"levels": [[{"px": "99"}], [{"px": "103"}]]}},
            mids={"NVDA": "100"},
        ),
    )

    selected, status = exchange.filter_crossable_markets((_market("NVDA", "xyz"),))

    assert [market.coin for market in selected] == ["NVDA"]
    assert status.ready is True
    assert status.details["skipped"] == {}


def test_exchange_validates_the_generated_order_side_before_submission() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {
                "HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true",
                "HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "200",
            }
        ),
        sdk=_Sdk(),
        info=_Info(
            {"xyz:NVDA": {"levels": [[{"px": "99"}], [{"px": "103"}]]}},
            mids={"NVDA": "100"},
        ),
    )

    with pytest.raises(ValueError, match="order_not_crossable:buy"):
        exchange.validate_order_intent_crossability(
            _intent(side="buy", limit_price="102")
        )
    exchange.validate_order_intent_crossability(_intent(side="sell", limit_price="98"))


def test_exchange_fails_closed_on_malformed_pre_submit_price() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env({}),
        sdk=_Sdk(),
        info=_Info(
            {"xyz:NVDA": {"levels": [[{"px": "not-a-number"}], [{"px": "103"}]]}}
        ),
    )

    with pytest.raises(ValueError, match="order_book_unavailable:InvalidOperation"):
        exchange.validate_order_intent_crossability(
            _intent(side="buy", limit_price="102")
        )


def test_exchange_fails_closed_on_non_mapping_pre_submit_book() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env({}),
        sdk=_Sdk(),
        info=_MalformedBookInfo([{"px": "99"}]),
    )

    with pytest.raises(ValueError, match="order_book_unavailable:AttributeError"):
        exchange.validate_order_intent_crossability(
            _intent(side="buy", limit_price="102")
        )


def test_exchange_reports_mid_lookup_failure_as_unavailable_liquidity() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "200"}
        ),
        sdk=_Sdk(),
        info=_FailingMidInfo(
            {"xyz:NVDA": {"levels": [[{"px": "99"}], [{"px": "101"}]]}}
        ),
    )

    selected, status = exchange.filter_crossable_markets((_market("NVDA", "xyz"),))

    assert selected == ()
    assert status.ready is False
    assert status.details["skipped"] == {"NVDA": "book_unavailable:RuntimeError"}


def test_exchange_reports_malformed_mid_as_unavailable_liquidity() -> None:
    exchange = _Exchange(
        HyperliquidExecutionConfig.from_env({}),
        sdk=_Sdk(),
        info=_Info(
            {"xyz:NVDA": {"levels": [[{"px": "99"}], [{"px": "101"}]]}},
            mids={"NVDA": "not-a-number"},
        ),
    )

    selected, status = exchange.filter_crossable_markets((_market("NVDA", "xyz"),))

    assert selected == ()
    assert status.ready is False
    assert status.details["skipped"] == {"NVDA": "book_unavailable:InvalidOperation"}


def test_exchange_info_client_reloads_with_known_builder_dexes(
    monkeypatch: MonkeyPatch,
) -> None:
    constructed_dexes: list[tuple[str, ...]] = []
    constructed_timeouts: list[float] = []

    class _FakeInfo:
        def __init__(
            self,
            _base_url: str,
            *,
            skip_ws: bool,
            perp_dexs: list[str],
            timeout: float,
        ) -> None:
            assert skip_ws is True
            constructed_dexes.append(tuple(perp_dexs))
            constructed_timeouts.append(timeout)

    class _FakeInfoModule:
        Info = _FakeInfo

    def fake_import_module(name: str) -> type[_FakeInfoModule]:
        assert name == "hyperliquid.info"
        return _FakeInfoModule

    monkeypatch.setattr(
        "app.hyperliquid_execution.exchange.importlib.import_module",
        fake_import_module,
    )
    exchange = HyperliquidSdkExecutionExchange(HyperliquidExecutionConfig.from_env({}))

    exchange._info()
    exchange._active_by_dex = {"xyz": frozenset({"NVDA"})}
    exchange._info()
    exchange._info()

    assert constructed_dexes == [("",), ("", "xyz")]
    assert constructed_timeouts == [120.0, 120.0]


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
    def __init__(
        self,
        books: dict[str, dict[str, object]],
        *,
        mids: dict[str, object] | None = None,
    ) -> None:
        self._books = books
        self._mids = mids or {}
        self.mid_dexes: list[str] = []
        metadata_names = [coin.split(":", 1)[-1] for coin in books]
        self.name_to_coin = {coin: coin for coin in metadata_names}
        self.coin_to_asset = {coin: index for index, coin in enumerate(metadata_names)}
        self.asset_to_sz_decimals = {
            index: 2 for index, _coin in enumerate(metadata_names)
        }

    def l2_snapshot(self, name: str) -> dict[str, object]:
        self.name_to_coin[name]
        return self._books[name]

    def __getattr__(self, name: str) -> object:
        if name == "all" + "_mids":
            return self._load_mids
        raise AttributeError(name)

    def _load_mids(self, *, dex: str = "") -> dict[str, object]:
        self.mid_dexes.append(dex)
        return self._mids


class _FailingMidInfo(_Info):
    def _load_mids(self, *, dex: str = "") -> dict[str, object]:
        self.mid_dexes.append(dex)
        raise RuntimeError("mid_lookup_failed")


class _MalformedBookInfo(_Info):
    def __init__(self, book: object) -> None:
        super().__init__({"xyz:NVDA": {}})
        self._book = book

    def l2_snapshot(self, name: str) -> dict[str, object]:
        self.name_to_coin[name]
        return cast(dict[str, object], self._book)


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
        raise AssertionError("liquidity checks must use read-only info")

    def _info(self) -> _Info:
        return self._book_info


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


def _intent(*, side: Literal["buy", "sell"], limit_price: str) -> OrderIntent:
    return OrderIntent(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        side=side,
        size=Decimal("0.1"),
        limit_price=Decimal(limit_price),
        notional_usd=Decimal(limit_price) / Decimal("10"),
        cloid="0xabc",
        tif="Ioc",
        reduce_only=False,
        signal_id="signal",
        expires_at=datetime.now(timezone.utc),
    )
