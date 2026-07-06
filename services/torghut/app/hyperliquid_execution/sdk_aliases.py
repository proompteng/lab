"""Compatibility helpers for Hyperliquid SDK market aliases."""

from __future__ import annotations

from typing import cast


def register_sdk_market_alias(
    sdk_client: object, alias: str, metadata_name: str
) -> None:
    if alias == metadata_name:
        return
    name_to_coin = _name_to_coin(sdk_client)
    if name_to_coin is None:
        return
    if alias in name_to_coin or metadata_name not in name_to_coin:
        return
    name_to_coin[alias] = name_to_coin[metadata_name]


def _name_to_coin(sdk_client: object) -> dict[str, object] | None:
    direct = getattr(sdk_client, "name_to_coin", None)
    if isinstance(direct, dict):
        return cast(dict[str, object], direct)
    info = getattr(sdk_client, "info", None)
    nested = getattr(info, "name_to_coin", None)
    if isinstance(nested, dict):
        return cast(dict[str, object], nested)
    return None
