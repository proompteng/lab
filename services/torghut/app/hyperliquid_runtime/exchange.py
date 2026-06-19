"""Hyperliquid testnet exchange adapter."""

from __future__ import annotations

import importlib
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP
from typing import Any, Mapping, Protocol, cast

from .config import HyperliquidRuntimeConfig
from .models import (
    AccountSnapshot,
    AccountState,
    Fill,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
    OrderStatus,
    PositionSnapshot,
    RuntimeDependencyStatus,
)


_EXECUTION_UNIVERSE_REFRESH_SECONDS = 300


class HyperliquidExchange(Protocol):
    """Minimal exchange surface used by the runtime service."""

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        """Return an exchange-compliant order intent."""
        ...

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        """Submit an IOC limit order."""
        ...

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        """Read current account fills from the dedicated testnet account."""
        ...

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        """Read current account and position state from the dedicated testnet account."""
        ...

    def reconcile_open_order_market_ids(
        self, market_id_by_coin: dict[str, str]
    ) -> frozenset[str]:
        """Read market ids with currently open exchange orders."""
        ...

    def filter_supported_markets(
        self,
        markets: tuple[HyperliquidMarket, ...],
    ) -> tuple[tuple[HyperliquidMarket, ...], RuntimeDependencyStatus]:
        """Return markets currently supported by the execution venue."""
        ...

    def dependency_status(self) -> RuntimeDependencyStatus:
        """Return exchange readiness."""
        ...

    def schedule_dead_man_cancel(self, *, seconds_from_now: int) -> None:
        """Arm Hyperliquid scheduled cancel protection."""
        ...


class ShadowHyperliquidExchange:
    """No-order exchange used when testnet trading is not enabled."""

    def __init__(self) -> None:
        self._observed_at = datetime.now(timezone.utc)

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        return intent

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        _ = intent
        return OrderResult(
            status="rejected",
            exchange_order_id=None,
            raw_response={"shadow": True, "reason": "trading_disabled_shadow"},
            rejection_reason="trading_disabled_shadow",
        )

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        _ = market_id_by_coin
        self._observed_at = datetime.now(timezone.utc)
        return []

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        _ = market_id_by_coin
        self._observed_at = datetime.now(timezone.utc)
        return AccountState(
            account=AccountSnapshot(
                observed_at=self._observed_at,
                account_value_usd=Decimal("0"),
                withdrawable_usd=Decimal("0"),
                gross_exposure_usd=Decimal("0"),
                raw_payload={"shadow": True},
            ),
            positions=(),
        )

    def reconcile_open_order_market_ids(
        self, market_id_by_coin: dict[str, str]
    ) -> frozenset[str]:
        _ = market_id_by_coin
        self._observed_at = datetime.now(timezone.utc)
        return frozenset()

    def filter_supported_markets(
        self,
        markets: tuple[HyperliquidMarket, ...],
    ) -> tuple[tuple[HyperliquidMarket, ...], RuntimeDependencyStatus]:
        self._observed_at = datetime.now(timezone.utc)
        return (
            markets,
            RuntimeDependencyStatus(
                name="hyperliquid_execution_universe_shadow",
                ready=True,
                observed_at=self._observed_at,
                lag_seconds=0,
            ),
        )

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus(
            name="hyperliquid_exchange_shadow",
            ready=True,
            observed_at=self._observed_at,
            lag_seconds=0,
        )

    def schedule_dead_man_cancel(self, *, seconds_from_now: int) -> None:
        _ = seconds_from_now
        self._observed_at = datetime.now(timezone.utc)


