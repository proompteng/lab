"""Compatibility helpers for Hyperliquid SDK market aliases."""

from __future__ import annotations

from typing import cast


def register_sdk_market_alias(
    sdk_exchange: object, alias: str, metadata_name: str
) -> None:
    if alias == metadata_name:
        return
    info = getattr(sdk_exchange, "info", None)
    raw_name_to_coin = getattr(info, "name_to_coin", None)
    if not isinstance(raw_name_to_coin, dict):
        return
    name_to_coin = cast(dict[str, object], raw_name_to_coin)
    if alias in name_to_coin or metadata_name not in name_to_coin:
        return
    name_to_coin[alias] = name_to_coin[metadata_name]
