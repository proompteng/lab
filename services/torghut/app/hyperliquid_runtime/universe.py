"""Hyperliquid runtime universe selection."""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, cast

from .models import AssetClass, HyperliquidMarket


_COMMODITY_COINS = {
    "BRENTOIL",
    "BRENT",
    "CL",
    "COPPER",
    "GOLD",
    "NATGAS",
    "SILVER",
    "WTI",
}
_FX_COINS = {
    "AUD",
    "CAD",
    "CHF",
    "CNH",
    "EUR",
    "GBP",
    "JPY",
}
_INDEX_COINS = {
    "DJI",
    "EWY",
    "NAS100",
    "NDX",
    "RUT",
    "RUSSELL",
    "SP500",
    "SPX",
    "USA500",
    "US30",
    "USATECH",
    "XYZ100",
}
_STOCK_COINS = {
    "AAPL",
    "AMD",
    "AMZN",
    "ARM",
    "AVGO",
    "BB",
    "CBRS",
    "COIN",
    "CRCL",
    "CRWV",
    "GOOGL",
    "HOOD",
    "INTC",
    "LITE",
    "META",
    "MRVL",
    "MSFT",
    "MSTR",
    "MU",
    "NBIS",
    "NVDA",
    "ORCL",
    "PLTR",
    "RKLB",
    "SMSN",
    "SNDK",
    "TSLA",
    "WDC",
}
_VETTED_PREIPO_COINS = {
    "BIRD",
    "OPENAI",
    "PURRDAT",
    "SKHX",
    "SPCX",
}
_STOCK_PREFIX = "cash:"
_PREIPO_DEXES = {"xyz", "preipo"}


def select_runtime_markets(
    rows: Iterable[Mapping[str, object]],
    *,
    market_data_network: str,
    allowed_asset_classes: Iterable[str],
    min_day_notional_volume_usd: Decimal,
    max_markets: int,
) -> list[HyperliquidMarket]:
    """Select liquid runtime-approved perp markets."""

    allowed = {item.strip().lower() for item in allowed_asset_classes}
    selected: list[HyperliquidMarket] = []
    for row in rows:
        market = market_from_catalog_row(row, market_data_network=market_data_network)
        if market is None:
            continue
        if market.asset_class not in allowed:
            continue
        if market.day_notional_volume_usd < min_day_notional_volume_usd:
            continue
        selected.append(market)
    selected.sort(key=lambda market: market.day_notional_volume_usd, reverse=True)
    return selected[: max(0, max_markets)]


def market_from_catalog_row(
    row: Mapping[str, object],
    *,
    market_data_network: str,
) -> HyperliquidMarket | None:
    """Normalize a ClickHouse market catalog row into a runtime market."""

    market_type = _string(row.get("market_type") or row.get("marketType"))
    if market_type != "perp":
        return None
    coin = _string(row.get("coin") or row.get("symbol"))
    dex = _string(row.get("dex")) or "default"
    asset_class = classify_asset(coin=coin, dex=dex, payload=_payload(row))
    if asset_class is None:
        return None
    market_id = _string(row.get("market_id") or row.get("marketId"))
    if not market_id:
        market_id = f"hl:perp:{dex}:{coin}"
    payload = _payload(row)
    return HyperliquidMarket(
        market_id=market_id,
        coin=coin,
        dex=dex,
        asset_class=asset_class,
        network=_string(row.get("network")) or market_data_network,
        day_notional_volume_usd=_decimal(
            row.get("day_notional_volume_usd")
            or row.get("dayNtlVlm")
            or payload.get("dayNtlVlm")
            or payload.get("day_notional_volume_usd")
        ),
        mark_price=_optional_decimal(
            row.get("mark_price") or row.get("markPx") or payload.get("markPx")
        ),
        mid_price=_optional_decimal(
            row.get("mid_price") or row.get("midPx") or payload.get("midPx")
        ),
        open_interest_usd=_decimal(
            row.get("open_interest_usd")
            or row.get("openInterest")
            or payload.get("openInterest")
        ),
        max_leverage=_optional_int(
            row.get("max_leverage")
            or row.get("maxLeverage")
            or payload.get("maxLeverage")
        ),
        payload=payload,
    )


def classify_asset(
    *,
    coin: str,
    dex: str,
    payload: Mapping[str, object] | None = None,
) -> AssetClass | None:
    """Classify public Hyperliquid perps into runtime asset buckets."""

    normalized_coin = coin.strip()
    symbol = normalized_coin.removeprefix(_STOCK_PREFIX).split(":")[-1].upper()
    normalized_dex = dex.strip().lower()
    payload_class = _payload_asset_class(payload)
    if payload_class in {"crypto", "stocks", "indices", "preipo"}:
        return cast(AssetClass, payload_class)
    if symbol in _COMMODITY_COINS or symbol in _FX_COINS:
        return None
    if symbol in _INDEX_COINS:
        return "indices"
    if normalized_coin.startswith(_STOCK_PREFIX):
        return "stocks"
    if normalized_dex in _PREIPO_DEXES:
        if symbol in _VETTED_PREIPO_COINS:
            return "preipo"
        if symbol in _STOCK_COINS:
            return "stocks"
    if normalized_dex in {"", "default"}:
        return "crypto"
    return None


def select_equity_like_markets(
    rows: Iterable[Mapping[str, object]],
    *,
    market_data_network: str,
    allowed_asset_classes: Iterable[str],
    min_day_notional_volume_usd: Decimal,
    max_markets: int,
) -> list[HyperliquidMarket]:
    """Backward-compatible wrapper for callers not yet renamed."""

    return select_runtime_markets(
        rows,
        market_data_network=market_data_network,
        allowed_asset_classes=allowed_asset_classes,
        min_day_notional_volume_usd=min_day_notional_volume_usd,
        max_markets=max_markets,
    )


def _payload_asset_class(payload: Mapping[str, object] | None) -> str | None:
    if payload is None:
        return None
    for key in ("asset_class", "assetClass", "category", "type"):
        value = payload.get(key)
        if isinstance(value, str):
            normalized = value.strip().lower().replace("-", "_")
            if normalized in {"crypto", "cryptocurrency", "digital_asset"}:
                return "crypto"
            if normalized in {"stock", "stocks", "equity", "equities"}:
                return "stocks"
            if normalized in {"index", "indices", "equity_index"}:
                return "indices"
            if normalized in {"preipo", "pre_ipo", "pre ipo"}:
                return "preipo"
    return None


def _payload(row: Mapping[str, object]) -> dict[str, object]:
    raw = row.get("payload")
    if isinstance(raw, dict):
        return {
            str(key): value for key, value in cast(dict[object, object], raw).items()
        }
    if not isinstance(raw, str) or not raw.strip():
        return {}
    parsed: Any = json.loads(raw)
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
    parsed = _optional_decimal(value)
    return parsed if parsed is not None else Decimal("0")


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value))
    except ValueError:
        return None