class UnavailableHyperliquidExchange:
    """Exchange adapter that reports NotReady for invalid execution config."""

    def __init__(self, reasons: list[str]) -> None:
        self._reasons = tuple(reasons)

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        return intent

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        _ = intent
        raise RuntimeError(
            f"hyperliquid_exchange_unavailable:{','.join(self._reasons)}"
        )

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        _ = market_id_by_coin
        return []

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        _ = market_id_by_coin
        observed_at = datetime.now(timezone.utc)
        return AccountState(
            account=AccountSnapshot(
                observed_at=observed_at,
                account_value_usd=Decimal("0"),
                withdrawable_usd=Decimal("0"),
                gross_exposure_usd=Decimal("0"),
                raw_payload={"unavailable": True, "reasons": list(self._reasons)},
            ),
            positions=(),
        )

    def reconcile_open_order_market_ids(
        self, market_id_by_coin: dict[str, str]
    ) -> frozenset[str]:
        _ = market_id_by_coin
        raise RuntimeError(
            f"hyperliquid_exchange_unavailable:{','.join(self._reasons)}"
        )

    def filter_supported_markets(
        self,
        markets: tuple[HyperliquidMarket, ...],
    ) -> tuple[tuple[HyperliquidMarket, ...], RuntimeDependencyStatus]:
        _ = markets
        return (
            (),
            RuntimeDependencyStatus(
                name="hyperliquid_execution_universe",
                ready=False,
                reason=",".join(self._reasons),
            ),
        )

    def dependency_status(self) -> RuntimeDependencyStatus:
        return RuntimeDependencyStatus(
            name="hyperliquid_exchange",
            ready=False,
            reason=",".join(self._reasons),
        )

    def schedule_dead_man_cancel(self, *, seconds_from_now: int) -> None:
        _ = seconds_from_now


