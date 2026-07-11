"""Operator proof surface for the canonical Torghut trading loop."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Protocol, cast

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.trading.multifactor.status_payloads import (
    LATEST_ATTRIBUTION_SQL,
    LATEST_EXECUTION_INTENT_SQL,
    LATEST_FACTOR_SNAPSHOT_SQL,
    LATEST_FORECAST_SQL,
    LATEST_MULTIFACTOR_RUN_SQL,
    LATEST_PORTFOLIO_TARGET_SQL,
    LATEST_RISK_FORECAST_SQL,
    alpha_model_payload,
    attribution_payload,
    execution_intent_payload,
    portfolio_target_payload,
    risk_forecast_payload,
)
from app.trading.loop_status_positions import (
    managed_exchange_positions,
    position_coin_set,
    raw_account_positions,
    unmanaged_exchange_positions,
)

SCHEMA_VERSION = "torghut.trading-loop-status.v1"
DEFAULT_FRESHNESS_THRESHOLD_SECONDS = 180
DEFAULT_ACCOUNT_FRESHNESS_SECONDS = 300
DEFAULT_MIN_RECENT_FILLS = 3
LOOP_STATUS_QUERY_TIMEOUT_MS = 1_500


def _empty_mapping() -> Mapping[str, object]:
    return {}


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
    latest_multifactor_run: Mapping[str, object] = field(default_factory=_empty_mapping)
    latest_factor_snapshot: Mapping[str, object] = field(default_factory=_empty_mapping)
    latest_forecast: Mapping[str, object] = field(default_factory=_empty_mapping)
    latest_risk_forecast: Mapping[str, object] = field(default_factory=_empty_mapping)
    latest_portfolio_target: Mapping[str, object] = field(
        default_factory=_empty_mapping
    )
    latest_execution_intent: Mapping[str, object] = field(
        default_factory=_empty_mapping
    )
    latest_attribution: Mapping[str, object] = field(default_factory=_empty_mapping)


@dataclass(frozen=True)
class LoopStatusOptions:
    """Operator thresholds and runtime mode for loop status assembly."""

    generated_at: datetime
    trading_mode: str = "paper"
    trading_enabled: bool = False
    min_recent_fills: int = DEFAULT_MIN_RECENT_FILLS
    freshness_threshold_seconds: int = DEFAULT_FRESHNESS_THRESHOLD_SECONDS
    account_freshness_seconds: int = DEFAULT_ACCOUNT_FRESHNESS_SECONDS
    configured_symbols: Sequence[str] = ()


@dataclass(frozen=True)
class LoopProofSummary:
    """Reduced proof facts that decide restored versus blocked."""

    query_errors: Sequence[str]
    market_feature_at: datetime | None
    market_selected_symbol: str | None
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
    managed_exchange_positions: Sequence[Mapping[str, object]]
    unmanaged_exchange_positions: Sequence[Mapping[str, object]]
    positions_reconciled: bool
    stale_open_order_count: int
    unexpected_live_orders: int
    unexpected_live_events: int
    multifactor_run_present: bool
    factor_snapshot_present: bool
    alpha_forecast_present: bool
    risk_forecast_present: bool
    portfolio_target_present: bool
    execution_intent_present: bool
    alpha_edge_above_cost: bool
    target_notional_positive: bool

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
        latest_multifactor_run=_safe_one(
            session, "latest_multifactor_run", LATEST_MULTIFACTOR_RUN_SQL, errors
        ),
        latest_factor_snapshot=_safe_one(
            session, "latest_factor_snapshot", LATEST_FACTOR_SNAPSHOT_SQL, errors
        ),
        latest_forecast=_safe_one(
            session, "latest_forecast", LATEST_FORECAST_SQL, errors
        ),
        latest_risk_forecast=_safe_one(
            session, "latest_risk_forecast", LATEST_RISK_FORECAST_SQL, errors
        ),
        latest_portfolio_target=_safe_one(
            session, "latest_portfolio_target", LATEST_PORTFOLIO_TARGET_SQL, errors
        ),
        latest_execution_intent=_safe_one(
            session, "latest_execution_intent", LATEST_EXECUTION_INTENT_SQL, errors
        ),
        latest_attribution=_safe_one(
            session, "latest_attribution", LATEST_ATTRIBUTION_SQL, errors
        ),
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
        "operator_approval": _operator_approval_payload(),
        "proof_trading": _proof_trading_payload(),
        "market_data": _market_data_payload(rows, options, summary),
        "algorithm": _algorithm_payload(rows, summary),
        "alpha_model": alpha_model_payload(rows, summary),
        "risk_forecast": risk_forecast_payload(rows, summary),
        "portfolio_target": portfolio_target_payload(rows, summary),
        "execution_intent": execution_intent_payload(rows, summary),
        "decision": _decision_payload(rows),
        "submitted_order": _submitted_order_payload(rows, summary),
        "exchange_order_state": _exchange_order_state_payload(rows, summary),
        "fills": _fills_payload(rows, options, summary),
        "position": _position_payload(rows, options, summary),
        "pnl_snapshot": dict(rows.performance),
        "attribution": attribution_payload(rows),
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
    market_source = _market_data_source(rows)
    latest_feature_at = _datetime_value(market_source.get("feature_event_ts"))
    feature_source_lag_seconds = _optional_int(market_source.get("source_lag_seconds"))
    feature_quote_lag_seconds = _optional_int(market_source.get("quote_lag_seconds"))
    latest_account_at = _datetime_value(rows.latest_account.get("observed_at"))
    market_lag_seconds = _age_seconds(options.generated_at, latest_feature_at)
    account_lag_seconds = _age_seconds(options.generated_at, latest_account_at)
    raw_exchange_positions = raw_account_positions(rows.latest_account)
    unexpected_live_orders = _int(rows.unexpected_live_alpaca.get("orders_24h"))
    unexpected_live_events = _int(rows.unexpected_live_alpaca.get("events_24h"))
    expected_return_bps = _optional_decimal(
        rows.latest_forecast.get("expected_return_bps")
    )
    expected_cost_bps = _optional_decimal(
        rows.latest_portfolio_target.get("expected_cost_bps")
    )
    risk_buffer_bps = _optional_decimal(
        rows.latest_portfolio_target.get("risk_buffer_bps")
    )
    target_notional_usd = _optional_decimal(
        rows.latest_portfolio_target.get("target_notional_usd")
    )
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
    managed_raw_positions = managed_exchange_positions(
        rows.positions,
        raw_exchange_positions,
        _selected_symbols(rows),
        options.configured_symbols,
    )
    return LoopProofSummary(
        query_errors=tuple(rows.query_errors),
        market_feature_at=latest_feature_at,
        market_selected_symbol=_optional_text(market_source.get("selected_symbol")),
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
        managed_exchange_positions=tuple(managed_raw_positions),
        unmanaged_exchange_positions=tuple(
            unmanaged_exchange_positions(raw_exchange_positions, managed_raw_positions)
        ),
        positions_reconciled=account_fresh
        and position_coin_set(rows.positions)
        == position_coin_set(managed_raw_positions),
        stale_open_order_count=len(rows.stale_open_orders),
        unexpected_live_orders=unexpected_live_orders,
        unexpected_live_events=unexpected_live_events,
        multifactor_run_present=bool(rows.latest_multifactor_run),
        factor_snapshot_present=bool(rows.latest_factor_snapshot),
        alpha_forecast_present=bool(rows.latest_forecast),
        risk_forecast_present=bool(rows.latest_risk_forecast),
        portfolio_target_present=bool(rows.latest_portfolio_target),
        execution_intent_present=bool(rows.latest_execution_intent),
        alpha_edge_above_cost=(
            expected_return_bps is not None
            and expected_cost_bps is not None
            and risk_buffer_bps is not None
            and abs(expected_return_bps) > expected_cost_bps + risk_buffer_bps
        ),
        target_notional_positive=(
            target_notional_usd is not None and target_notional_usd > Decimal("0")
        ),
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


def _operator_approval_payload() -> dict[str, object]:
    return {
        "scope": "testnet_only",
        "live_capital_approved": False,
        "reason": "operator_approved_testnet_proof_trading_only",
    }


def _proof_trading_payload() -> dict[str, object]:
    return {
        "allowed": True,
        "lane": "hyperliquid_testnet",
        "reason": "testnet_proof_trading_operator_approved",
    }


def _market_data_payload(
    rows: LoopStatusRows,
    options: LoopStatusOptions,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "fresh": summary.market_data_fresh,
        "latest_feature_at": _iso(summary.market_feature_at),
        "lag_seconds": summary.market_lag_seconds,
        "source_lag_seconds": summary.feature_source_lag_seconds,
        "quote_lag_seconds": summary.feature_quote_lag_seconds,
        "freshness_threshold_seconds": options.freshness_threshold_seconds,
        "selected_symbol": summary.market_selected_symbol,
    }


def _algorithm_payload(
    rows: LoopStatusRows,
    summary: LoopProofSummary,
) -> dict[str, object]:
    return {
        "name": "generic_multifactor_apm_v1",
        "run_id": _optional_text(rows.latest_forecast.get("run_id"))
        or _optional_text(rows.latest_execution_intent.get("run_id"))
        or _optional_text(rows.latest_multifactor_run.get("id")),
        "asset_key": _optional_text(rows.latest_factor_snapshot.get("asset_key"))
        or _optional_text(rows.latest_execution_intent.get("asset_key")),
        "factor_snapshot_present": summary.factor_snapshot_present,
        "forecast_present": summary.alpha_forecast_present,
        "risk_present": summary.risk_forecast_present,
        "target_present": summary.portfolio_target_present,
        "intent_present": summary.execution_intent_present,
        "latest_order_id": _optional_text(rows.latest_order.get("exchange_order_id")),
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
        "managed_exchange_positions_count": len(summary.managed_exchange_positions),
        "unmanaged_exchange_positions_count": len(summary.unmanaged_exchange_positions),
        "positions": [dict(row) for row in rows.positions],
        "exchange_raw_positions": [dict(row) for row in summary.raw_exchange_positions],
        "managed_exchange_positions": [
            dict(row) for row in summary.managed_exchange_positions
        ],
        "unmanaged_exchange_positions": [
            dict(row) for row in summary.unmanaged_exchange_positions
        ],
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
        "multifactor_run_present": summary.multifactor_run_present,
        "multifactor_factor_snapshot_present": summary.factor_snapshot_present,
        "multifactor_forecast_present": summary.alpha_forecast_present,
        "multifactor_risk_forecast_present": summary.risk_forecast_present,
        "multifactor_portfolio_target_present": summary.portfolio_target_present,
        "multifactor_execution_intent_present": summary.execution_intent_present,
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
        _apply_query_timeout(session)
        row = session.execute(text(query)).mappings().first()
    except SQLAlchemyError as exc:
        _recover_failed_query(session)
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
        _apply_query_timeout(session)
        rows = session.execute(text(query)).mappings().all()
    except SQLAlchemyError as exc:
        _recover_failed_query(session)
        errors.append(f"{name}_query_failed:{type(exc).__name__}")
        return []
    return [_json_safe_mapping(row) for row in rows]


def _apply_query_timeout(session: QuerySession) -> None:
    try:
        session.execute(
            text(f"SET LOCAL statement_timeout = '{LOOP_STATUS_QUERY_TIMEOUT_MS}ms'")
        )
    except SQLAlchemyError:
        _recover_failed_query(session)


def _recover_failed_query(session: QuerySession) -> None:
    rollback = getattr(session, "rollback", None)
    if callable(rollback):
        rollback()


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
    if not summary.multifactor_run_present:
        blockers.append("multifactor_run_missing")
    if not summary.factor_snapshot_present:
        blockers.append("multifactor_factor_snapshot_missing")
    if not summary.alpha_forecast_present:
        blockers.append("multifactor_alpha_forecast_missing")
    if not summary.risk_forecast_present:
        blockers.append("multifactor_risk_forecast_missing")
    if not summary.portfolio_target_present:
        blockers.append("multifactor_portfolio_target_missing")
    if not summary.execution_intent_present:
        blockers.append("multifactor_execution_intent_missing")
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


def _market_data_source(rows: LoopStatusRows) -> dict[str, object]:
    if rows.latest_execution_intent and rows.latest_factor_snapshot:
        latest_feature_at = rows.latest_factor_snapshot.get(
            "source_event_at"
        ) or rows.latest_signal.get("feature_event_ts")
        return {
            "feature_event_ts": latest_feature_at,
            "source_lag_seconds": rows.latest_factor_snapshot.get("source_lag_seconds"),
            "quote_lag_seconds": rows.latest_factor_snapshot.get("quote_lag_seconds"),
            "selected_symbol": _optional_text(rows.latest_factor_snapshot.get("symbol"))
            or _symbol_from_asset_key(rows.latest_factor_snapshot.get("asset_key")),
        }
    selected_symbols = _selected_symbols(rows)
    return {
        "feature_event_ts": rows.latest_signal.get("feature_event_ts"),
        "source_lag_seconds": rows.latest_signal.get("feature_source_lag_seconds"),
        "quote_lag_seconds": rows.latest_signal.get("feature_quote_lag_seconds"),
        "selected_symbol": selected_symbols[0] if selected_symbols else None,
    }


def _symbol_from_asset_key(value: object) -> str | None:
    text = _optional_text(value)
    if text is None:
        return None
    return text.rsplit(":", maxsplit=1)[-1]


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


def _optional_decimal(value: object) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return Decimal(str(value))
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
  AND exchange_order_id IS NOT NULL
  AND status IN ('accepted', 'filled')
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
