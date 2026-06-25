"""Operator proof surface for the canonical Torghut trading loop."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Protocol, cast

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

SCHEMA_VERSION = "torghut.trading-loop-status.v1"
DEFAULT_FRESHNESS_THRESHOLD_SECONDS = 180
DEFAULT_ACCOUNT_FRESHNESS_SECONDS = 300
DEFAULT_MIN_RECENT_FILLS = 3


class QuerySession(Protocol):
    """Minimal SQLAlchemy session surface used by loop-status queries."""

    def execute(
        self,
        statement: Any,
        parameters: Any | None = None,
    ) -> Any:
        """Execute a SQL statement and return a SQLAlchemy result."""


@dataclass(frozen=True)
class LoopStatusRows:
    """Raw rows needed to assemble the operator loop status."""

    latest_cycle: Mapping[str, object]
    latest_signal: Mapping[str, object]
    latest_order: Mapping[str, object]
    counts_24h: Mapping[str, object]
    fill_summary: Mapping[str, object]
    latest_fill: Mapping[str, object]
    latest_account: Mapping[str, object]
    positions: Sequence[Mapping[str, object]]
    performance: Mapping[str, object]
    stale_open_orders: Sequence[Mapping[str, object]]
    unexpected_live_alpaca: Mapping[str, object]
    query_errors: Sequence[str]


@dataclass(frozen=True)
class LoopStatusOptions:
    """Operator thresholds and runtime mode for loop status assembly."""

    generated_at: datetime
    trading_mode: str = "paper"
    trading_enabled: bool = False
    min_recent_fills: int = DEFAULT_MIN_RECENT_FILLS
    freshness_threshold_seconds: int = DEFAULT_FRESHNESS_THRESHOLD_SECONDS
    account_freshness_seconds: int = DEFAULT_ACCOUNT_FRESHNESS_SECONDS


@dataclass(frozen=True)
class LoopProofSummary:
    """Reduced proof facts that decide restored versus blocked."""

    query_errors: Sequence[str]
    market_lag_seconds: int | None
    feature_source_lag_seconds: int | None
    feature_quote_lag_seconds: int | None
    account_lag_seconds: int | None
    market_data_fresh: bool
    account_fresh: bool
    latest_order_present: bool
    exchange_ack_seen: bool
    recent_fill_count: int
    position_count: int
    raw_exchange_positions: Sequence[Mapping[str, object]]
    positions_reconciled: bool
    stale_open_order_count: int
    unexpected_live_orders: int
    unexpected_live_events: int

    @property
    def unexpected_live_total(self) -> int:
        return self.unexpected_live_orders + self.unexpected_live_events


def build_trading_loop_status(
    session: QuerySession,
    *,
    options: LoopStatusOptions | None = None,
) -> dict[str, object]:
    """Read bounded runtime/accounting proof and return one operator payload."""

    resolved_options = options or LoopStatusOptions(
        generated_at=datetime.now(timezone.utc)
    )
    rows = load_trading_loop_status_rows(session)
    return assemble_trading_loop_status(
        rows=rows,
        options=resolved_options,
    )


def load_trading_loop_status_rows(session: QuerySession) -> LoopStatusRows:
    """Load every proof row with independent bounded queries."""

    errors: list[str] = []
    return LoopStatusRows(
        latest_cycle=_safe_one(session, "latest_cycle", _LATEST_CYCLE_SQL, errors),
        latest_signal=_safe_one(session, "latest_signal", _LATEST_SIGNAL_SQL, errors),
        latest_order=_safe_one(session, "latest_order", _LATEST_ORDER_SQL, errors),
        counts_24h=_safe_one(session, "counts_24h", _COUNTS_24H_SQL, errors),
        fill_summary=_safe_one(session, "fill_summary", _FILL_SUMMARY_SQL, errors),
        latest_fill=_safe_one(session, "latest_fill", _LATEST_FILL_SQL, errors),
        latest_account=_safe_one(
            session, "latest_account", _LATEST_ACCOUNT_SQL, errors
        ),
        positions=_safe_rows(session, "positions", _POSITIONS_SQL, errors),
        performance=_safe_one(session, "performance", _PERFORMANCE_SQL, errors),
        stale_open_orders=_safe_rows(
            session,
            "stale_open_orders",
            _STALE_OPEN_ORDERS_SQL,
            errors,
        ),
        unexpected_live_alpaca=_safe_one(
            session,
            "unexpected_live_alpaca",
            _UNEXPECTED_LIVE_ALPACA_SQL,
            errors,
        ),
        query_errors=tuple(errors),
    )


def assemble_trading_loop_status(
    *,
    rows: LoopStatusRows,
    options: LoopStatusOptions,
) -> dict[str, object]:
    """Assemble the loop proof contract from already-loaded rows."""

    summary = _proof_summary(rows, options)
    blockers = _blockers(summary, min_recent_fills=options.min_recent_fills)
    restored = not blockers

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": options.generated_at.isoformat(),
        "lane": "hyperliquid_testnet",
        "restored": restored,
        "status": "restored" if restored else "blocked",
        "blocker_reasons": blockers,
        "runtime": _runtime_payload(rows, options, summary),
        "market_data": _market_data_payload(rows, options, summary),
        "decision": _decision_payload(rows),
        "submitted_order": _submitted_order_payload(rows, summary),
        "exchange_order_state": _exchange_order_state_payload(rows, summary),
        "fills": _fills_payload(rows, options, summary),
        "position": _position_payload(rows, options, summary),
        "pnl_snapshot": dict(rows.performance),
        "database": _database_payload(rows, summary),
        "stale_open_orders": _stale_open_orders_payload(rows, summary),
        "alpaca_guard": _alpaca_guard_payload(summary),
        "proof_lane": {
            "hot_path_authority": False,
            "status": "offline_diagnostic_only",
            "ignored_for_runtime_restore": True,
        },
        "query_errors": list(summary.query_errors),
    }


def _proof_summary(
    rows: LoopStatusRows, options: LoopStatusOptions
) -> LoopProofSummary:
    latest_feature_at = _datetime_value(rows.latest_signal.get("feature_event_ts"))
    feature_source_lag_seconds = _optional_int(
        rows.latest_signal.get("feature_source_lag_seconds")
    )
    feature_quote_lag_seconds = _optional_int(
        rows.latest_signal.get("feature_quote_lag_seconds")
    )
    latest_account_at = _datetime_value(rows.latest_account.get("observed_at"))
    market_lag_seconds = _age_seconds(options.generated_at, latest_feature_at)
    account_lag_seconds = _age_seconds(options.generated_at, latest_account_at)
    raw_exchange_positions = _raw_account_positions(rows.latest_account)
    unexpected_live_orders = _int(rows.unexpected_live_alpaca.get("orders_24h"))
    unexpected_live_events = _int(rows.unexpected_live_alpaca.get("events_24h"))
    market_data_fresh = (
        _fresh_enough(
            market_lag_seconds,
            threshold_seconds=options.freshness_threshold_seconds,
        )
        and _fresh_enough(
            feature_source_lag_seconds,
            threshold_seconds=options.freshness_threshold_seconds,
        )
        and _fresh_enough(
            feature_quote_lag_seconds,
            threshold_seconds=options.freshness_threshold_seconds,
        )
    )
    account_fresh = _fresh_enough(
        account_lag_seconds,
        threshold_seconds=options.account_freshness_seconds,
    )
    return LoopProofSummary(
        query_errors=tuple(rows.query_errors),
        market_lag_seconds=market_lag_seconds,
        feature_source_lag_seconds=feature_source_lag_seconds,
        feature_quote_lag_seconds=feature_quote_lag_seconds,
        account_lag_seconds=account_lag_seconds,
        market_data_fresh=market_data_fresh,
        account_fresh=account_fresh,
        latest_order_present=bool(rows.latest_order),
        exchange_ack_seen=bool(
            _optional_text(rows.latest_order.get("exchange_order_id"))
        ),
        recent_fill_count=_int(rows.fill_summary.get("fills_24h")),
        position_count=len(rows.positions),
        raw_exchange_positions=tuple(raw_exchange_positions),
        positions_reconciled=account_fresh
        and _position_coin_set(rows.positions)
        == _position_coin_set(raw_exchange_positions),
        stale_open_order_count=len(rows.stale_open_orders),
        unexpected_live_orders=unexpected_live_orders,
        unexpected_live_events=unexpected_live_events,
    )


def _runtime_payload(
    rows: LoopStatusRows,
    options: LoopStatusOptions,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "status": "ok" if not summary.query_errors else "degraded",
        "trading_mode": options.trading_mode,
        "trading_enabled": options.trading_enabled,
        "live_capital": {
            "allowed": False,
            "reason": "explicit_operator_approval_required_after_testnet_proof",
        },
        "latest_cycle_at": _iso(_datetime_value(rows.latest_cycle.get("finished_at"))),
        "selected_symbols": _selected_symbols(rows),
    }


def _market_data_payload(
    rows: LoopStatusRows,
    options: LoopStatusOptions,
    summary: LoopProofSummary,
) -> dict[str, object]:
    selected_symbols = _selected_symbols(rows)
    return {
        "fresh": summary.market_data_fresh,
        "latest_feature_at": _iso(
            _datetime_value(rows.latest_signal.get("feature_event_ts"))
        ),
        "lag_seconds": summary.market_lag_seconds,
        "source_lag_seconds": summary.feature_source_lag_seconds,
        "quote_lag_seconds": summary.feature_quote_lag_seconds,
        "freshness_threshold_seconds": options.freshness_threshold_seconds,
        "selected_symbol": selected_symbols[0] if selected_symbols else None,
    }


def _decision_payload(rows: LoopStatusRows) -> dict[str, object]:
    return {
        "present": bool(rows.latest_signal),
        "generated_at": _iso(_datetime_value(rows.latest_signal.get("generated_at"))),
        "coin": _optional_text(rows.latest_signal.get("coin")),
        "action": _optional_text(rows.latest_signal.get("action")),
        "edge_bps": _optional_text(rows.latest_signal.get("edge_bps")),
        "reason": _optional_text(rows.latest_signal.get("reason")),
    }


def _submitted_order_payload(
    rows: LoopStatusRows,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "present": summary.latest_order_present,
        "orders_24h": _int(rows.counts_24h.get("orders_24h")),
        "created_at": _iso(_datetime_value(rows.latest_order.get("created_at"))),
        "coin": _optional_text(rows.latest_order.get("coin")),
        "cloid": _optional_text(rows.latest_order.get("cloid")),
        "side": _optional_text(rows.latest_order.get("side")),
        "status": _optional_text(rows.latest_order.get("status")),
        "notional_usd": _optional_text(rows.latest_order.get("notional_usd")),
    }


def _exchange_order_state_payload(
    rows: LoopStatusRows,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "ack_seen": summary.exchange_ack_seen,
        "exchange_order_id": _optional_text(rows.latest_order.get("exchange_order_id")),
        "status": _optional_text(rows.latest_order.get("status")),
        "rejection_reason": _optional_text(rows.latest_order.get("rejection_reason")),
    }


def _fills_payload(
    rows: LoopStatusRows,
    options: LoopStatusOptions,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "recent_count": summary.recent_fill_count,
        "required_recent_fills": options.min_recent_fills,
        "latest": _latest_fill_payload(rows.latest_fill),
        "summary": dict(rows.fill_summary),
    }


def _position_payload(
    rows: LoopStatusRows,
    options: LoopStatusOptions,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "account_snapshot_fresh": summary.account_fresh,
        "account_observed_at": _iso(
            _datetime_value(rows.latest_account.get("observed_at"))
        ),
        "account_lag_seconds": summary.account_lag_seconds,
        "account_freshness_seconds": options.account_freshness_seconds,
        "reconciled": summary.positions_reconciled,
        "positions_count": summary.position_count,
        "exchange_raw_positions_count": len(summary.raw_exchange_positions),
        "positions": [dict(row) for row in rows.positions],
        "exchange_raw_positions": [dict(row) for row in summary.raw_exchange_positions],
    }


def _database_payload(
    rows: LoopStatusRows,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "cycles_24h": _int(rows.counts_24h.get("cycles_24h")),
        "signals_24h": _int(rows.counts_24h.get("signals_24h")),
        "orders_24h": _int(rows.counts_24h.get("orders_24h")),
        "fills_24h": summary.recent_fill_count,
        "account_snapshots_24h": _int(rows.counts_24h.get("account_snapshots_24h")),
        "positions_current": summary.position_count,
    }


def _stale_open_orders_payload(
    rows: LoopStatusRows,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "count": summary.stale_open_order_count,
        "orders": [dict(row) for row in rows.stale_open_orders],
    }


def _alpaca_guard_payload(summary: LoopProofSummary) -> dict[str, object]:
    return {
        "unexpected_live_order_count_24h": summary.unexpected_live_total,
        "execution_rows_24h": summary.unexpected_live_orders,
        "order_event_rows_24h": summary.unexpected_live_events,
        "status": "ok" if summary.unexpected_live_total == 0 else "blocked",
    }


def _safe_one(
    session: QuerySession,
    name: str,
    query: str,
    errors: list[str],
) -> dict[str, object]:
    try:
        row = session.execute(text(query)).mappings().first()
    except SQLAlchemyError as exc:
        errors.append(f"{name}_query_failed:{type(exc).__name__}")
        return {}
    return _json_safe_mapping(row) if row is not None else {}


def _safe_rows(
    session: QuerySession,
    name: str,
    query: str,
    errors: list[str],
) -> list[dict[str, object]]:
    try:
        rows = session.execute(text(query)).mappings().all()
    except SQLAlchemyError as exc:
        errors.append(f"{name}_query_failed:{type(exc).__name__}")
        return []
    return [_json_safe_mapping(row) for row in rows]


def _json_safe_mapping(row: Mapping[str, object]) -> dict[str, object]:
    return {str(key): _json_safe(value) for key, value in row.items()}


def _blockers(
    summary: LoopProofSummary,
    *,
    min_recent_fills: int,
) -> list[str]:
    blockers = list(summary.query_errors)
    if not summary.market_data_fresh:
        blockers.append("hyperliquid_market_data_not_fresh")
    if not summary.latest_order_present:
        blockers.append("hyperliquid_order_submission_missing")
    if not summary.exchange_ack_seen:
        blockers.append("hyperliquid_exchange_order_ack_missing")
    if summary.recent_fill_count < min_recent_fills:
        blockers.append("hyperliquid_recent_fills_below_floor")
    if not summary.account_fresh:
        blockers.append("hyperliquid_account_snapshot_not_fresh")
    if not summary.positions_reconciled:
        blockers.append("hyperliquid_position_reconciliation_missing")
    if summary.stale_open_order_count > 0:
        blockers.append("hyperliquid_stale_open_orders_present")
    if summary.unexpected_live_total > 0:
        blockers.append("unexpected_live_alpaca_orders_present")
    return blockers


def _latest_fill_payload(row: Mapping[str, object]) -> dict[str, object]:
    if not row:
        return {"present": False}
    return {
        "present": True,
        "event_ts": _iso(_datetime_value(row.get("event_ts"))),
        "coin": _optional_text(row.get("coin")),
        "fill_hash": _optional_text(row.get("fill_hash")),
        "exchange_order_id": _optional_text(row.get("exchange_order_id")),
        "side": _optional_text(row.get("side")),
        "notional_usd": _optional_text(row.get("notional_usd")),
        "fee_usd": _optional_text(row.get("fee_usd")),
        "closed_pnl_usd": _optional_text(row.get("closed_pnl_usd")),
    }


def _raw_account_positions(
    account_row: Mapping[str, object],
) -> list[dict[str, object]]:
    payload = _mapping_payload(account_row.get("raw_payload"))
    raw_positions = _account_position_rows(payload)
    positions: list[dict[str, object]] = []
    for raw_position in raw_positions:
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


def _position_coin_set(rows: Sequence[Mapping[str, object]]) -> set[str]:
    return {
        coin for row in rows if (coin := _optional_text(row.get("coin"))) is not None
    }


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


def _datetime_value(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _ensure_aware(value)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return _ensure_aware(parsed)
    return None


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _age_seconds(now: datetime, value: datetime | None) -> int | None:
    if value is None:
        return None
    seconds = int((now - value).total_seconds())
    return max(seconds, 0)


def _fresh_enough(age_seconds: int | None, *, threshold_seconds: int) -> bool:
    return age_seconds is not None and age_seconds <= threshold_seconds


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if value is None:
        return 0
    try:
        return int(Decimal(str(value)))
    except Exception:
        return 0


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(Decimal(str(value)))
    except Exception:
        return None


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text_value = str(value).strip()
    return text_value or None


def _string_list(value: object) -> list[str]:
    if isinstance(value, str):
        loaded = _loads_json(value)
        if loaded is not None:
            return _string_list(loaded)
        return [value] if value else []
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        items = cast(Sequence[object], value)
        return [str(item) for item in items if str(item).strip()]
    return []


def _selected_symbols(rows: LoopStatusRows) -> list[str]:
    return _string_list(rows.latest_cycle.get("selected_coins"))


def _loads_json(value: str) -> object | None:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _json_safe(value: object) -> object:
    if isinstance(value, datetime):
        return _ensure_aware(value).isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


_LATEST_CYCLE_SQL = """
SELECT
  finished_at,
  selected_coins,
  signals_written,
  orders_submitted,
  orders_cancelled,
  error