class HyperliquidSdkExchange:
    """Official Python SDK adapter for testnet execution only."""

    def __init__(self, config: HyperliquidRuntimeConfig) -> None:
        errors = config.validation_errors()
        if errors:
            raise ValueError(f"invalid_hyperliquid_runtime_config:{','.join(errors)}")
        if not config.account_address or not config.api_wallet_private_key:
            raise ValueError("hyperliquid_testnet_account_secret_required")
        self._config = config
        self._sdk_exchange: Any | None = None
        self._sdk_exchange_perp_dexs: tuple[str, ...] | None = None
        self._sdk_info: Any | None = None
        self._last_exchange_read_at: datetime | None = None
        self._last_execution_universe_at: datetime | None = None
        self._execution_universe_by_dex: dict[str, frozenset[str]] = {}
        self._sz_decimals_by_dex_coin: dict[str, dict[str, int]] = {}

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent:
        sz_decimals = self._sz_decimals_by_dex_coin.get(_sdk_dex(intent.dex), {}).get(
            intent.coin
        )
        if sz_decimals is None:
            return intent
        price = _normalize_hyperliquid_perp_price(
            intent.limit_price,
            sz_decimals=sz_decimals,
            side=intent.side,
        )
        size = _normalize_hyperliquid_size(
            intent.size,
            sz_decimals=sz_decimals,
        )
        if size <= Decimal("0"):
            raise ValueError("order_size_below_exchange_precision")
        return replace(
            intent,
            size=size,
            limit_price=price,
            notional_usd=(price * size).quantize(Decimal("0.000001")),
        )

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        intent = self.normalize_order_intent(intent)
        exchange = self._exchange()
        cloid = self._cloid(intent.cloid)
        response = cast(
            dict[str, object],
            exchange.order(
                name=intent.coin,
                is_buy=intent.side == "buy",
                sz=float(intent.size),
                limit_px=float(intent.limit_price),
                order_type={"limit": {"tif": "Ioc"}},
                reduce_only=intent.reduce_only,
                cloid=cloid,
            ),
        )
        self._last_exchange_read_at = datetime.now(timezone.utc)
        return _order_result(response)

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        info = self._info()
        account = self._config.account_address
        if account is None:
            return []
        raw_fills = cast(list[dict[str, object]], info.user_fills(account))
        self._last_exchange_read_at = datetime.now(timezone.utc)
        return [
            _fill_from_payload(fill, market_id_by_coin)
            for fill in raw_fills
            if _fill_coin(fill) in market_id_by_coin
        ]

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        info = self._info()
        account = self._config.account_address
        observed_at = datetime.now(timezone.utc)
        if account is None:
            return AccountState(
                account=AccountSnapshot(
                    observed_at=observed_at,
                    account_value_usd=Decimal("0"),
                    withdrawable_usd=Decimal("0"),
                    gross_exposure_usd=Decimal("0"),
                    raw_payload={"missing_account": True},
                ),
                positions=(),
            )
        raw_state = cast(dict[str, object], info.user_state(account))
        self._last_exchange_read_at = observed_at
        return _account_state_from_payload(raw_state, market_id_by_coin, observed_at)

    def reconcile_open_order_market_ids(
        self, market_id_by_coin: dict[str, str]
    ) -> frozenset[str]:
        info = self._info()
        account = self._config.account_address
        if account is None:
            return frozenset()
        open_market_ids: set[str] = set()
        for dex in _open_order_dexes(market_id_by_coin):
            raw_orders = cast(
                list[dict[str, object]], info.open_orders(account, dex=dex)
            )
            for raw_order in raw_orders:
                market_id = market_id_by_coin.get(_open_order_coin(raw_order))
                if market_id:
                    open_market_ids.add(market_id)
        self._last_exchange_read_at = datetime.now(timezone.utc)
        return frozenset(open_market_ids)

    def filter_supported_markets(
        self,
        markets: tuple[HyperliquidMarket, ...],
    ) -> tuple[tuple[HyperliquidMarket, ...], RuntimeDependencyStatus]:
        if not markets:
            return (
                (),
                RuntimeDependencyStatus(
                    name="hyperliquid_execution_universe",
                    ready=True,
                    observed_at=datetime.now(timezone.utc),
                    lag_seconds=0,
                ),
            )
        try:
            self._refresh_execution_universe(markets)
        except Exception as exc:
            if not self._execution_universe_cache_is_fresh():
                return (
                    (),
                    RuntimeDependencyStatus(
                        name="hyperliquid_execution_universe",
                        ready=False,
                        reason=f"execution_market_metadata_unavailable:{type(exc).__name__}",
                    ),
                )
        supported = tuple(
            market
            for market in markets
            if market.coin
            in self._execution_universe_by_dex.get(_sdk_dex(market.dex), frozenset())
        )
        observed_at = self._last_execution_universe_at
        lag_seconds = (
            int((datetime.now(timezone.utc) - observed_at).total_seconds())
            if observed_at is not None
            else None
        )
        ready = bool(supported)
        return (
            supported,
            RuntimeDependencyStatus(
                name="hyperliquid_execution_universe",
                ready=ready,
                observed_at=observed_at,
                lag_seconds=lag_seconds,
                reason=None if ready else "no_execution_supported_markets",
            ),
        )

    def dependency_status(self) -> RuntimeDependencyStatus:
        if self._last_exchange_read_at is None:
            return RuntimeDependencyStatus(
                "hyperliquid_exchange", False, reason="exchange_not_read"
            )
        lag_seconds = int(
            (datetime.now(timezone.utc) - self._last_exchange_read_at).total_seconds()
        )
        ready = lag_seconds <= self._config.exchange_staleness_seconds
        return RuntimeDependencyStatus(
            name="hyperliquid_exchange",
            ready=ready,
            observed_at=self._last_exchange_read_at,
            lag_seconds=lag_seconds,
            reason=None if ready else "exchange_stale",
        )

    def schedule_dead_man_cancel(self, *, seconds_from_now: int) -> None:
        cancel_at_ms = int(
            (datetime.now(timezone.utc).timestamp() + seconds_from_now) * 1000
        )
        self._exchange().schedule_cancel(cancel_at_ms)
        self._last_exchange_read_at = datetime.now(timezone.utc)

    def _exchange(self) -> Any:
        perp_dexs = self._supported_perp_dexs()
        if self._sdk_exchange is None or self._sdk_exchange_perp_dexs != perp_dexs:
            eth_account = importlib.import_module("eth_account")
            exchange_module = importlib.import_module("hyperliquid.exchange")
            wallet = eth_account.Account.from_key(self._config.api_wallet_private_key)
            exchange_cls = getattr(exchange_module, "Exchange")
            self._sdk_exchange = exchange_cls(
                wallet,
                base_url=self._config.exchange_api_url,
                account_address=self._config.account_address,
                perp_dexs=list(perp_dexs),
                timeout=float(self._config.exchange_staleness_seconds),
            )
            self._sdk_exchange_perp_dexs = perp_dexs
        return self._sdk_exchange

    def _supported_perp_dexs(self) -> tuple[str, ...]:
        dexes = {
            dex
            for dex, coins in self._execution_universe_by_dex.items()
            if dex == "" or coins
        }
        dexes.add("")
        return tuple(sorted(dexes))

    def _info(self) -> Any:
        if self._sdk_info is None:
            info_module = importlib.import_module("hyperliquid.info")
            info_cls = getattr(info_module, "Info")
            self._sdk_info = info_cls(self._config.exchange_api_url, skip_ws=True)
        return self._sdk_info

    def _cloid(self, raw: str) -> Any:
        types_module = importlib.import_module("hyperliquid.utils.types")
        cloid_cls = getattr(types_module, "Cloid", None)
        if cloid_cls is None:
            return raw
        from_str = getattr(cloid_cls, "from_str", None)
        if from_str is None:
            return raw
        return from_str(raw)

    def _refresh_execution_universe(
        self,
        markets: tuple[HyperliquidMarket, ...],
    ) -> None:
        if self._execution_universe_cache_is_fresh():
            return
        by_dex: dict[str, frozenset[str]] = {}
        sz_decimals_by_dex_coin: dict[str, dict[str, int]] = {}
        loaded_any_metadata = False
        for dex in _execution_metadata_dexes(
            markets,
            execution_network=self._config.execution_network,
        ):
            try:
                meta: object = self._info().meta(dex=dex)
            except Exception:
                if dex:
                    by_dex[dex] = frozenset()
                    continue
                raise
            universe: object = (
                cast(Mapping[str, object], meta).get("universe")
                if isinstance(meta, dict)
                else None
            )
            coins: set[str] = set()
            sz_decimals_by_coin: dict[str, int] = {}
            if isinstance(universe, list):
                for asset in cast(list[object], universe):
                    if not isinstance(asset, dict):
                        continue
                    asset_map = cast(Mapping[str, object], asset)
                    name = str(asset_map.get("name") or "").strip()
                    if name:
                        coins.add(name)
                        sz_decimals = _optional_int(asset_map.get("szDecimals"))
                        if sz_decimals is not None and sz_decimals >= 0:
                            sz_decimals_by_coin[name] = sz_decimals
            by_dex[dex] = frozenset(coins)
            sz_decimals_by_dex_coin[dex] = sz_decimals_by_coin
            loaded_any_metadata = True
        if not loaded_any_metadata:
            self._execution_universe_by_dex = by_dex
            self._sz_decimals_by_dex_coin = sz_decimals_by_dex_coin
            return
        observed_at = datetime.now(timezone.utc)
        self._execution_universe_by_dex = by_dex
        self._sz_decimals_by_dex_coin = sz_decimals_by_dex_coin
        self._last_execution_universe_at = observed_at
        self._last_exchange_read_at = observed_at

    def _execution_universe_cache_is_fresh(self) -> bool:
        if self._last_execution_universe_at is None:
            return False
        max_age_seconds = min(
            _EXECUTION_UNIVERSE_REFRESH_SECONDS,
            max(1, self._config.exchange_staleness_seconds),
        )
        age_seconds = (
            datetime.now(timezone.utc) - self._last_execution_universe_at
        ).total_seconds()
        return age_seconds <= max_age_seconds


