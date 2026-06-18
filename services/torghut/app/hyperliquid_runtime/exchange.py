"""Hyperliquid testnet exchange adapter."""

from __future__ import annotations

import importlib
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Protocol, cast

from .config import HyperliquidRuntimeConfig
from .models import Fill, OrderIntent, OrderResult, OrderStatus, RuntimeDependencyStatus


class HyperliquidExchange(Protocol):
    """Minimal exchange surface used by the runtime service."""

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        """Submit an IOC limit order."""
        ...

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        """Read current account fills from the dedicated testnet account."""
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

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        _ = intent
        return OrderResult(
            status="submitted",
            exchange_order_id=None,
            raw_response={"shadow": True},
        )

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        _ = market_id_by_coin
        self._observed_at = datetime.now(timezone.utc)
        return []

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

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
        _ = intent
        raise RuntimeError(
            f"hyperliquid_exchange_unavailable:{','.join(self._reasons)}"
        )

    def reconcile_fills(self, market_id_by_coin: dict[str, str]) -> list[Fill]:
        _ = market_id_by_coin
        return []

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
        self._sdk_info: Any | None = None
        self._last_exchange_read_at: datetime | None = None

    def submit_ioc_limit(self, intent: OrderIntent) -> OrderResult:
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
        if self._sdk_exchange is None:
            eth_account = importlib.import_module("eth_account")
            exchange_module = importlib.import_module("hyperliquid.exchange")
            wallet = eth_account.Account.from_key(self._config.api_wallet_private_key)
            exchange_cls = getattr(exchange_module, "Exchange")
            self._sdk_exchange = exchange_cls(
                wallet,
                base_url=self._config.exchange_api_url,
                account_address=self._config.account_address,
                timeout=float(self._config.exchange_staleness_seconds),
            )
        return self._sdk_exchange

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


def _decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    return Decimal(str(value))


def _from_ms(value: object) -> datetime:
    millis = int(str(value or "0"))
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)