FROM hyperliquid_execution_cycles
ORDER BY finished_at DESC
LIMIT 1
"""

_LATEST_SIGNAL_SQL = """
SELECT
  generated_at,
  feature_event_ts,
  features ->> 'source_lag_seconds' AS feature_source_lag_seconds,
  features ->> 'quote_lag_seconds' AS feature_quote_lag_seconds,
  coin,
  action,
  edge_bps::text,
  reason
FROM hyperliquid_execution_signals
ORDER BY generated_at DESC
LIMIT 1
"""

_LATEST_ORDER_SQL = """
SELECT
  created_at,
  coin,
  cloid,
  exchange_order_id,
  side,
  status,
  rejection_reason,
  notional_usd::text
FROM hyperliquid_execution_orders
WHERE execution_network = 'testnet'
ORDER BY created_at DESC
LIMIT 1
"""

_COUNTS_24H_SQL = """
SELECT
  (SELECT count(*) FROM hyperliquid_execution_cycles
   WHERE finished_at >= now() - interval '24 hours')::int AS cycles_24h,
  (SELECT count(*) FROM hyperliquid_execution_signals
   WHERE generated_at >= now() - interval '24 hours')::int AS signals_24h,
  (SELECT count(*) FROM hyperliquid_execution_orders
   WHERE execution_network = 'testnet'
     AND created_at >= now() - interval '24 hours')::int AS orders_24h,
  (SELECT count(*) FROM hyperliquid_execution_fills
   WHERE execution_network = 'testnet'
     AND event_ts >= now() - interval '24 hours')::int AS fills_24h,
  (SELECT count(*) FROM hyperliquid_execution_account_snapshots
   WHERE execution_network = 'testnet'
     AND observed_at >= now() - interval '24 hours')::int AS account_snapshots_24h