def exchange_from_config(config: HyperliquidRuntimeConfig) -> HyperliquidExchange:
    if config.trading_enabled:
        errors = config.validation_errors()
        if errors:
            return UnavailableHyperliquidExchange(errors)
        return HyperliquidSdkExchange(config)
    return ShadowHyperliquidExchange()


def _order_result(response: dict[str, object]) -> OrderResult:
    statuses = response.get("response")
    status: OrderStatus = "submitted"
    exchange_order_id: str | None = None
    rejection_reason: str | None = None
    if isinstance(statuses, dict):
        data = cast(dict[str, object], statuses).get("data")
        if isinstance(data, dict):
            order_statuses = cast(dict[str, object], data).get("statuses")
            if isinstance(order_statuses, list) and order_statuses:
                order_statuses_list = cast(list[object], order_statuses)
                first = order_statuses_list[0]
                if isinstance(first, dict):
                    status, exchange_order_id, rejection_reason = _parse_sdk_status(
                        cast(dict[str, object], first)
                    )
    return OrderResult(
        status=status,
        exchange_order_id=exchange_order_id,
        raw_response=response,
        rejection_reason=rejection_reason,
    )


def _parse_sdk_status(
    status_payload: dict[str, object],
) -> tuple[OrderStatus, str | None, str | None]:
    if "error" in status_payload:
        return "rejected", None, str(status_payload["error"])
    for status_name in ("resting", "filled"):
        value = status_payload.get(status_name)
        if isinstance(value, dict):
            oid = cast(dict[str, object], value).get("oid")
            return (
                ("accepted" if status_name == "resting" else "filled"),
                (str(oid) if oid is not None else None),
                None,
            )
    return "unknown", None, None


