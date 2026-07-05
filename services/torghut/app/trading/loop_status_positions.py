"""Position parsing and reconciliation helpers for trading loop status."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import cast


def raw_account_positions(account_row: Mapping[str, object]) -> list[dict[str, object]]:
    payload = _mapping_payload(account_row.get("raw_payload"))
    positions: list[dict[str, object]] = []
    for raw_position in _account_position_rows(payload):
        position = _mapping_payload(raw_position.get("position"))
        coin = _optional_text(position.get("coin"))
        if coin is None:
            continue
        positions.append(
            {
                "coin": coin,
                "size": _optional_text(position.get("szi")) or "0",
                "entry_price": _optional_text(position.get("entryPx")),
                "notional_usd": _optional_text(position.get("positionValue")) or "0",
                "unrealized_pnl_usd": _optional_text(position.get("unrealizedPnl"))
                or "0",
            }
        )
    return sorted(positions, key=lambda item: str(item["coin"]))


def managed_exchange_positions(
    persisted_positions: Sequence[Mapping[str, object]],
    raw_exchange_positions: Sequence[Mapping[str, object]],
    selected_symbols: Sequence[str],
) -> list[Mapping[str, object]]:
    managed_coins = position_coin_set(persisted_positions)
    managed_coins.update(selected_symbols)
    return [
        position
        for position in raw_exchange_positions
        if _optional_text(position.get("coin")) in managed_coins
    ]


def unmanaged_exchange_positions(
    raw_exchange_positions: Sequence[Mapping[str, object]],
    managed_positions: Sequence[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    managed_ids = {id(position) for position in managed_positions}
    return [
        position
        for position in raw_exchange_positions
        if id(position) not in managed_ids
    ]


def position_coin_set(rows: Sequence[Mapping[str, object]]) -> set[str]:
    return {
        coin for row in rows if (coin := _optional_text(row.get("coin"))) is not None
    }


def _account_position_rows(
    payload: Mapping[str, object],
) -> list[Mapping[str, object]]:
    rows: list[Mapping[str, object]] = []
    _extend_position_rows(rows, payload.get("assetPositions"))
    dex_states = payload.get("dexStates")
    if isinstance(dex_states, Mapping):
        for raw_state in cast(Mapping[object, object], dex_states).values():
            state = _mapping_payload(raw_state)
            _extend_position_rows(rows, state.get("assetPositions"))
    clearinghouse_state = _mapping_payload(payload.get("clearinghouseState"))
    _extend_position_rows(rows, clearinghouse_state.get("assetPositions"))
    return rows


def _extend_position_rows(rows: list[Mapping[str, object]], value: object) -> None:
    if not isinstance(value, list):
        return
    for raw_position in cast(list[object], value):
        if not isinstance(raw_position, Mapping):
            continue
        rows.append(cast(Mapping[str, object], raw_position))


def _mapping_payload(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(loaded, Mapping):
            return cast(Mapping[str, object], loaded)
    return {}


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
