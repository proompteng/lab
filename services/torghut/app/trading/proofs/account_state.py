"""Account-state proof checks for runtime-window targets."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import PositionSnapshot
from .schemas import AccountStatePayload
from .targets import ProofTarget, isoformat


def load_account_state(
    session: Session,
    target: ProofTarget,
    *,
    window_closed: bool,
) -> AccountStatePayload:
    pre_snapshot = _latest_snapshot_at_or_before(
        session,
        account_label=target.account_label,
        as_of=target.window_start,
    )
    close_snapshot = (
        _latest_snapshot_at_or_after(
            session,
            account_label=target.account_label,
            as_of=target.window_end,
        )
        if window_closed
        else None
    )
    pre_positions = _positions(pre_snapshot.positions if pre_snapshot else None)
    close_positions = _positions(close_snapshot.positions if close_snapshot else None)
    clean_baseline = None if pre_snapshot is None else not pre_positions
    closed_flat = (
        None
        if not window_closed
        else close_snapshot is not None and not close_positions
    )
    blockers: list[str] = []
    if pre_snapshot is None:
        blockers.append("clean_baseline_snapshot_missing")
    elif pre_positions:
        blockers.append("account_dirty_before_window")
    if window_closed:
        if close_snapshot is None:
            blockers.append("close_snapshot_missing")
        elif close_positions:
            blockers.append("account_not_flat_after_window")
    return {
        "clean_baseline": clean_baseline,
        "clean_baseline_snapshot_at": isoformat(pre_snapshot.as_of)
        if pre_snapshot is not None
        else None,
        "closed_flat": closed_flat,
        "close_snapshot_at": isoformat(close_snapshot.as_of)
        if close_snapshot is not None
        else None,
        "contamination_count": len(pre_positions),
        "close_position_count": len(close_positions) if window_closed else None,
        "blockers": blockers,
    }


def _latest_snapshot_at_or_before(
    session: Session,
    *,
    account_label: str,
    as_of: object,
) -> PositionSnapshot | None:
    return (
        session.execute(
            select(PositionSnapshot)
            .where(PositionSnapshot.alpaca_account_label == account_label)
            .where(PositionSnapshot.as_of <= as_of)
            .order_by(PositionSnapshot.as_of.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )


def _latest_snapshot_at_or_after(
    session: Session,
    *,
    account_label: str,
    as_of: object,
) -> PositionSnapshot | None:
    return (
        session.execute(
            select(PositionSnapshot)
            .where(PositionSnapshot.alpaca_account_label == account_label)
            .where(PositionSnapshot.as_of >= as_of)
            .order_by(PositionSnapshot.as_of.asc())
            .limit(1)
        )
        .scalars()
        .first()
    )


def _positions(value: object) -> list[dict[str, object]]:
    values: Iterable[object]
    if isinstance(value, Mapping):
        values = cast(Mapping[object, object], value).values()
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        values = cast(Sequence[object], value)
    else:
        values = ()
    positions: list[dict[str, object]] = []
    for item in values:
        if not isinstance(item, Mapping):
            continue
        payload = {
            str(key): raw for key, raw in cast(Mapping[object, Any], item).items()
        }
        qty = _decimal_value(
            payload.get("qty")
            or payload.get("quantity")
            or payload.get("position_qty")
            or payload.get("market_value")
        )
        if qty is not None and qty != 0:
            positions.append(payload)
    return positions


def _decimal_value(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
