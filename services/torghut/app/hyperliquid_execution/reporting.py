"""Operational reporting queries for Hyperliquid execution v2."""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Any, Mapping, Protocol, cast

from sqlalchemy import text


class QuerySession(Protocol):
    """Minimal SQLAlchemy session surface used by reporting queries."""

    def execute(
        self,
        statement: object,
        parameters: Mapping[str, object] | None = None,
    ) -> Any:
        """Execute a SQL statement and return a SQLAlchemy result."""


def build_operational_report(
    session: QuerySession,
    *,
    runtime_payload: Mapping[str, object],
    config_payload: Mapping[str, object],
) -> dict[str, object]:
    """Return a compact operator report from v2 evidence only."""

    return {
        "schema_version": "torghut.hyperliquid-execution-report.v2",
        "runtime": dict(runtime_payload),
        "config": dict(config_payload),
        "account": _query_rows(
            session,
            """
            SELECT
              observed_at::text,
              account_value_usd::text,
              withdrawable_usd::text,
              gross_exposure_usd::text,
              raw_payload
            FROM hyperliquid_execution_account_snapshots
            WHERE execution_network = 'testnet'
            ORDER BY observed_at DESC
            LIMIT 1
            """,
        ),
        "positions": _query_rows(
            session,
            """
            SELECT
              observed_at::text,
              coin,
              size::text,
              entry_price::text,
              notional_usd::text,
              unrealized_pnl_usd::text
            FROM hyperliquid_execution_positions
            WHERE execution_network = 'testnet'
            ORDER BY coin
            LIMIT 100
            """,
        ),
        "external_account_positions": _raw_account_positions(session),
        "open_orders": _query_rows(
            session,
            """
            SELECT
              created_at::text,
              coin,
              side,
              status,
              exchange_order_id,
              limit_price::text,
              size::text,
              notional_usd::text,
              expires_at::text
            FROM hyperliquid_execution_orders
            WHERE execution_network = 'testnet'
              AND status IN ('accepted', 'submitted')
            ORDER BY created_at DESC
            LIMIT 100
            """,
        ),
        "fills_by_coin": _query_rows(
            session,
            """
            SELECT
              coin,
              side,
              count(*)::int AS fills,
              COALESCE(sum(notional_usd), 0)::text AS notional_usd,
              COALESCE(sum(fee_usd), 0)::text AS fees_usd,
              COALESCE(sum(closed_pnl_usd - fee_usd), 0)::text AS net_pnl_after_fees_usd
            FROM hyperliquid_execution_fills
            WHERE execution_network = 'testnet'
            GROUP BY coin, side
            ORDER BY coin, side
            """,
        ),
        "rejects_by_coin_reason": _query_rows(
            session,
            """
            SELECT
              coin,
              COALESCE(rejection_reason, '') AS reason,
              count(*)::int AS rejects,
              max(created_at)::text AS latest_at
            FROM hyperliquid_execution_orders
            WHERE execution_network = 'testnet'
              AND status = 'rejected'
            GROUP BY coin, COALESCE(rejection_reason, '')
            ORDER BY latest_at DESC
            LIMIT 100
            """,
        ),
        "cooldowns": _query_rows(
            session,
            """
            SELECT
              coin,
              cooldown_reason,
              cooldown_until::text,
              updated_at::text
            FROM hyperliquid_execution_symbol_state
            WHERE cooldown_until IS NOT NULL
              AND cooldown_until > now()
            ORDER BY cooldown_until DESC
            """,
        ),
        "performance": _query_rows(
            session,
            """
            SELECT
              observed_at::text,
              fill_count_24h,
              notional_usd_24h::text,
              fees_usd_24h::text,
              net_pnl_after_fees_usd_24h::text,
              max_drawdown_usd_24h::text,
              fill_count_7d,
              notional_usd_7d::text,
              fees_usd_7d::text,
              net_pnl_after_fees_usd_7d::text,
              max_drawdown_usd_7d::text,
              maker_fill_rate_24h::text,
              cancel_rate_24h::text,
              reject_rate_24h::text,
              sample_ready,
              symbol_pnl
            FROM hyperliquid_execution_performance_snapshots
            WHERE execution_network = 'testnet'
            ORDER BY observed_at DESC
            LIMIT 1
            """,
        ),
    }


