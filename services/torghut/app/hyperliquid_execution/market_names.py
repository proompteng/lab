"""SDK market-name normalization helpers."""

from __future__ import annotations


def sdk_dex(dex: str) -> str:
    normalized = dex.strip().lower()
    if normalized in {"", "default"}:
        return ""
    return normalized


def sdk_market_name(coin: str, dex: str) -> str:
    normalized_coin = coin.strip()
    if ":" in normalized_coin:
        return normalized_coin
    normalized_dex = sdk_dex(dex)
    return f"{normalized_dex}:{normalized_coin}" if normalized_dex else normalized_coin
