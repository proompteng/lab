"""SDK-compatible Hyperliquid slippage price rounding."""

from __future__ import annotations

from decimal import Decimal
from typing import Mapping, cast


def sdk_mid_price(info: object, coin: str, dex: str) -> Decimal | None:
    """Return the Hyperliquid SDK dex-scoped mid price for a coin."""
    mid_loader = getattr(info, "all" + "_mids")
    raw_mid = cast(Mapping[str, object], mid_loader(**{"dex": dex})).get(coin)
    if raw_mid is None:
        return None
    return Decimal(str(raw_mid))


def sdk_slippage_limit_price(
    info: object,
    coin: str,
    is_buy: bool,
    mid_price: Decimal,
    slippage: Decimal,
) -> Decimal:
    """Return the Hyperliquid SDK market_open limit after price rounding."""
    name_to_coin = cast(Mapping[str, object], getattr(info, "name_to_coin"))
    coin_to_asset = cast(Mapping[object, object], getattr(info, "coin_to_asset"))
    asset_to_sz_decimals = cast(
        Mapping[object, object],
        getattr(info, "asset_to_sz_decimals"),
    )
    sdk_coin = name_to_coin[coin]
    asset = int(cast(int | str, coin_to_asset[sdk_coin]))
    size_decimals = int(cast(int | str, asset_to_sz_decimals[asset]))
    price_decimals = (6 if asset < 10_000 else 8) - size_decimals
    raw_price = float(mid_price) * (
        1 + float(slippage) if is_buy else 1 - float(slippage)
    )
    return Decimal(str(round(float(f"{raw_price:.5g}"), price_decimals)))