def build_performance_metrics(session: QuerySession) -> dict[str, object]:
    summary = (
        session.execute(
            text(
                """
                WITH
                fills_24h AS (
                  SELECT
                    count(*) AS fills,
                    COALESCE(sum(notional_usd), 0) AS notional,
                    COALESCE(sum(fee_usd), 0) AS fees,
                    COALESCE(sum(closed_pnl_usd - fee_usd), 0) AS net_pnl
                  FROM hyperliquid_execution_fills
                  WHERE execution_network = 'testnet'
                    AND event_ts >= now() - interval '24 hours'
                ),
                fills_7d AS (
                  SELECT
                    count(*) AS fills,
                    COALESCE(sum(notional_usd), 0) AS notional,
                    COALESCE(sum(fee_usd), 0) AS fees,
                    COALESCE(sum(closed_pnl_usd - fee_usd), 0) AS net_pnl
                  FROM hyperliquid_execution_fills
                  WHERE execution_network = 'testnet'
                    AND event_ts >= now() - interval '7 days'
                ),
                orders_24h AS (
                  SELECT
                    count(*) AS orders,
                    count(*) FILTER (WHERE status = 'filled') AS filled,
                    count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
                    count(*) FILTER (WHERE status = 'rejected') AS rejected
                  FROM hyperliquid_execution_orders
                  WHERE execution_network = 'testnet'
                    AND created_at >= now() - interval '24 hours'
                ),
                all_fills AS (
                  SELECT count(*) AS fills
                  FROM hyperliquid_execution_fills
                  WHERE execution_network = 'testnet'
                )
                SELECT
                  fills_24h.fills AS fills_24h,
                  fills_24h.notional AS notional_24h,
                  fills_24h.fees AS fees_24h,
                  fills_24h.net_pnl AS net_pnl_24h,
                  fills_7d.fills AS fills_7d,
                  fills_7d.notional AS notional_7d,
                  fills_7d.fees AS fees_7d,
                  fills_7d.net_pnl AS net_pnl_7d,
                  orders_24h.orders AS orders_24h,
                  orders_24h.filled AS filled_orders_24h,
                  orders_24h.cancelled AS cancelled_orders_24h,
                  orders_24h.rejected AS rejected_orders_24h,
                  all_fills.fills AS all_fills
                FROM fills_24h, fills_7d, orders_24h, all_fills
                """
            )
        )
        .mappings()
        .one()
    )
    symbol_pnl = _query_rows(
        session,
        """
        SELECT
          coin,
          count(*)::int AS fills,
          COALESCE(sum(notional_usd), 0)::text AS notional_usd,
          COALESCE(sum(fee_usd), 0)::text AS fees_usd,
          COALESCE(sum(closed_pnl_usd - fee_usd), 0)::text AS net_pnl_after_fees_usd
        FROM hyperliquid_execution_fills
        WHERE execution_network = 'testnet'
        GROUP BY coin
        ORDER BY coin
        """,
    )
    orders_24h = Decimal(str(summary["orders_24h"]))
    filled = Decimal(str(summary["filled_orders_24h"]))
    cancelled = Decimal(str(summary["cancelled_orders_24h"]))
    rejected = Decimal(str(summary["rejected_orders_24h"]))
    net_24h = Decimal(str(summary["net_pnl_24h"]))
    net_7d = Decimal(str(summary["net_pnl_7d"]))
    return {
        "fill_count_24h": int(summary["fills_24h"]),
        "notional_usd_24h": str(summary["notional_24h"]),
        "fees_usd_24h": str(summary["fees_24h"]),
        "net_pnl_after_fees_usd_24h": str(net_24h),
        "max_drawdown_usd_24h": str(min(net_24h, Decimal("0"))),
        "fill_count_7d": int(summary["fills_7d"]),
        "notional_usd_7d": str(summary["notional_7d"]),
        "fees_usd_7d": str(summary["fees_7d"]),
        "net_pnl_after_fees_usd_7d": str(net_7d),
        "max_drawdown_usd_7d": str(min(net_7d, Decimal("0"))),
        "maker_fill_rate_24h": str(_ratio(filled, orders_24h)),
        "cancel_rate_24h": str(_ratio(cancelled, orders_24h)),
        "reject_rate_24h": str(_ratio(rejected, orders_24h)),
        "sample_ready": int(summary["all_fills"]) >= 40,
        "symbol_pnl": json.dumps(symbol_pnl, sort_keys=True),
    }


def _query_rows(session: QuerySession, query: str) -> list[dict[str, object]]:
    rows = session.execute(text(query)).mappings().all()
    return [
        {
            str(key): _json_safe(value)
            for key, value in cast(Mapping[str, object], row).items()
        }
        for row in rows
    ]


def _raw_account_positions(session: QuerySession) -> list[dict[str, object]]:
    rows = _query_rows(session, _latest_account_snapshot_query())
    if not rows:
        return []
    observed_at = rows[0].get("observed_at")
    payload = _mapping_payload(rows[0].get("raw_payload"))
    raw_positions = payload.get("assetPositions")
    if not isinstance(raw_positions, list):
        return []
    positions: list[dict[str, object]] = []
    for item in cast(list[object], raw_positions):
        if not isinstance(item, dict):
            continue
        position = _mapping_payload(cast(Mapping[str, object], item).get("position"))
        coin = _optional_text(position.get("coin"))
        if coin is None:
            continue
        positions.append(
            {
                "observed_at": observed_at,
                "coin": coin,
                "size": str(position.get("szi") or "0"),
                "entry_price": _optional_text(position.get("entryPx")),
                "notional_usd": str(_position_exposure_usd(position)),
                "unrealized_pnl_usd": str(position.get("unrealizedPnl") or "0"),
                "source": "exchange_raw_account",
            }
        )
    return sorted(positions, key=lambda row: str(row["coin"]))


def _latest_account_snapshot_query() -> str:
    return """
    SELECT
      observed_at::text,
      raw_payload
    FROM hyperliquid_execution_account_snapshots
    WHERE execution_network = 'testnet'
    ORDER BY observed_at DESC
    LIMIT 1
    """


def _mapping_payload(value: object) -> Mapping[str, object]:
    if isinstance(value, dict):
        return cast(Mapping[str, object], value)
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(loaded, dict):
            return cast(Mapping[str, object], loaded)
    return {}


def _position_exposure_usd(position: Mapping[str, object]) -> Decimal:
    position_value = _optional_decimal(position.get("positionValue"))
    if position_value is not None:
        return abs(position_value)
    size = _optional_decimal(position.get("szi")) or Decimal("0")
    entry_price = _optional_decimal(position.get("entryPx")) or Decimal("0")
    return abs(size * entry_price)


def _optional_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text_value = str(value)
    return text_value if text_value else None


def _json_safe(value: object) -> object:
    if isinstance(value, (datetime, Decimal)):
        return str(value)
    return value


def _ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= Decimal("0"):
        return Decimal("0")
    return (numerator / denominator).quantize(Decimal("0.0001"))
