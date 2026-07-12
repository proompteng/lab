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
    metadata_coin = name_to_coin[metadata_name]
    name_to_coin[alias] = alias
    coin_to_asset = _coin_to_asset(sdk_client)
    if coin_to_asset is not None and alias not in coin_to_asset:
        asset = coin_to_asset.get(metadata_coin)
        if asset is None:
            asset = coin_to_asset.get(metadata_name)
        if asset is not None:
            coin_to_asset[alias] = asset


def _name_to_coin(sdk_client: object) -> dict[str, object] | None:
    direct = getattr(sdk_client, "name_to_coin", None)
    if isinstance(direct, dict):
        return cast(dict[str, object], direct)
    info = getattr(sdk_client, "info", None)
    nested = getattr(info, "name_to_coin", None)
    if isinstance(nested, dict):
        return cast(dict[str, object], nested)
    return None


def _coin_to_asset(sdk_client: object) -> dict[object, object] | None:
    direct = getattr(sdk_client, "coin_to_asset", None)
    if isinstance(direct, dict):
        return cast(dict[object, object], direct)
    info = getattr(sdk_client, "info", None)
    nested = getattr(info, "coin_to_asset", None)
    if isinstance(nested, dict):
        return cast(dict[object, object], nested)
    return None
