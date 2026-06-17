# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime execution ledger primitives for honest post-cost PnL proof."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast


from .shared_context import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
    RuntimeLedgerBucket,
    RuntimeLedgerFill,
    BUY_SIDES as _BUY_SIDES,
    FILL_EVENTS as _FILL_EVENTS,
    NON_RUNTIME_PNL_TCA_BASIS_ALIASES as _NON_RUNTIME_PNL_TCA_BASIS_ALIASES,
    NormalizedFill as _NormalizedFill,
    SELL_SIDES as _SELL_SIDES,
    TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER as _TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER,
    TIGERBEETLE_JOURNAL_SUCCESS_STATUSES as _TIGERBEETLE_JOURNAL_SUCCESS_STATUSES,
    build_runtime_ledger_buckets,
)
from .order_lifecycle_blockers import (
    is_order_feed_source_fill as _is_order_feed_source_fill,
    row_value as _row_value,
)


def _is_order_feed_lifecycle_only_row(
    row: RuntimeLedgerFill | Mapping[str, object],
    *,
    event_type: str,
) -> bool:
    if event_type not in _FILL_EVENTS or not _is_order_feed_source_fill(row):
        return False
    source = _coerce_text(
        _row_value(row, "source", "pnl_derivation", "source_materialization")
    )
    if source in {"order_feed_lifecycle", "source_execution_lifecycle"}:
        return True
    return (
        _row_value(
            row,
            "cost_amount",
            "total_cost",
            "explicit_cost",
            "commission",
            "fees",
            "fee_amount",
            "broker_fee",
            "explicit_cost_amount",
            "total_fees",
            "total_fee_amount",
        )
        is None
        and _row_value(
            row,
            "cost_basis",
            "cost_source",
            "fee_basis",
            "commission_basis",
            "broker_fee_basis",
        )
        is None
    )


def _has_tca_pnl_shortcut(row: RuntimeLedgerFill | Mapping[str, object]) -> bool:
    basis = _coerce_text(
        _row_value(
            row,
            "post_cost_expectancy_basis",
            "post_cost_basis",
            "pnl_basis",
            "cost_basis",
        )
    )
    if basis is not None and _basis_claims_tca_pnl_shortcut(basis):
        return True
    return (
        _row_value(row, "post_cost_expectancy_bps") is not None
        and _row_value(row, "shortfall_notional", "realized_pnl_proxy_notional")
        is not None
    )


def _basis_claims_tca_pnl_shortcut(basis: str) -> bool:
    normalized = basis.lower().replace("-", "_")
    if normalized in _NON_RUNTIME_PNL_TCA_BASIS_ALIASES:
        return True
    tokens = {token for token in normalized.split("_") if token}
    return (
        ("tca" in tokens or "shortfall" in tokens)
        and ("proxy" in tokens or "estimate" in tokens)
    ) or ("realized" in tokens and "pnl" in tokens and "proxy" in tokens)


def _tigerbeetle_journal_blockers(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    for key in (
        "tigerbeetle_journal_blockers",
        "tigerbeetle_journal_blocker",
        "tigerbeetle_execution_cost_journal_blockers",
        "tigerbeetle_execution_cost_journal_blocker",
    ):
        value = _row_value(row, key)
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            for item in cast(Sequence[object], value):
                blocker = str(item).strip()
                if blocker:
                    blockers.append(blocker)
        elif value is not None and str(value).strip():
            blockers.append(str(value).strip())

    status = _coerce_text(
        _row_value(
            row,
            "tigerbeetle_execution_cost_journal_status",
            "tigerbeetle_journal_status",
        )
    )
    if (
        status is not None
        and status.lower().replace("-", "_")
        not in _TIGERBEETLE_JOURNAL_SUCCESS_STATUSES
    ):
        blockers.append(_TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER)
    return _dedupe(blockers)


def _group_key(row: _NormalizedFill, group_by: Sequence[str]) -> tuple[str | None, ...]:
    return tuple(_normalized_fill_field(row, field) for field in group_by)


def _bucket_field(
    field: str,
    rows: Sequence[_NormalizedFill],
    group_by: Sequence[str],
    group_key: tuple[str | None, ...],
) -> str | None:
    if field in group_by:
        return group_key[group_by.index(field)]
    values = {
        value
        for row in rows
        if (value := _normalized_fill_field(row, field)) is not None
    }
    if len(values) == 1:
        return next(iter(values))
    return None


def _normalized_fill_field(row: _NormalizedFill, field: str) -> str | None:
    if field == "account_label":
        return row.account_label
    if field == "strategy_id":
        return row.strategy_id
    if field == "symbol":
        return row.symbol
    return None


def _same_direction(current_qty: Decimal, side_sign: Decimal) -> bool:
    return (current_qty > 0 and side_sign > 0) or (current_qty < 0 and side_sign < 0)


def _allocate(amount: Decimal, qty: Decimal, total_qty: Decimal) -> Decimal:
    if total_qty <= 0:
        return Decimal("0")
    return amount * qty / total_qty


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _coerce_datetime(value: object | None) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _coerce_text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _coerce_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _coerce_side(value: object | None) -> str | None:
    text = _coerce_text(value)
    if text is None:
        return None
    normalized = text.lower().replace("-", "_")
    if normalized in _BUY_SIDES or normalized in _SELL_SIDES:
        return normalized
    return None


def _positive_decimal(value: object | None) -> Decimal | None:
    parsed = _decimal(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _non_negative_decimal(value: object | None) -> Decimal | None:
    parsed = _decimal(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def _decimal(value: object | None) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        parsed = value
    else:
        try:
            parsed = Decimal(str(value).strip())
        except Exception:
            return None
    if not parsed.is_finite():
        return None
    return parsed


def _dedupe(items: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(items))


__all__ = [
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "POST_COST_PNL_BASIS",
    "RuntimeLedgerBucket",
    "RuntimeLedgerFill",
    "build_runtime_ledger_buckets",
]
