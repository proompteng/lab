"""Read-model queries for Hyperliquid execution runtime state."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime
from decimal import Decimal
from typing import Mapping, Protocol, cast

from sqlalchemy import text

from .models import OrderSide, PositionSnapshot, RiskState, RuntimeDependencyStatus
from .profitability import SymbolProfitabilityState


class _SqlRows(Protocol):
    def __iter__(self) -> Iterator[Mapping[str, object]]: ...

    def mappings(self) -> "_SqlRows": ...

    def one(self) -> Mapping[str, object]: ...


class _SqlSession(Protocol):
    def execute(
        self,
        statement: object,
        params: Mapping[str, object] | None = None,
    ) -> _SqlRows: ...


def risk_state(
    session: _SqlSession,
    *,
    trading_enabled: bool,
    dependencies: tuple[RuntimeDependencyStatus, ...],
    max_leverage_by_coin: dict[str, Decimal] | None = None,
) -> RiskState:
    account_row = _risk_account_row(session)
    open_rows = session.execute(
        text(
            """
            SELECT DISTINCT coin
            FROM hyperliquid_execution_orders
            WHERE execution_network = 'testnet'
              AND status IN ('accepted', 'submitted')
            """
        )
    ).mappings()
    exposure_rows = session.execute(
        text(
            """
            SELECT coin, SUM(exposure_usd) AS exposure_usd
            FROM (
              SELECT coin, ABS(notional_usd) AS exposure_usd
              FROM hyperliquid_execution_positions
              WHERE execution_network = 'testnet'
              UNION ALL
              SELECT coin, ABS(notional_usd) AS exposure_usd
              FROM hyperliquid_execution_orders
              WHERE execution_network = 'testnet'
                AND status IN ('accepted', 'submitted')
            ) exposures
            GROUP BY coin
            """
        )
    ).mappings()
    cooldown_rows = session.execute(
        text(
            """
            SELECT coin, cooldown_reason
            FROM hyperliquid_execution_symbol_state
            WHERE cooldown_until IS NOT NULL
              AND cooldown_until > now()
            """
        )
    ).mappings()
    return RiskState(
        trading_enabled=trading_enabled,
        dependencies=dependencies,
        account_value_usd=Decimal(str(account_row["account_value_usd"])),
        withdrawable_usd=Decimal(str(account_row["withdrawable_usd"])),
        gross_exposure_usd=Decimal(str(account_row["gross_exposure_usd"])),
        daily_realized_pnl_usd=Decimal(str(account_row["daily_realized_pnl_usd"])),
        open_order_coins=frozenset(str(row["coin"]) for row in open_rows),
        symbol_exposure_usd_by_coin={
            str(row["coin"]): Decimal(str(row["exposure_usd"])) for row in exposure_rows
        },
        cooldown_reason_by_coin={
            str(row["coin"]): str(row["cooldown_reason"]) for row in cooldown_rows
        },
        max_leverage_by_coin=dict(max_leverage_by_coin or {}),
    )


def symbol_profitability_state(
    session: _SqlSession,
    *,
    coin: str,
    now: datetime,
    account_value_usd: Decimal,
) -> SymbolProfitabilityState:
    rows = list(
        session.execute(
            text(
                """
                SELECT
                  COALESCE(SUM(f.closed_pnl_usd - f.fee_usd) FILTER (
                    WHERE f.event_ts >= :now - interval '24 hours'
                  ), 0) AS net_pnl_after_fees_usd_24h,
                  COALESCE(SUM(f.notional_usd) FILTER (
                    WHERE f.event_ts >= :now - interval '1 hour'
                  ), 0) AS notional_usd_1h,
                  MAX(f.event_ts) FILTER (
                    WHERE f.event_ts >= :now - interval '24 hours'
                      AND f.order_id IS NOT NULL
                      AND o.reduce_only IS FALSE
                  ) AS last_entry_at,
                  (ARRAY_AGG(f.side ORDER BY f.event_ts DESC) FILTER (
                    WHERE f.event_ts >= :now - interval '24 hours'
                      AND f.order_id IS NOT NULL
                      AND o.reduce_only IS FALSE
                  ))[1] AS last_side,
                  (ARRAY_AGG(f.event_ts ORDER BY f.event_ts DESC) FILTER (
                    WHERE f.event_ts >= :now - interval '24 hours'
                      AND f.order_id IS NOT NULL
                      AND o.reduce_only IS FALSE
                  ))[1] AS last_side_at,
                  (ARRAY_AGG(f.side ORDER BY f.event_ts DESC) FILTER (
                    WHERE f.event_ts >= :now - interval '24 hours'
                      AND (
                        f.order_id IS NULL
                        OR o.reduce_only IS TRUE
                      )
                  ))[1] AS last_position_close_side,
                  (ARRAY_AGG(f.event_ts ORDER BY f.event_ts DESC) FILTER (
                    WHERE f.event_ts >= :now - interval '24 hours'
                      AND (
                        f.order_id IS NULL
                        OR o.reduce_only IS TRUE
                      )
                  ))[1] AS last_position_close_at
                FROM hyperliquid_execution_fills f
                LEFT JOIN hyperliquid_execution_orders o
                  ON o.id = f.order_id
                WHERE f.execution_network = 'testnet'
                  AND f.coin = :coin
                """
            ),
            {"coin": coin, "now": now},
        ).mappings()
    )
    row: Mapping[str, object] = rows[0] if rows else {}
    return SymbolProfitabilityState(
        coin=coin,
        account_value_usd=account_value_usd,
        net_pnl_after_fees_usd_24h=Decimal(
            str(row.get("net_pnl_after_fees_usd_24h") or "0")
        ),
        notional_usd_1h=Decimal(str(row.get("notional_usd_1h") or "0")),
        last_entry_at=_optional_datetime(row.get("last_entry_at")),
        last_side=_optional_order_side(row.get("last_side")),
        last_side_at=_optional_datetime(row.get("last_side_at")),
        last_position_close_side=_optional_order_side(
            row.get("last_position_close_side")
        ),
        last_position_close_at=_optional_datetime(row.get("last_position_close_at")),
    )


def position_for_coin(session: _SqlSession, coin: str) -> PositionSnapshot | None:
    rows = list(
        session.execute(
            text(
                """
                SELECT
                  market_id,
                  coin,
                  size,
                  entry_price,
                  notional_usd,
                  unrealized_pnl_usd,
                  observed_at,
                  raw_payload
                FROM hyperliquid_execution_positions
                WHERE execution_network = 'testnet'
                  AND coin = :coin
                LIMIT 1
                """
            ),
            {"coin": coin},
        ).mappings()
    )
    if not rows:
        return None
    row = rows[0]
    return PositionSnapshot(
        market_id=str(row["market_id"]),
        coin=str(row["coin"]),
        size=Decimal(str(row["size"])),
        entry_price=_optional_decimal(row.get("entry_price")),
        notional_usd=Decimal(str(row["notional_usd"])),
        unrealized_pnl_usd=Decimal(str(row["unrealized_pnl_usd"])),
        observed_at=cast(datetime, row["observed_at"]),
        raw_payload=cast(dict[str, object], row.get("raw_payload") or {}),
    )


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _optional_datetime(value: object) -> datetime | None:
    return value if isinstance(value, datetime) else None


def _optional_order_side(value: object) -> OrderSide | None:
    text_value = str(value) if value is not None else None
    if text_value in {"buy", "sell"}:
        return cast(OrderSide, text_value)
    return None


def _risk_account_row(session: _SqlSession) -> Mapping[str, object]:
    return (
        session.execute(
            text(
                """
                SELECT
                  COALESCE((
                    SELECT account_value_usd
                    FROM hyperliquid_execution_account_snapshots
                    WHERE execution_network = 'testnet'
                    ORDER BY observed_at DESC
                    LIMIT 1
                  ), 0) AS account_value_usd,
                  COALESCE((
                    SELECT withdrawable_usd
                    FROM hyperliquid_execution_account_snapshots
                    WHERE execution_network = 'testnet'
                    ORDER BY observed_at DESC
                    LIMIT 1
                  ), 0) AS withdrawable_usd,
                  COALESCE((
                    SELECT gross_exposure_usd
                    FROM hyperliquid_execution_account_snapshots
                    WHERE execution_network = 'testnet'
                    ORDER BY observed_at DESC
                    LIMIT 1
                  ), 0) AS gross_exposure_usd,
                  COALESCE((
                    SELECT SUM(closed_pnl_usd - fee_usd)
                    FROM hyperliquid_execution_fills
                    WHERE execution_network = 'testnet'
                      AND event_ts >= date_trunc('day', now())
                  ), 0) AS daily_realized_pnl_usd
                """
            )
        )
        .mappings()
        .one()
    )