def _fill_from_payload(
    payload: dict[str, object],
    market_id_by_coin: dict[str, str],
) -> Fill:
    coin = _fill_coin(payload)
    side = "buy" if str(payload.get("side", "")).upper() == "B" else "sell"
    price = _decimal(payload.get("px"))
    size = _decimal(payload.get("sz"))
    fee = _decimal(payload.get("fee"))
    return Fill(
        market_id=market_id_by_coin[coin],
        coin=coin,
        side=side,
        price=price,
        size=size,
        notional_usd=(price * size).copy_abs(),
        fee_usd=fee.copy_abs(),
        closed_pnl_usd=_decimal(payload.get("closedPnl")),
        exchange_order_id=str(payload.get("oid"))
        if payload.get("oid") is not None
        else None,
        fill_hash=str(payload.get("hash") or ""),
        event_ts=_from_ms(payload.get("time")),
        raw_payload=payload,
    )


def _fill_coin(payload: dict[str, object]) -> str:
    return str(payload.get("coin") or "").strip()


def _open_order_coin(payload: dict[str, object]) -> str:
    return str(payload.get("coin") or "").strip()


def _account_state_from_payload(
    payload: dict[str, object],
    market_id_by_coin: dict[str, str],
    observed_at: datetime,
) -> AccountState:
    margin_summary = _mapping(payload.get("marginSummary"))
    raw_positions = payload.get("assetPositions")
    positions: list[PositionSnapshot] = []
    if isinstance(raw_positions, list):
        for raw_position in cast(list[object], raw_positions):
            if not isinstance(raw_position, dict):
                continue
            raw_position_map = cast(dict[str, object], raw_position)
            position_payload = (
                _mapping(raw_position_map.get("position")) or raw_position_map
            )
            coin = str(position_payload.get("coin") or "").strip()
            market_id = market_id_by_coin.get(coin)
            if not market_id:
                continue
            size = _decimal(position_payload.get("szi"))
            entry_price = _optional_decimal(position_payload.get("entryPx"))
            position_value = _position_notional(position_payload, size, entry_price)
            positions.append(
                PositionSnapshot(
                    market_id=market_id,
                    coin=coin,
                    size=size,
                    entry_price=entry_price,
                    notional_usd=position_value.copy_abs(),
                    unrealized_pnl_usd=_decimal(position_payload.get("unrealizedPnl")),
                    observed_at=observed_at,
                    raw_payload=raw_position_map,
                )
            )
    gross_exposure_usd = _decimal(margin_summary.get("totalNtlPos"))
    if gross_exposure_usd == Decimal("0"):
        gross_exposure_usd = sum(
            (position.notional_usd for position in positions), Decimal("0")
        )
    return AccountState(
        account=AccountSnapshot(
            observed_at=observed_at,
            account_value_usd=_decimal(margin_summary.get("accountValue")),
            withdrawable_usd=_decimal(payload.get("withdrawable")),
            gross_exposure_usd=gross_exposure_usd.copy_abs(),
            raw_payload=payload,
        ),
        positions=tuple(positions),
    )


