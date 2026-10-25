"""Parse Hyperliquid account and fill payloads into canonical execution state."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from .models import AccountSnapshot, AccountState, Fill, PositionSnapshot
from .reconciliation_keys import ReconciliationCoinMap


def fill_from_payload(
    payload: Mapping[str, object], market_id_by_coin: dict[str, str]
) -> Fill:
    reconciliation_coin = fill_coin(payload)
    coin = _canonical_reconciliation_coin(reconciliation_coin, market_id_by_coin)
    price = decimal_value(payload.get("px") or payload.get("price"))
    size = decimal_value(payload.get("sz") or payload.get("size"))
    return Fill(
        fill_hash=str(
            payload.get("tid")
            or payload.get("hash")
            or f"{reconciliation_coin}:{payload}"
        ),
        market_id=market_id_by_coin[reconciliation_coin],
        coin=coin,
        side="buy"
        if str(payload.get("side") or "").upper().startswith("B")
        else "sell",
        price=price,
        size=size,
        notional_usd=(price * size).quantize(Decimal("0.000001")),
        fee_usd=decimal_value(payload.get("fee")),
        closed_pnl_usd=decimal_value(
            payload.get("closedPnl") or payload.get("closed_pnl")
        ),
        exchange_order_id=optional_text(payload.get("oid")),
        event_ts=_event_ts(payload),
        raw_payload={str(key): value for key, value in payload.items()},
    )


def account_state_from_payloads(
    dex_payloads: Mapping[str, Mapping[str, object]],
    spot_payload: Mapping[str, object],
    market_id_by_coin: dict[str, str],
    observed_at: datetime,
) -> AccountState:
    account_value_usd = Decimal("0")
    withdrawable_usd = Decimal("0")
    gross_exposure_usd = Decimal("0")
    positions: list[PositionSnapshot] = []
    raw_dex_payloads: dict[str, object] = {}

    for dex, payload in dex_payloads.items():
        dex_state = _account_state_from_payload(
            payload,
            market_id_by_coin,
            observed_at,
        )
        account_value_usd += dex_state.account.account_value_usd
        withdrawable_usd += dex_state.account.withdrawable_usd
        gross_exposure_usd += dex_state.account.gross_exposure_usd
        positions.extend(dex_state.positions)
        raw_dex_payloads[dex or "default"] = dex_state.account.raw_payload

    spot_usdc_total = _spot_usdc_total(spot_payload)
    spot_usdc_available = _spot_usdc_available_after_maintenance(spot_payload)
    account_value_usd = max(account_value_usd, spot_usdc_total)
    withdrawable_usd = max(withdrawable_usd, spot_usdc_available)

    return AccountState(
        account=AccountSnapshot(
            observed_at=observed_at,
            account_value_usd=account_value_usd.quantize(Decimal("0.000001")),
            withdrawable_usd=withdrawable_usd.quantize(Decimal("0.000001")),
            gross_exposure_usd=gross_exposure_usd.quantize(Decimal("0.000001")),
            raw_payload={
                "dexStates": raw_dex_payloads,
                "spotUserState": {
                    str(key): value for key, value in spot_payload.items()
                },
            },
        ),
        positions=tuple(positions),
    )


def position_exposure_usd(position: Mapping[str, object]) -> Decimal:
    position_value = optional_decimal(position.get("positionValue"))
    if position_value is not None:
        return abs(position_value).quantize(Decimal("0.000001"))
    size = decimal_value(position.get("szi"))
    entry_price = optional_decimal(position.get("entryPx")) or Decimal("0")
    return abs(size * entry_price).quantize(Decimal("0.000001"))


def fill_coin(payload: Mapping[str, object]) -> str:
    return str(payload.get("coin") or "").strip()


def optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def decimal_value(value: object) -> Decimal:
    if value is None or value == "":
        return Decimal("0")
    return Decimal(str(value))


def optional_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def _account_state_from_payload(
    payload: Mapping[str, object],
    market_id_by_coin: dict[str, str],
    observed_at: datetime,
) -> AccountState:
    margin = payload.get("marginSummary")
    margin_map: Mapping[str, object] = (
        cast(Mapping[str, object], margin) if isinstance(margin, dict) else {}
    )
    raw_positions = payload.get("assetPositions")
    positions: list[PositionSnapshot] = []
    if isinstance(raw_positions, list):
        for item in cast(list[object], raw_positions):
            if not isinstance(item, dict):
                continue
            item_map = cast(Mapping[str, object], item)
            position = item_map.get("position")
            if not isinstance(position, dict):
                continue
            position_map = cast(Mapping[str, object], position)
            reconciliation_coin = str(position_map.get("coin") or "").strip()
            if reconciliation_coin not in market_id_by_coin:
                continue
            coin = _canonical_reconciliation_coin(
                reconciliation_coin, market_id_by_coin
            )
            size = decimal_value(position_map.get("szi"))
            entry_price = optional_decimal(position_map.get("entryPx"))
            notional_usd = position_exposure_usd(position_map)
            positions.append(
                PositionSnapshot(
                    market_id=market_id_by_coin[reconciliation_coin],
                    coin=coin,
                    size=size,
                    entry_price=entry_price,
                    notional_usd=notional_usd,
                    unrealized_pnl_usd=decimal_value(position_map.get("unrealizedPnl")),
                    observed_at=observed_at,
                    raw_payload={
                        str(key): value for key, value in position_map.items()
                    },
                    sdk_coin=reconciliation_coin,
                )
            )
    raw_exposure_usd = _raw_account_exposure_usd(payload, positions)
    return AccountState(
        account=AccountSnapshot(
            observed_at=observed_at,
            account_value_usd=decimal_value(margin_map.get("accountValue")),
            withdrawable_usd=decimal_value(payload.get("withdrawable")),
            gross_exposure_usd=raw_exposure_usd,
            raw_payload={str(key): value for key, value in payload.items()},
        ),
        positions=tuple(positions),
    )


def _canonical_reconciliation_coin(coin: str, market_id_by_coin: dict[str, str]) -> str:
    if isinstance(market_id_by_coin, ReconciliationCoinMap):
        return market_id_by_coin.canonical_coin_by_coin.get(coin, coin)
    market_id = market_id_by_coin.get(coin)
    if market_id is None:
        return coin
    for candidate, candidate_market_id in market_id_by_coin.items():
        if candidate_market_id == market_id:
            return candidate
    return coin


def _raw_account_exposure_usd(
    payload: Mapping[str, object],
    selected_positions: list[PositionSnapshot],
) -> Decimal:
    margin = payload.get("marginSummary")
    margin_map: Mapping[str, object] = (
        cast(Mapping[str, object], margin) if isinstance(margin, dict) else {}
    )
    cross_margin = payload.get("crossMarginSummary")
    cross_margin_map: Mapping[str, object] = (
        cast(Mapping[str, object], cross_margin)
        if isinstance(cross_margin, dict)
        else {}
    )
    raw_positions = payload.get("assetPositions")
    raw_position_exposure = Decimal("0")
    if isinstance(raw_positions, list):
        for item in cast(list[object], raw_positions):
            if not isinstance(item, dict):
                continue
            position = cast(Mapping[str, object], item).get("position")
            if isinstance(position, dict):
                raw_position_exposure += position_exposure_usd(
                    cast(Mapping[str, object], position)
                )
    selected_exposure = sum(
        (position.notional_usd for position in selected_positions), Decimal("0")
    )
    return max(
        selected_exposure,
        raw_position_exposure,
        decimal_value(margin_map.get("totalNtlPos")),
        decimal_value(cross_margin_map.get("totalNtlPos")),
    ).quantize(Decimal("0.000001"))


def _spot_usdc_total(payload: Mapping[str, object]) -> Decimal:
    for balance in _spot_usdc_balances(payload):
        return decimal_value(balance.get("total"))
    return Decimal("0")


def _spot_usdc_available_after_maintenance(
    payload: Mapping[str, object],
) -> Decimal:
    raw_available = payload.get("tokenToAvailableAfterMaintenance")
    if isinstance(raw_available, list):
        for item in cast(list[object], raw_available):
            if not isinstance(item, list):
                continue
            parts = cast(list[object], item)
            if len(parts) < 2:
                continue
            token, available = parts[0], parts[1]
            if str(token) == "0":
                return decimal_value(available)
    for balance in _spot_usdc_balances(payload):
        return max(
            Decimal("0"),
            decimal_value(balance.get("total")) - decimal_value(balance.get("hold")),
        )
    return Decimal("0")


def _spot_usdc_balances(
    payload: Mapping[str, object],
) -> list[Mapping[str, object]]:
    balances = payload.get("balances")
    if not isinstance(balances, list):
        return []
    usdc_balances: list[Mapping[str, object]] = []
    for balance in cast(list[object], balances):
        if not isinstance(balance, dict):
            continue
        balance_map = cast(Mapping[str, object], balance)
        if str(balance_map.get("coin") or "").strip().upper() == "USDC":
            usdc_balances.append(balance_map)
    return usdc_balances


def _event_ts(payload: Mapping[str, object]) -> datetime:
    raw_time = payload.get("time")
    if raw_time is None:
        return datetime.now(timezone.utc)
    return datetime.fromtimestamp(int(str(raw_time)) / 1000, tz=timezone.utc)


__all__ = [
    "account_state_from_payloads",
    "decimal_value",
    "fill_coin",
    "fill_from_payload",
    "optional_decimal",
    "optional_text",
    "position_exposure_usd",
]