"""

_FILL_SUMMARY_SQL = """
SELECT
  count(*)::int AS fills_24h,
  COALESCE(sum(notional_usd), 0)::text AS notional_usd_24h,
  COALESCE(sum(fee_usd), 0)::text AS fees_usd_24h,
  COALESCE(sum(closed_pnl_usd - fee_usd), 0)::text AS net_pnl_after_fees_usd_24h
FROM hyperliquid_execution_fills
WHERE execution_network = 'testnet'
  AND event_ts >= now() - interval '24 hours'
"""

_LATEST_FILL_SQL = """
SELECT
  event_ts,
  coin,
  fill_hash,
  exchange_order_id,
  side,
  notional_usd::text,
  fee_usd::text,
  closed_pnl_usd::text
FROM hyperliquid_execution_fills
WHERE execution_network = 'testnet'
ORDER BY event_ts DESC
LIMIT 1
"""

_LATEST_ACCOUNT_SQL = """
SELECT
  observed_at,
  account_value_usd::text,
  withdrawable_usd::text,
  gross_exposure_usd::text,
  raw_payload
FROM hyperliquid_execution_account_snapshots
WHERE execution_network = 'testnet'
ORDER BY observed_at DESC
LIMIT 1
"""

_POSITIONS_SQL = """
SELECT
  observed_at,
  coin,
  size::text,
  entry_price::text,
  notional_usd::text,
  unrealized_pnl_usd::text