def _mapping(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return cast(dict[str, object], value)
    return {}


def _sdk_dex(dex: str) -> str:
    cleaned = dex.strip()
    if cleaned in {"", "default"}:
        return ""
    return cleaned


def _execution_metadata_dexes(
    markets: tuple[HyperliquidMarket, ...],
    *,
    execution_network: str,
) -> tuple[str, ...]:
    dexes = {_sdk_dex(market.dex) for market in markets}
    _ = execution_network
    return tuple(sorted(dexes))


def _open_order_dexes(market_id_by_coin: dict[str, str]) -> tuple[str, ...]:
    dexes = {_coin_dex(coin) for coin in market_id_by_coin}
    dexes.add("")
    return tuple(sorted(dexes))


def _coin_dex(coin: str) -> str:
    prefix, separator, _suffix = coin.partition(":")
    if not separator:
        return ""
    return prefix.strip()


def _normalize_hyperliquid_perp_price(
    price: Decimal,
    *,
    sz_decimals: int,
    side: str,
) -> Decimal:
    if price <= Decimal("0"):
        raise ValueError("order_price_must_be_positive")
    # Hyperliquid perp prices are capped at 5 significant figures and
    # at most 6 - szDecimals fractional digits.
    decimal_places = min(
        max(0, 6 - sz_decimals),
        _decimal_places_for_significant_figures(price, significant_figures=5),
    )
    quantum = Decimal("1").scaleb(-decimal_places)
    rounding = ROUND_DOWN if side == "buy" else ROUND_UP
    normalized = price.quantize(quantum, rounding=rounding)
    if normalized <= Decimal("0"):
        return price.quantize(quantum, rounding=ROUND_UP)
    return normalized


def _normalize_hyperliquid_size(
    size: Decimal,
    *,
    sz_decimals: int,
) -> Decimal:
    quantum = Decimal("1").scaleb(-max(0, sz_decimals))
    return size.quantize(quantum, rounding=ROUND_DOWN)


def _decimal_places_for_significant_figures(
    value: Decimal,
    *,
    significant_figures: int,
) -> int:
    return max(0, significant_figures - value.copy_abs().adjusted() - 1)


def _decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    return Decimal(str(value))


def _optional_decimal(value: object) -> Decimal | None:
    if value in (None, ""):
        return None
    return Decimal(str(value))


def _optional_int(value: object) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(str(value))
    except ValueError:
        return None


def _position_notional(
    position_payload: dict[str, object],
    size: Decimal,
    entry_price: Decimal | None,
) -> Decimal:
    position_value = _decimal(position_payload.get("positionValue"))
    if position_value != Decimal("0") or entry_price is None:
        return position_value
    return size * entry_price


def _from_ms(value: object) -> datetime:
    millis = int(str(value or "0"))
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)
