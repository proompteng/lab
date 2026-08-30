"""Configured Hyperliquid v2 universe selection."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Iterable, Mapping, cast

from .models import (
    ConfiguredCoin,
    ExecutionMarket,
    RuntimeDependencyStatus,
    coin_key,
    symbol_key,
)


def parse_configured_coin(value: str) -> ConfiguredCoin:
    """Parse values such as `xyz:NVDA` into a dex-scoped coin."""

    raw = value.strip()
    parts = [part.strip() for part in raw.split(":") if part.strip()]
    if not parts:
        return ConfiguredCoin(raw=raw, symbol="")
    if len(parts) == 1:
        return ConfiguredCoin(raw=raw, symbol=parts[0].upper())
    return ConfiguredCoin(raw=raw, dex=parts[0].lower(), symbol=parts[-1].upper())


@dataclass(frozen=True)
class UniverseSelectionConfig:
    """Configuration needed for deterministic v2 universe selection."""

    market_data_network: str
    configured_coins: tuple[str, ...]
    excluded_coins: tuple[str, ...]
    min_day_notional_volume_usd: Decimal
    max_markets: int


def select_configured_markets(
    rows: Iterable[Mapping[str, object]],
    *,
    config: UniverseSelectionConfig,
) -> tuple[tuple[ExecutionMarket, ...], dict[str, object]]:
    """Select only configured, non-excluded markets from mainnet feed rows."""

    configured = tuple(parse_configured_coin(coin) for coin in config.configured_coins)
    exclusions = _universe_exclusions(config.excluded_coins)
    selected: list[ExecutionMarket] = []
    seen_configured_keys: set[str] = set()
    for row in rows:
        market = market_from_catalog_row(
            row, market_data_network=config.market_data_network
        )
        if market is None:
            continue
        if _market_excluded(market, exclusions):
            continue
        matched = _matching_configured_coin(market, configured)
        if matched is None:
            continue
        seen_configured_keys.add(matched.key)
        if market.day_notional_volume_usd < config.min_day_notional_volume_usd:
            continue
        selected.append(market)
    selected.sort(key=lambda market: market.day_notional_volume_usd, reverse=True)
    capped = tuple(selected[: max(0, config.max_markets)])
    return capped, _selection_details(
        configured, exclusions, capped, seen_configured_keys
    )


@dataclass(frozen=True)
class _UniverseExclusions:
    symbols: frozenset[str]
    coin_keys: frozenset[str]


def _universe_exclusions(excluded_coins: Iterable[str]) -> _UniverseExclusions:
    return _UniverseExclusions(
        symbols=frozenset(symbol_key(coin) for coin in excluded_coins),
        coin_keys=frozenset(coin_key(coin) for coin in excluded_coins),
    )


def _market_excluded(market: ExecutionMarket, exclusions: _UniverseExclusions) -> bool:
    return (
        market.symbol in exclusions.symbols
        or coin_key(market.coin) in exclusions.coin_keys
    )


def _selection_details(
    configured: tuple[ConfiguredCoin, ...],
    exclusions: _UniverseExclusions,
    capped: tuple[ExecutionMarket, ...],
    seen_configured_keys: set[str],
) -> dict[str, object]:
    selected_symbols = {market.symbol for market in capped}
    return {
        "configured": [coin.raw for coin in configured],
        "excluded": sorted(exclusions.symbols),
        "selected_from_feed": [market.coin for market in capped],
        "missing_from_feed": [
            coin.raw
            for coin in configured
            if coin.symbol not in selected_symbols
            and coin.symbol not in exclusions.symbols
        ],
        "seen_configured_keys": sorted(seen_configured_keys),
    }


def market_from_catalog_row(
    row: Mapping[str, object],
    *,
    market_data_network: str,
) -> ExecutionMarket | None:
    """Normalize a ClickHouse market catalog row into a v2 market."""

    market_type = _string(row.get("market_type") or row.get("marketType"))
    if market_type and market_type != "perp":
        return None
    coin = _string(row.get("coin") or row.get("symbol"))
    if not coin:
        return None
    dex = _string(row.get("dex")) or "default"
    market_id = _string(row.get("market_id") or row.get("marketId"))
    if not market_id:
        market_id = f"hl:perp:{dex}:{coin}"
    payload = _payload(row)
    return ExecutionMarket(
        market_id=market_id,
        coin=coin,
        dex=dex,
        network=_string(row.get("network")) or market_data_network,
        day_notional_volume_usd=_decimal(
            row.get("day_notional_volume_usd")
            or row.get("dayNtlVlm")
            or payload.get("dayNtlVlm")
        ),
        mark_price=_optional_decimal(row.get("mark_price") or row.get("markPx")),
        mid_price=_optional_decimal(row.get("mid_price") or row.get("midPx")),
        payload=payload,
    )


def execution_universe_status(
    *,
    requested: tuple[ExecutionMarket, ...],
    selected: tuple[ExecutionMarket, ...],
    delisted: Iterable[str],
    halted: Iterable[str],
) -> RuntimeDependencyStatus:
    """Build a reportable execution metadata status."""

    selected_symbols = {market.symbol for market in selected}
    delisted_symbols = {symbol_key(coin) for coin in delisted}
    halted_symbols = {symbol_key(coin) for coin in halted}
    missing = [
        market.coin
        for market in requested
        if market.symbol not in selected_symbols
        and market.symbol not in delisted_symbols
        and market.symbol not in halted_symbols
    ]
    details: dict[str, object] = {
        "requested": [market.coin for market in requested],
        "selected": [market.coin for market in selected],
        "missing": missing,
        "delisted": sorted(delisted_symbols),
        "halted": sorted(halted_symbols),
    }
    return RuntimeDependencyStatus(
        name="hyperliquid_execution_metadata",
        ready=bool(selected),
        reason=None if selected else "no_active_execution_symbols",
        details=details,
    )


def _matching_configured_coin(
    market: ExecutionMarket,
    configured: tuple[ConfiguredCoin, ...],
) -> ConfiguredCoin | None:
    market_symbol = market.symbol
    market_dex = market.dex.lower()
    for coin in configured:
        if coin.symbol != market_symbol:
            continue
        if coin.dex is not None and coin.dex != market_dex:
            continue
        return coin
    return None


def _payload(row: Mapping[str, object]) -> dict[str, object]:
    raw = row.get("payload")
    if isinstance(raw, dict):
        return {
            str(key): value for key, value in cast(dict[object, object], raw).items()
        }
    if not isinstance(raw, str) or not raw.strip():
        return {}
    parsed = json.loads(raw)
    if isinstance(parsed, dict):
        return {
            str(key): value for key, value in cast(dict[object, object], parsed).items()
        }
    return {}


def _string(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _optional_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