FROM hyperliquid_execution_positions
WHERE execution_network = 'testnet'
ORDER BY coin
LIMIT 100
"""

_PERFORMANCE_SQL = """
SELECT
  observed_at,
  fill_count_24h,
  notional_usd_24h::text,
  fees_usd_24h::text,
  net_pnl_after_fees_usd_24h::text,
  max_drawdown_usd_24h::text,
  sample_ready
FROM hyperliquid_execution_performance_snapshots
WHERE execution_network = 'testnet'
ORDER BY observed_at DESC
LIMIT 1
"""

_STALE_OPEN_ORDERS_SQL = """
SELECT
  created_at,
  coin,
  cloid,
  exchange_order_id,
  side,
  status,
  expires_at
FROM hyperliquid_execution_orders
WHERE execution_network = 'testnet'
  AND status IN ('accepted', 'submitted')
  AND expires_at <= now()
ORDER BY expires_at ASC
LIMIT 100
"""

_UNEXPECTED_LIVE_ALPACA_SQL = """
SELECT
  (SELECT count(*)
   FROM executions
   WHERE created_at >= now() - interval '24 hours'
     AND alpaca_account_label ILIKE '%live%')::int AS orders_24h,
  (SELECT count(*)
   FROM execution_order_events
   WHERE COALESCE(event_ts, created_at) >= now() - interval '24 hours'
     AND alpaca_account_label ILIKE '%live%')::int AS events_24h
"""


__all__ = (
    "DEFAULT_ACCOUNT_FRESHNESS_SECONDS",
    "DEFAULT_FRESHNESS_THRESHOLD_SECONDS",
    "DEFAULT_MIN_RECENT_FILLS",
    "LoopStatusOptions",
    "LoopStatusRows",
    "QuerySession",
    "SCHEMA_VERSION",
    "assemble_trading_loop_status",
    "build_trading_loop_status",
    "load_trading_loop_status_rows",
)
