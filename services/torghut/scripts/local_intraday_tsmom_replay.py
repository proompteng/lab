#!/usr/bin/env python3
"""Run a local deterministic intraday TSMOM replay against ClickHouse signals."""

from __future__ import annotations

import argparse
import csv
import hashlib
import http.client
import json
import logging
import os
import subprocess
import time as time_mod
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib import error, parse, request

import yaml
from unittest.mock import patch

from app.models import Strategy
from app.strategies.catalog import StrategyCatalogConfig, _compose_strategy_description
from app.config import settings
from app.trading.costs import CostModelInputs, OrderIntent, TransactionCostModel
from app.trading.decisions import DecisionEngine
from app.trading.discovery.replay_tape import (
    load_replay_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.evaluation_trace import (
    NearMissRecord,
    ReplayFunnelBucket,
    ReplayFunnelReport,
    ReplayTraceRecord,
    StrategyTrace,
)
from app.trading.execution_policy import (
    _near_touch_limit_price,
    _should_keep_market_order_for_high_conviction_entry,
)
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.portfolio import allocator_from_settings, sizer_from_settings
from app.trading.quote_quality import (
    DEFAULT_MAX_EXECUTABLE_SPREAD_BPS,
    DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS,
    DEFAULT_MAX_QUOTE_MID_JUMP_BPS,
    QuoteQualityPolicy,
    QuoteQualityStatus,
    SignalQuoteQualityTracker,
    assess_signal_quote_quality,
)
from app.trading.session_context import (
    SessionContextTracker,
    regular_session_close_utc_for,
    regular_session_open_utc_for,
)
from app.trading.strategy_runtime import StrategyRuntime

logging.getLogger("alembic").setLevel(logging.WARNING)

logging.getLogger("alembic").setLevel(logging.WARNING)

DEFAULT_CHUNK_MINUTES = 10
DEFAULT_START_EQUITY = Decimal("31590.02")
DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS = 30
DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS = 15
logger = logging.getLogger(__name__)
_SHARED_POSITION_OWNER = "__shared__"
_FILL_LATENCY_BUCKETS_MS = (0, 50, 150, 250, 500, 1000)
_FILL_LATENCY_THRESHOLDS_MS = (50, 150, 250)
_EXACT_REPLAY_LEDGER_ROWS_SCHEMA_VERSION = "torghut.exact_replay_ledger.rows.v1"
_REPLAY_LEDGER_ACCOUNT_LABEL = "TORGHUT_REPLAY"
_REPLAY_COST_BASIS = "local_replay_transaction_cost_model"
_REPLAY_ADV_SOURCE = "observed_microbar_notional_by_symbol_day"
_REPLAY_LEDGER_SOURCE = "local_intraday_tsmom_replay"


def _resolve_repo_root(script_path: Path) -> Path:
    resolved = script_path.resolve()
    for candidate in (resolved.parent, *resolved.parents):
        if (candidate / "argocd").is_dir() and (
            candidate / "services" / "torghut"
        ).is_dir():
            return candidate
    for candidate in (resolved.parent, *resolved.parents):
        if (candidate / "app").is_dir() and (candidate / "scripts").is_dir():
            return candidate
    parents = resolved.parents
    return parents[3] if len(parents) > 3 else parents[-1]


_REPO_ROOT = _resolve_repo_root(Path(__file__))


def default_strategy_configmap_path() -> Path:
    if strategy_config_path := os.environ.get("TRADING_STRATEGY_CONFIG_PATH"):
        return Path(strategy_config_path)
    return _REPO_ROOT / "argocd/applications/torghut/strategy-configmap.yaml"


def _position_key(symbol: str, strategy_id: str) -> tuple[str, str]:
    return (symbol.strip().upper(), strategy_id.strip())


def _stable_json_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _file_sha256(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _decimal_text_or_none(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return _decimal_text(value)


@dataclass(frozen=True)
class ReplayConfig:
    strategy_configmap_path: Path
    clickhouse_http_url: str
    clickhouse_username: str | None
    clickhouse_password: str | None
    start_date: date
    end_date: date
    chunk_minutes: int
    flatten_eod: bool
    start_equity: Decimal
    symbols: tuple[str, ...] = ()
    replay_tape_path: Path | None = None
    replay_tape_manifest_path: Path | None = None
    allow_stale_tape: bool = False
    progress_log_interval_seconds: int = DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS
    capture_traces: bool = False
    capture_trace_funnel: bool = False
    capture_exact_replay_ledger: bool = False
    force_position_isolation: bool = False
    max_executable_spread_bps: Decimal = DEFAULT_MAX_EXECUTABLE_SPREAD_BPS
    max_quote_mid_jump_bps: Decimal = DEFAULT_MAX_QUOTE_MID_JUMP_BPS
    max_jump_with_wide_spread_bps: Decimal = DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS
    clickhouse_query_timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS


@dataclass
class PositionState:
    strategy_id: str
    qty: Decimal
    avg_entry_price: Decimal
    opened_at: datetime
    entry_cost_total: Decimal
    decision_at: datetime
    pending_entry: bool = False


@dataclass
class PendingOrder:
    decision: StrategyDecision
    created_at: datetime
    signal: SignalEnvelope


@dataclass(frozen=True)
class ReplayLedgerContext:
    account_label: str
    candidate_id: str
    candidate_identity: dict[str, Any]
    candidate_identity_hash: str
    execution_policy_hash: str
    cost_model_hash: str
    cost_lineage: dict[str, Any]
    cost_lineage_hash: str
    lineage_hash: str
    replay_data_hash: str | None


@dataclass(frozen=True)
class ReplayCostLineage:
    total_cost: Decimal
    notional: Decimal
    adv_notional: Decimal | None
    adv_source: str | None
    participation_rate: Decimal | None
    spread: Decimal | None
    volatility: Decimal | None
    spread_cost_bps: Decimal
    volatility_cost_bps: Decimal
    impact_cost_bps: Decimal
    commission_cost: Decimal
    commission_cost_bps: Decimal
    total_cost_bps: Decimal
    capacity_ok: bool
    warnings: tuple[str, ...]
    max_participation_rate: Decimal
    impact_bps_at_full_participation: Decimal
    impact_participation_exponent: Decimal


@dataclass
class ClosedTrade:
    symbol: str
    strategy_id: str
    decision_at: datetime
    opened_at: datetime
    closed_at: datetime
    qty: Decimal
    entry_price: Decimal
    exit_price: Decimal
    gross_pnl: Decimal
    net_pnl: Decimal
    exit_reason: str


def _ledger_identity(
    *,
    prefix: str,
    decision: StrategyDecision,
    created_at: datetime,
    strategy_id: str,
) -> str:
    payload = {
        "prefix": prefix,
        "strategy_id": strategy_id,
        "symbol": decision.symbol.upper(),
        "created_at": _utc_text(created_at),
        "event_ts": _utc_text(decision.event_ts),
        "action": decision.action,
        "qty": _decimal_text(decision.qty),
        "order_type": decision.order_type,
        "time_in_force": decision.time_in_force,
        "limit_price": _decimal_text_or_none(decision.limit_price),
    }
    digest = _stable_json_hash(payload)
    return f"{prefix}-{uuid.uuid5(uuid.NAMESPACE_URL, digest)}"


def _build_replay_ledger_context(
    *,
    config: ReplayConfig,
    cost_model: TransactionCostModel,
) -> ReplayLedgerContext:
    config_hash = _file_sha256(config.strategy_configmap_path)
    replay_manifest_hash = _file_sha256(config.replay_tape_manifest_path)
    replay_tape_hash = _file_sha256(config.replay_tape_path)
    execution_policy_hash = _stable_json_hash(
        {
            "source": _REPLAY_LEDGER_SOURCE,
            "strategy_configmap_sha256": config_hash,
            "flatten_eod": config.flatten_eod,
            "force_position_isolation": config.force_position_isolation,
            "max_executable_spread_bps": str(config.max_executable_spread_bps),
            "max_quote_mid_jump_bps": str(config.max_quote_mid_jump_bps),
            "max_jump_with_wide_spread_bps": str(config.max_jump_with_wide_spread_bps),
        }
    )
    cost_model_hash = _stable_json_hash(
        {
            "model": cost_model.__class__.__name__,
            "module": cost_model.__class__.__module__,
            "cost_basis": _REPLAY_COST_BASIS,
            "adv_source": _REPLAY_ADV_SOURCE,
            "config": {
                "commission_bps": str(cost_model.config.commission_bps),
                "commission_per_share": str(cost_model.config.commission_per_share),
                "min_commission": str(cost_model.config.min_commission),
                "max_participation_rate": str(cost_model.config.max_participation_rate),
                "impact_bps_at_full_participation": str(
                    cost_model.config.impact_bps_at_full_participation
                ),
                "impact_participation_exponent": str(
                    cost_model.config.impact_participation_exponent
                ),
            },
        }
    )
    cost_lineage_payload = {
        "cost_basis": _REPLAY_COST_BASIS,
        "model": cost_model.__class__.__name__,
        "module": cost_model.__class__.__module__,
        "adv_source": _REPLAY_ADV_SOURCE,
        "fill_adv_notional_required": True,
        "fill_participation_rate_required": True,
        "fill_capacity_warning_contract_required": True,
        "warning_contract": ["missing_adv", "participation_exceeds_max"],
        "config": {
            "commission_bps": str(cost_model.config.commission_bps),
            "commission_per_share": str(cost_model.config.commission_per_share),
            "min_commission": str(cost_model.config.min_commission),
            "max_participation_rate": str(cost_model.config.max_participation_rate),
            "impact_bps_at_full_participation": str(
                cost_model.config.impact_bps_at_full_participation
            ),
            "impact_participation_exponent": str(
                cost_model.config.impact_participation_exponent
            ),
        },
    }
    cost_lineage_hash = _stable_json_hash(cost_lineage_payload)
    lineage_payload = {
        "source": _REPLAY_LEDGER_SOURCE,
        "strategy_configmap_sha256": config_hash,
        "start_date": config.start_date.isoformat(),
        "end_date": config.end_date.isoformat(),
        "symbols": list(config.symbols),
        "chunk_minutes": config.chunk_minutes,
        "replay_tape_sha256": replay_tape_hash,
        "replay_tape_manifest_sha256": replay_manifest_hash,
        "allow_stale_tape": config.allow_stale_tape,
    }
    replay_data_hash = _stable_json_hash(
        {
            "clickhouse_http_url": config.clickhouse_http_url,
            "start_date": config.start_date.isoformat(),
            "end_date": config.end_date.isoformat(),
            "symbols": list(config.symbols),
            "replay_tape_sha256": replay_tape_hash,
            "replay_tape_manifest_sha256": replay_manifest_hash,
        }
    )
    candidate_identity_seed = {
        "source": _REPLAY_LEDGER_SOURCE,
        "strategy_configmap_sha256": config_hash,
        "start_date": config.start_date.isoformat(),
        "end_date": config.end_date.isoformat(),
        "symbols": list(config.symbols),
        "execution_policy_hash": execution_policy_hash,
        "cost_model_hash": cost_model_hash,
        "cost_lineage_hash": cost_lineage_hash,
        "lineage_hash": _stable_json_hash(lineage_payload),
        "replay_data_hash": replay_data_hash,
    }
    candidate_identity_hash = _stable_json_hash(candidate_identity_seed)
    candidate_id = f"exact-replay-{candidate_identity_hash[:24]}"
    candidate_identity = {
        **candidate_identity_seed,
        "candidate_id": candidate_id,
        "candidate_id_source": (
            "sha256(strategy_config,replay_window,symbols,execution_policy,"
            "cost_lineage,lineage,replay_data)"
        ),
        "candidate_identity_hash": candidate_identity_hash,
    }
    return ReplayLedgerContext(
        account_label=_REPLAY_LEDGER_ACCOUNT_LABEL,
        candidate_id=candidate_id,
        candidate_identity=candidate_identity,
        candidate_identity_hash=candidate_identity_hash,
        execution_policy_hash=execution_policy_hash,
        cost_model_hash=cost_model_hash,
        cost_lineage=cost_lineage_payload,
        cost_lineage_hash=cost_lineage_hash,
        lineage_hash=_stable_json_hash(lineage_payload),
        replay_data_hash=replay_data_hash,
    )


def _base_ledger_row(
    *,
    context: ReplayLedgerContext,
    decision: StrategyDecision,
    strategy_id: str,
    decision_id: str,
    order_id: str,
    event_type: str,
    executed_at: datetime,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "event_type": event_type,
        "executed_at": _utc_text(executed_at),
        "account_label": context.account_label,
        "candidate_id": context.candidate_id,
        "candidate_identity_hash": context.candidate_identity_hash,
        "strategy_id": strategy_id,
        "symbol": decision.symbol.upper(),
        "side": decision.action,
        "decision_id": decision_id,
        "order_id": order_id,
        "source": _REPLAY_LEDGER_SOURCE,
        "execution_policy_hash": context.execution_policy_hash,
        "cost_model_hash": context.cost_model_hash,
        "cost_lineage_hash": context.cost_lineage_hash,
        "lineage_hash": context.lineage_hash,
        "replay_data_hash": context.replay_data_hash,
        "order_type": decision.order_type,
        "time_in_force": decision.time_in_force,
    }
    if decision.limit_price is not None:
        row["limit_price"] = _decimal_text(decision.limit_price)
    if decision.rationale:
        row["rationale"] = decision.rationale
    return row


def _append_ledger_submission(
    *,
    rows: list[dict[str, Any]] | None,
    context: ReplayLedgerContext | None,
    decision: StrategyDecision,
    created_at: datetime,
    strategy_id: str,
) -> tuple[str, str]:
    decision_id = _ledger_identity(
        prefix="decision",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    order_id = _ledger_identity(
        prefix="order",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    if rows is None or context is None:
        return decision_id, order_id
    decision_row = _base_ledger_row(
        context=context,
        decision=decision,
        strategy_id=strategy_id,
        decision_id=decision_id,
        order_id=order_id,
        event_type="decision",
        executed_at=created_at,
    )
    decision_row["qty"] = _decimal_text(decision.qty)
    rows.append(decision_row)
    order_row = _base_ledger_row(
        context=context,
        decision=decision,
        strategy_id=strategy_id,
        decision_id=decision_id,
        order_id=order_id,
        event_type="order_submitted",
        executed_at=created_at,
    )
    order_row["submitted_qty"] = _decimal_text(decision.qty)
    rows.append(order_row)
    return decision_id, order_id


def _append_ledger_resolution(
    *,
    rows: list[dict[str, Any]] | None,
    context: ReplayLedgerContext | None,
    decision: StrategyDecision,
    created_at: datetime,
    resolved_at: datetime,
    strategy_id: str,
    event_type: str,
    reason: str | None = None,
) -> None:
    if rows is None or context is None:
        return
    decision_id = _ledger_identity(
        prefix="decision",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    order_id = _ledger_identity(
        prefix="order",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    row = _base_ledger_row(
        context=context,
        decision=decision,
        strategy_id=strategy_id,
        decision_id=decision_id,
        order_id=order_id,
        event_type=event_type,
        executed_at=resolved_at,
    )
    if reason:
        row["reason"] = reason
    rows.append(row)


def _ledger_resolution_event_type(outcome: str) -> str | None:
    if outcome == "filled":
        return None
    if outcome == "replaced":
        return "order_cancelled"
    if outcome == "censored":
        return "order_unfilled"
    if outcome == "rejected":
        return "order_rejected"
    return "order_unfilled"


def _append_ledger_fill(
    *,
    rows: list[dict[str, Any]] | None,
    context: ReplayLedgerContext | None,
    decision: StrategyDecision,
    created_at: datetime,
    filled_at: datetime,
    strategy_id: str,
    filled_qty: Decimal,
    avg_fill_price: Decimal,
    cost_amount: Decimal,
    cost_lineage: ReplayCostLineage | None = None,
) -> None:
    if rows is None or context is None:
        return
    decision_id = _ledger_identity(
        prefix="decision",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    order_id = _ledger_identity(
        prefix="order",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    row = _base_ledger_row(
        context=context,
        decision=decision,
        strategy_id=strategy_id,
        decision_id=decision_id,
        order_id=order_id,
        event_type="fill",
        executed_at=filled_at,
    )
    filled_notional = avg_fill_price * filled_qty
    row.update(
        {
            "filled_qty": _decimal_text(filled_qty),
            "avg_fill_price": _decimal_text(avg_fill_price),
            "filled_notional": _decimal_text(filled_notional),
            "cost_amount": _decimal_text(cost_amount),
            "cost_basis": _REPLAY_COST_BASIS,
            "fill_price_basis": "local_replay_resolved_fill_price",
        }
    )
    if cost_lineage is not None:
        row.update(
            {
                "adv_source": cost_lineage.adv_source,
                "adv_notional": _decimal_text_or_none(cost_lineage.adv_notional),
                "participation_rate": _decimal_text_or_none(
                    cost_lineage.participation_rate
                ),
                "capacity_ok": cost_lineage.capacity_ok,
                "capacity_warning_codes": list(cost_lineage.warnings),
                "spread": _decimal_text_or_none(cost_lineage.spread),
                "volatility": _decimal_text_or_none(cost_lineage.volatility),
                "spread_cost_bps": _decimal_text(cost_lineage.spread_cost_bps),
                "volatility_cost_bps": _decimal_text(cost_lineage.volatility_cost_bps),
                "impact_cost_bps": _decimal_text(cost_lineage.impact_cost_bps),
                "commission_cost": _decimal_text(cost_lineage.commission_cost),
                "commission_cost_bps": _decimal_text(cost_lineage.commission_cost_bps),
                "total_cost_bps": _decimal_text(cost_lineage.total_cost_bps),
                "max_participation_rate": _decimal_text(
                    cost_lineage.max_participation_rate
                ),
                "impact_bps_at_full_participation": _decimal_text(
                    cost_lineage.impact_bps_at_full_participation
                ),
                "impact_participation_exponent": _decimal_text(
                    cost_lineage.impact_participation_exponent
                ),
            }
        )
    rows.append(row)


def _exact_replay_ledger_payload(
    *,
    rows: list[dict[str, Any]],
    config: ReplayConfig,
    context: ReplayLedgerContext,
) -> dict[str, Any]:
    event_type_counts: defaultdict[str, int] = defaultdict(int)
    for row in rows:
        event_type_counts[str(row.get("event_type") or "diagnostic")] += 1
    fill_rows = [row for row in rows if row.get("event_type") == "fill"]
    capacity_warning_counts: defaultdict[str, int] = defaultdict(int)
    fills_with_capacity_warning_contract = 0
    for row in fill_rows:
        warnings = row.get("capacity_warning_codes")
        if isinstance(warnings, list):
            fills_with_capacity_warning_contract += 1
            for warning in warnings:
                if isinstance(warning, str) and warning:
                    capacity_warning_counts[warning] += 1
    return {
        "schema_version": _EXACT_REPLAY_LEDGER_ROWS_SCHEMA_VERSION,
        "source": _REPLAY_LEDGER_SOURCE,
        "account_label": context.account_label,
        "candidate_id": context.candidate_id,
        "candidate_identity": context.candidate_identity,
        "candidate_identity_hash": context.candidate_identity_hash,
        "stage": "replay",
        "promotion_authority": "replay_artifact_only_not_live",
        "window_start": config.start_date.isoformat(),
        "window_end": config.end_date.isoformat(),
        "execution_policy_hash": context.execution_policy_hash,
        "cost_model_hash": context.cost_model_hash,
        "cost_lineage": {
            **context.cost_lineage,
            "cost_lineage_hash": context.cost_lineage_hash,
            "fill_count": len(fill_rows),
            "fills_with_adv_notional": sum(
                1 for row in fill_rows if row.get("adv_notional") not in (None, "")
            ),
            "fills_with_participation_rate": sum(
                1
                for row in fill_rows
                if row.get("participation_rate") not in (None, "")
            ),
            "fills_with_capacity_warning_contract": (
                fills_with_capacity_warning_contract
            ),
            "capacity_warning_counts": dict(sorted(capacity_warning_counts.items())),
        },
        "cost_lineage_hash": context.cost_lineage_hash,
        "lineage_hash": context.lineage_hash,
        "replay_data_hash": context.replay_data_hash,
        "cost_basis": _REPLAY_COST_BASIS,
        "row_count": len(rows),
        "event_type_counts": dict(sorted(event_type_counts.items())),
        "decision_row_count": event_type_counts.get("decision", 0),
        "submitted_order_row_count": event_type_counts.get("order_submitted", 0),
        "fill_row_count": event_type_counts.get("fill", 0),
        "runtime_ledger_rows": rows,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay intraday TSMOM over a week of ClickHouse `ta_signals`.",
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=default_strategy_configmap_path(),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=os.environ.get(
            "TA_CLICKHOUSE_URL",
            "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        ),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument(
        "--clickhouse-password",
        default=os.environ.get(
            "TA_CLICKHOUSE_PASSWORD",
            os.environ.get("CLICKHOUSE_PASSWORD", ""),
        ),
    )
    parser.add_argument("--start-date", default="2026-03-23")
    parser.add_argument("--end-date", default="2026-03-27")
    parser.add_argument("--chunk-minutes", type=int, default=DEFAULT_CHUNK_MINUTES)
    parser.add_argument(
        "--clickhouse-query-timeout-seconds",
        type=int,
        default=int(
            os.environ.get(
                "TA_CLICKHOUSE_QUERY_TIMEOUT_SECONDS",
                str(DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS),
            )
        ),
        help="Per ClickHouse HTTP or kubectl query timeout. Keeps bounded refreshes from hanging.",
    )
    parser.add_argument("--start-equity", default=str(DEFAULT_START_EQUITY))
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated symbol filter applied in the ClickHouse query.",
    )
    parser.add_argument(
        "--replay-tape-path",
        type=Path,
        help="Optional manifest-verified replay tape JSONL/JSONL.GZ to use instead of ClickHouse reads.",
    )
    parser.add_argument(
        "--replay-tape-manifest",
        type=Path,
        help="Optional replay tape manifest path. Defaults to <replay-tape-path>.manifest.json.",
    )
    parser.add_argument(
        "--allow-stale-tape",
        action="store_true",
        help="Allow a replay tape whose manifest does not fully cover the requested date/symbol window.",
    )
    parser.add_argument(
        "--progress-log-seconds",
        type=int,
        default=DEFAULT_PROGRESS_LOG_INTERVAL_SECONDS,
        help="Emit replay heartbeat logs at most once per this many seconds.",
    )
    parser.add_argument(
        "--max-executable-spread-bps",
        default=str(DEFAULT_MAX_EXECUTABLE_SPREAD_BPS),
        help="Reject quotes wider than this when evaluating, filling, or flattening.",
    )
    parser.add_argument(
        "--max-quote-mid-jump-bps",
        default=str(DEFAULT_MAX_QUOTE_MID_JUMP_BPS),
        help="Reject wide-spread quotes whose midpoint jumps beyond this many bps from the last sane price.",
    )
    parser.add_argument(
        "--max-jump-with-wide-spread-bps",
        default=str(DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS),
        help="Minimum spread width required before the jump filter blocks a quote.",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("TORGHUT_REPLAY_LOG_LEVEL", "INFO"),
        help="Python logging level for replay progress logs.",
    )
    parser.add_argument(
        "--trace-output",
        type=Path,
        help="Optional path to write replay trace JSONL.",
    )
    parser.add_argument(
        "--funnel-output",
        type=Path,
        help="Optional path to write replay funnel JSON.",
    )
    parser.add_argument(
        "--near-misses-output",
        type=Path,
        help="Optional path to write replay near-miss JSON.",
    )
    parser.add_argument(
        "--exact-replay-ledger-output",
        type=Path,
        help="Optional path to write exact replay decision/order/fill ledger JSON.",
    )
    parser.add_argument(
        "--collect-traces",
        action="store_true",
        help="Capture per-strategy runtime traces and emit them in payload trace output.",
    )
    parser.add_argument(
        "--collect-trace-funnel",
        action="store_true",
        help="Capture aggregate runtime gate funnel diagnostics without emitting per-row trace records.",
    )
    parser.add_argument("--no-flatten-eod", action="store_true")
    parser.add_argument(
        "--force-position-isolation",
        action="store_true",
        help="Own replay positions by strategy id even when runtime metadata omits isolation.",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _load_strategies(path: Path) -> list[Strategy]:
    root_payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(root_payload, dict):
        raise RuntimeError("strategy_configmap_not_mapping")
    data = root_payload.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("strategy_configmap_missing_data")
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        raise RuntimeError("strategy_configmap_missing_strategies_yaml")
    catalog = StrategyCatalogConfig.model_validate(yaml.safe_load(strategies_yaml))
    strategies: list[Strategy] = []
    for item in catalog.strategies:
        if item.name is None:
            continue
        strategies.append(
            Strategy(
                id=uuid.uuid4(),
                name=item.name,
                description=_compose_strategy_description(item),
                enabled=item.enabled,
                base_timeframe=item.base_timeframe,
                universe_type=item.universe_type,
                universe_symbols=item.universe_symbols or None,
                max_position_pct_equity=item.max_position_pct_equity,
                max_notional_per_trade=item.max_notional_per_trade,
            )
        )
    return strategies


def _http_query(
    *,
    url: str,
    username: str | None,
    password: str | None,
    query: str,
    timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
) -> str:
    timeout_seconds = max(1, int(timeout_seconds))
    if url.startswith("kubectl://"):
        return _kubectl_clickhouse_query(
            url=url,
            username=username,
            password=password,
            query=query,
            timeout_seconds=timeout_seconds,
        )
    body = query.encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(3):
        req = request.Request(url=url.rstrip("/") + "/", data=body, method="POST")
        if username:
            credentials = f"{username}:{password or ''}".encode("utf-8")
            req.add_header("Authorization", "Basic " + _b64(credentials))
        try:
            with request.urlopen(req, timeout=timeout_seconds) as resp:
                return resp.read().decode("utf-8")
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"clickhouse_http_error: {exc.code}: {payload}") from exc
        except http.client.IncompleteRead as exc:
            if exc.partial:
                return exc.partial.decode("utf-8", errors="replace")
            last_error = exc
        except Exception as exc:  # pragma: no cover - retry path for flaky transport
            last_error = exc
        time_mod.sleep(0.5 * (attempt + 1))
    if last_error is None:
        raise RuntimeError("clickhouse_http_query_failed")
    raise RuntimeError(f"clickhouse_http_query_failed: {last_error}") from last_error


def _kubectl_clickhouse_query(
    *,
    url: str,
    username: str | None,
    password: str | None,
    query: str,
    timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
) -> str:
    target = parse.urlparse(url)
    context = parse.unquote(target.netloc).strip()
    parts = [parse.unquote(part) for part in target.path.split("/") if part]
    if len(parts) != 2 or not context:
        raise RuntimeError(
            "clickhouse_kubectl_url_invalid: expected kubectl://<context>/<namespace>/<pod>"
        )
    namespace, pod = parts
    command = [
        "kubectl",
        "--context",
        context,
        "exec",
        "-n",
        namespace,
        pod,
        "--",
        "clickhouse-client",
    ]
    if username:
        command.extend(["--user", username])
    if password:
        command.extend(["--password", password])
    command.extend(["--query", query])
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=max(1, int(timeout_seconds)),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"clickhouse_kubectl_query_timeout:{max(1, int(timeout_seconds))}s"
        ) from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"clickhouse_kubectl_query_failed: {detail[:400]}")
    return result.stdout


def _b64(raw: bytes) -> str:
    import base64

    return base64.b64encode(raw).decode("ascii")


def _iter_signal_rows(config: ReplayConfig) -> Iterable[SignalEnvelope]:
    if config.replay_tape_path is not None:
        yield from _iter_signal_rows_from_replay_tape(config)
        return

    chunk_delta = timedelta(minutes=config.chunk_minutes)
    current_day = config.start_date
    while current_day <= config.end_date:
        if current_day.weekday() >= 5:
            logger.info(
                "replay_day_skip day=%s reason=weekend", current_day.isoformat()
            )
            current_day += timedelta(days=1)
            continue
        session_start = regular_session_open_utc_for(current_day)
        session_end = regular_session_close_utc_for(current_day)
        logger.info(
            "replay_day_fetch_start day=%s session_start=%s session_end=%s",
            current_day.isoformat(),
            session_start.isoformat(),
            session_end.isoformat(),
        )
        chunk_start = session_start
        while chunk_start < session_end:
            chunk_end = min(chunk_start + chunk_delta, session_end)
            fetch_started_at = time_mod.monotonic()
            logger.debug(
                "replay_chunk_fetch_start day=%s chunk_start=%s chunk_end=%s symbol_count=%s",
                current_day.isoformat(),
                chunk_start.isoformat(),
                chunk_end.isoformat(),
                len(config.symbols),
            )
            rows = _fetch_chunk(
                http_url=config.clickhouse_http_url,
                username=config.clickhouse_username,
                password=config.clickhouse_password,
                timeout_seconds=config.clickhouse_query_timeout_seconds,
                chunk_start=chunk_start,
                chunk_end=chunk_end,
                symbols=config.symbols,
            )
            logger.debug(
                "replay_chunk_fetch_done day=%s chunk_start=%s chunk_end=%s rows=%s elapsed_s=%.3f",
                current_day.isoformat(),
                chunk_start.isoformat(),
                chunk_end.isoformat(),
                len(rows),
                time_mod.monotonic() - fetch_started_at,
            )
            rows.sort(key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
            for row in rows:
                yield row
            chunk_start = chunk_end
        current_day += timedelta(days=1)


def _iter_signal_rows_from_replay_tape(
    config: ReplayConfig,
) -> Iterable[SignalEnvelope]:
    if config.replay_tape_path is None:
        return
    tape = load_replay_tape(
        config.replay_tape_path,
        manifest_path=config.replay_tape_manifest_path,
    )
    validation = validate_tape_freshness(
        tape.manifest,
        start_date=config.start_date,
        end_date=config.end_date,
        symbols=config.symbols,
        allow_stale_tape=config.allow_stale_tape,
    )
    logger.info(
        "replay_tape_loaded path=%s rows=%s validation_status=%s stale_override=%s digest=%s",
        config.replay_tape_path,
        tape.manifest.row_count,
        validation["status"],
        validation["stale_override_used"],
        tape.manifest.content_sha256,
    )
    rows = slice_tape_by_window(
        tape.rows,
        start_date=config.start_date,
        end_date=config.end_date,
    )
    rows = slice_tape_by_symbols(rows, symbols=config.symbols)
    for row in rows:
        yield row


def _fetch_chunk(
    *,
    http_url: str,
    username: str | None,
    password: str | None,
    timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
    chunk_start: datetime,
    chunk_end: datetime,
    symbols: tuple[str, ...] = (),
) -> list[SignalEnvelope]:
    symbol_filter = ""
    if symbols:
        rendered_symbols = ", ".join(f"'{symbol}'" for symbol in symbols)
        symbol_filter = f"\n  AND s.symbol IN ({rendered_symbols})"
    query = f"""
SELECT
  s.symbol,
  s.event_ts,
  s.seq,
  toString(s.macd) AS macd,
  toString(s.macd_signal) AS macd_signal,
  toString(s.ema12) AS ema12,
  toString(s.ema26) AS ema26,
  toString(s.rsi14) AS rsi14,
  toString((s.imbalance_bid_px + s.imbalance_ask_px) / 2) AS price,
  toString(s.imbalance_bid_px) AS bid_px,
  toString(s.imbalance_ask_px) AS ask_px,
  toString(s.imbalance_ask_px - s.imbalance_bid_px) AS spread,
  toString(s.imbalance_bid_sz) AS bid_sz,
  toString(s.imbalance_ask_sz) AS ask_sz,
  toString(s.imbalance_spread) AS imbalance_spread,
  toString(s.vwap_session) AS vwap_session,
  toString(s.vwap_w5m) AS vwap_w5m,
  toString(s.vol_realized_w60s) AS vol_realized_w60s,
  toString(m.v) AS microbar_volume
FROM torghut.ta_signals AS s
ANY LEFT JOIN torghut.ta_microbars AS m
  ON s.symbol = m.symbol
  AND s.event_ts = m.event_ts
  AND s.source = m.source
  AND s.window_size = m.window_size
WHERE s.source = 'ta'
  AND s.window_size = 'PT1S'
  AND s.event_ts >= toDateTime64('{chunk_start.strftime("%Y-%m-%d %H:%M:%S")}', 3, 'UTC')
  AND s.event_ts < toDateTime64('{chunk_end.strftime("%Y-%m-%d %H:%M:%S")}', 3, 'UTC')
  {symbol_filter}
  AND isNotNull(s.imbalance_bid_px)
  AND isNotNull(s.imbalance_ask_px)
FORMAT TSVRaw
""".strip()
    raw = _http_query(
        url=http_url,
        username=username,
        password=password,
        timeout_seconds=timeout_seconds,
        query=query,
    )
    reader = csv.reader(raw.splitlines(), delimiter="\t")
    rows: list[SignalEnvelope] = []
    for parts in reader:
        parsed = _parse_signal_row(parts)
        if parsed is not None:
            rows.append(parsed)
    return rows


def _parse_signal_row(parts: list[str]) -> SignalEnvelope | None:
    if len(parts) != 19:
        return None
    (
        symbol,
        event_ts,
        seq,
        macd,
        macd_signal,
        ema12,
        ema26,
        rsi14,
        price,
        bid_px,
        ask_px,
        spread,
        bid_sz,
        ask_sz,
        imbalance_spread,
        vwap_session,
        vwap_w5m,
        vol,
        microbar_volume,
    ) = parts
    price_value = _to_decimal(price)
    bid_px_value = _to_decimal(bid_px)
    ask_px_value = _to_decimal(ask_px)
    spread_value = _to_decimal(spread)
    bid_sz_value = _to_decimal(bid_sz)
    ask_sz_value = _to_decimal(ask_sz)
    imbalance_spread_value = _to_decimal(imbalance_spread)
    payload = {
        "macd": _to_decimal(macd),
        "macd_signal": _to_decimal(macd_signal),
        "ema12": _to_decimal(ema12),
        "ema26": _to_decimal(ema26),
        "rsi14": _to_decimal(rsi14),
        "rsi": _to_decimal(rsi14),
        "price": price_value,
        "vwap_session": _to_decimal(vwap_session),
        "vwap_w5m": _to_decimal(vwap_w5m),
        "vol_realized_w60s": _to_decimal(vol),
        "microbar_volume": _to_decimal(microbar_volume),
        "imbalance_bid_px": bid_px_value,
        "imbalance_ask_px": ask_px_value,
        "imbalance_bid_sz": bid_sz_value,
        "imbalance_ask_sz": ask_sz_value,
        "imbalance_spread": imbalance_spread_value,
        "imbalance": {
            "bid_px": bid_px_value,
            "ask_px": ask_px_value,
            "bid_sz": bid_sz_value,
            "ask_sz": ask_sz_value,
            "spread": imbalance_spread_value
            if imbalance_spread_value is not None
            else spread_value,
        },
        "spread": spread_value,
        "spread_bps": (
            (spread_value / price_value) * Decimal("10000")
            if spread_value is not None and price_value is not None and price_value > 0
            else None
        ),
        "window_size": "PT1S",
        "window_step": "PT1S",
    }
    return SignalEnvelope(
        event_ts=_parse_clickhouse_ts(event_ts),
        symbol=symbol,
        timeframe="1Sec",
        seq=int(seq),
        source="ta",
        payload=payload,
    )


def _parse_clickhouse_ts(value: str) -> datetime:
    normalized = value.replace(" ", "T")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _to_decimal(value: str) -> Decimal | None:
    stripped = value.strip()
    if not stripped or stripped == "\\N":
        return None
    return Decimal(stripped)


def _positions_payload(
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
    pending_orders: dict[tuple[str, str], PendingOrder] | None = None,
    *,
    force_position_isolation: bool = False,
) -> list[dict[str, Any]]:
    projected_positions: dict[tuple[str, str], PositionState] = {
        key: PositionState(
            strategy_id=position.strategy_id,
            qty=position.qty,
            avg_entry_price=position.avg_entry_price,
            opened_at=position.opened_at,
            entry_cost_total=position.entry_cost_total,
            decision_at=position.decision_at,
            pending_entry=position.pending_entry,
        )
        for key, position in positions.items()
    }
    projected_prices = dict(last_prices)

    for pending in (pending_orders or {}).values():
        decision = pending.decision
        symbol = decision.symbol
        owner_strategy_id = _decision_position_owner(
            decision,
            force_position_isolation=force_position_isolation,
        )
        position_key = _position_key(symbol, owner_strategy_id)
        reference_price = (
            decision.limit_price
            or projected_prices.get(symbol)
            or _extract_price(pending.signal)
        )
        projected_prices[symbol] = reference_price
        existing = projected_positions.get(position_key)
        if decision.action == "buy":
            if existing is None:
                projected_positions[position_key] = PositionState(
                    strategy_id=owner_strategy_id,
                    qty=decision.qty,
                    avg_entry_price=reference_price,
                    opened_at=pending.signal.event_ts,
                    entry_cost_total=Decimal("0"),
                    decision_at=pending.created_at,
                    pending_entry=True,
                )
                continue
            if existing.qty < 0:
                remaining_abs_qty = abs(existing.qty) - min(
                    decision.qty, abs(existing.qty)
                )
                if remaining_abs_qty <= 0:
                    projected_positions.pop(position_key, None)
                    continue
                projected_positions[position_key] = PositionState(
                    strategy_id=existing.strategy_id,
                    qty=-remaining_abs_qty,
                    avg_entry_price=existing.avg_entry_price,
                    opened_at=existing.opened_at,
                    entry_cost_total=existing.entry_cost_total,
                    decision_at=existing.decision_at,
                    pending_entry=existing.pending_entry,
                )
                continue
            new_qty = existing.qty + decision.qty
            avg_entry = (
                (existing.avg_entry_price * existing.qty)
                + (reference_price * decision.qty)
            ) / new_qty
            projected_positions[position_key] = PositionState(
                strategy_id=existing.strategy_id,
                qty=new_qty,
                avg_entry_price=avg_entry,
                opened_at=existing.opened_at,
                entry_cost_total=existing.entry_cost_total,
                decision_at=existing.decision_at,
                pending_entry=existing.pending_entry,
            )
            continue
        if existing is None:
            projected_positions[position_key] = PositionState(
                strategy_id=owner_strategy_id,
                qty=-decision.qty,
                avg_entry_price=reference_price,
                opened_at=pending.signal.event_ts,
                entry_cost_total=Decimal("0"),
                decision_at=pending.created_at,
                pending_entry=True,
            )
            continue
        if existing.qty < 0:
            new_abs_qty = abs(existing.qty) + decision.qty
            avg_entry = (
                (existing.avg_entry_price * abs(existing.qty))
                + (reference_price * decision.qty)
            ) / new_abs_qty
            projected_positions[position_key] = PositionState(
                strategy_id=existing.strategy_id,
                qty=-new_abs_qty,
                avg_entry_price=avg_entry,
                opened_at=existing.opened_at,
                entry_cost_total=existing.entry_cost_total,
                decision_at=existing.decision_at,
                pending_entry=existing.pending_entry,
            )
            continue
        remaining_qty = existing.qty - min(decision.qty, existing.qty)
        if remaining_qty <= 0:
            projected_positions.pop(position_key, None)
            continue
        projected_positions[position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=remaining_qty,
            avg_entry_price=existing.avg_entry_price,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total,
            decision_at=existing.decision_at,
            pending_entry=existing.pending_entry,
        )

    payload: list[dict[str, Any]] = []
    for (symbol, _owner_strategy_id), position in projected_positions.items():
        market_price = last_prices.get(symbol, position.avg_entry_price)
        signed_qty = position.qty
        payload.append(
            {
                "symbol": symbol,
                "strategy_id": position.strategy_id,
                "qty": str(abs(signed_qty)),
                "side": "short" if signed_qty < 0 else "long",
                "market_value": str(signed_qty * market_price),
                "avg_entry_price": str(position.avg_entry_price),
                "opened_at": position.opened_at.isoformat(),
                "decision_at": position.decision_at.isoformat(),
                "pending_entry": position.pending_entry,
            }
        )
    return payload


def _position_equity(
    *,
    cash: Decimal,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> Decimal:
    equity = cash
    for (symbol, _owner_strategy_id), position in positions.items():
        equity += position.qty * last_prices.get(symbol, position.avg_entry_price)
    return equity


def _position_exposure(
    *,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> tuple[Decimal, Decimal]:
    gross_exposure = Decimal("0")
    net_exposure = Decimal("0")
    for (symbol, _owner_strategy_id), position in positions.items():
        market_value = position.qty * last_prices.get(symbol, position.avg_entry_price)
        gross_exposure += abs(market_value)
        net_exposure += market_value
    return gross_exposure, net_exposure


def _extract_spread(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("spread")
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_bid(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("imbalance_bid_px")
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_ask(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("imbalance_ask_px")
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_decimal_payload(signal: SignalEnvelope, key: str) -> Decimal | None:
    raw = signal.payload.get(key)
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_price(signal: SignalEnvelope) -> Decimal:
    raw = signal.payload.get("price")
    if isinstance(raw, Decimal):
        return raw
    return Decimal(str(raw))


def _extract_volatility(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("vol_realized_w60s")
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    return Decimal(str(raw))


def _signal_spread_bps(
    *, signal: SignalEnvelope, price: Decimal | None = None
) -> Decimal | None:
    resolved_price = _extract_price(signal) if price is None else price
    if resolved_price <= 0:
        return None
    spread = _extract_spread(signal)
    if spread is None:
        return None
    return (abs(spread) / resolved_price) * Decimal("10000")


def _signal_mid_jump_bps(
    *, price: Decimal, reference_price: Decimal | None
) -> Decimal | None:
    if reference_price is None or reference_price <= 0:
        return None
    return (abs(price - reference_price) / reference_price) * Decimal("10000")


def _quote_quality_status(
    *,
    signal: SignalEnvelope,
    previous_price: Decimal | None,
    config: ReplayConfig,
) -> QuoteQualityStatus:
    return assess_signal_quote_quality(
        signal=signal,
        previous_price=previous_price,
        policy=QuoteQualityPolicy(
            max_executable_spread_bps=config.max_executable_spread_bps,
            max_quote_mid_jump_bps=config.max_quote_mid_jump_bps,
            max_jump_with_wide_spread_bps=config.max_jump_with_wide_spread_bps,
        ),
    )


def _log_quote_skipped(
    *,
    signal: SignalEnvelope,
    status: QuoteQualityStatus,
    has_open_position: bool,
    has_pending_order: bool,
) -> None:
    logger.debug(
        "replay_quote_skipped ts=%s symbol=%s reason=%s spread_bps=%s jump_bps=%s open_position=%s pending_order=%s",
        signal.event_ts.isoformat(),
        signal.symbol,
        status.reason or "unknown",
        _decimal_text(status.spread_bps) if status.spread_bps is not None else "None",
        _decimal_text(status.jump_bps) if status.jump_bps is not None else "None",
        has_open_position,
        has_pending_order,
    )


def _estimate_trade_cost(
    *,
    model: TransactionCostModel,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> Decimal:
    return _estimate_trade_cost_lineage(
        model=model,
        decision=decision,
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    ).total_cost


def _estimate_trade_cost_lineage(
    *,
    model: TransactionCostModel,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> ReplayCostLineage:
    price = _extract_price(signal)
    spread = _extract_spread(signal)
    volatility = _extract_volatility(signal)
    adv, adv_source = _observed_adv_notional_with_source(
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    )
    estimate = model.estimate_costs(
        order=OrderIntent(
            symbol=decision.symbol,
            side=decision.action,
            qty=decision.qty,
            price=price,
            order_type=decision.order_type,
            time_in_force=decision.time_in_force,
        ),
        market=CostModelInputs(
            price=price,
            spread=spread,
            volatility=volatility,
            adv=adv,
        ),
    )
    return ReplayCostLineage(
        total_cost=estimate.total_cost,
        notional=estimate.notional,
        adv_notional=adv,
        adv_source=adv_source,
        participation_rate=estimate.participation_rate,
        spread=spread,
        volatility=volatility,
        spread_cost_bps=estimate.spread_cost_bps,
        volatility_cost_bps=estimate.volatility_cost_bps,
        impact_cost_bps=estimate.impact_cost_bps,
        commission_cost=estimate.commission_cost,
        commission_cost_bps=estimate.commission_cost_bps,
        total_cost_bps=estimate.total_cost_bps,
        capacity_ok=estimate.capacity_ok,
        warnings=tuple(estimate.warnings),
        max_participation_rate=model.config.max_participation_rate,
        impact_bps_at_full_participation=model.config.impact_bps_at_full_participation,
        impact_participation_exponent=model.config.impact_participation_exponent,
    )


def _positive_decimal_mapping_value(
    bucket: Mapping[str, Any] | None, key: str
) -> Decimal | None:
    if bucket is None:
        return None
    raw = bucket.get(key)
    if isinstance(raw, Decimal):
        value = raw
    elif raw is None:
        return None
    else:
        try:
            value = Decimal(str(raw))
        except (ArithmeticError, ValueError):
            return None
    return value if value > 0 else None


def _observed_adv_notional(
    *,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> Decimal | None:
    return _observed_adv_notional_with_source(
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    )[0]


def _observed_adv_notional_with_source(
    *,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> tuple[Decimal | None, str | None]:
    for source, bucket in (
        ("symbol_bucket.daily_adv_notional", symbol_bucket),
        ("day_bucket.daily_adv_notional", day_bucket),
    ):
        value = _positive_decimal_mapping_value(bucket, "daily_adv_notional")
        if value is not None:
            return value, source
    for key in ("daily_adv_notional", "adv_notional", "adv", "avg_dollar_volume"):
        value = _positive_decimal_mapping_value(signal.payload, key)
        if value is not None and value > 0:
            return value, f"signal_payload.{key}"
    return None, None


def _record_decision(stats: dict[str, Any], decision: StrategyDecision) -> None:
    stats["decision_count"] += 1
    symbol_counts = stats.setdefault("decision_symbols", defaultdict(int))
    symbol_counts[decision.symbol] += 1
    order_type_counts = stats.setdefault(
        "decision_count_by_order_type", defaultdict(int)
    )
    order_type_counts[decision.order_type] += 1


def _record_fill_order_type(stats: dict[str, Any], order_type: str) -> None:
    order_type_counts = stats.setdefault("filled_count_by_order_type", defaultdict(int))
    order_type_counts[order_type] += 1


def _order_age_ms(*, created_at: datetime, as_of: datetime) -> int:
    return max(0, int((as_of - created_at).total_seconds() * 1000))


def _latency_bucket(ms: int) -> str:
    if ms <= 0:
        return "0ms"
    lower_bound = 1
    for upper_bound in _FILL_LATENCY_BUCKETS_MS[1:]:
        if ms <= upper_bound:
            return f"{lower_bound}-{upper_bound}ms"
        lower_bound = upper_bound + 1
    return f">{_FILL_LATENCY_BUCKETS_MS[-1]}ms"


def _init_order_lifecycle_stats() -> dict[str, Any]:
    return {
        "submitted_order_count": 0,
        "filled_order_count": 0,
        "pending_censored_count": 0,
        "replaced_pending_count": 0,
        "outcome_counts": defaultdict(int),
        "censor_reason_counts": defaultdict(int),
        "decision_count_by_order_type": defaultdict(int),
        "filled_count_by_order_type": defaultdict(int),
        "submitted_count_by_latency_bucket": defaultdict(int),
        "filled_count_by_latency_bucket": defaultdict(int),
        "filled_latency_ms_samples": [],
        "pending_age_ms_samples": [],
        "spread_bps_samples": [],
        "depth_notional_samples": [],
        "queue_touch_qty_samples": [],
        "queue_touch_notional_samples": [],
        "order_qty_to_touch_qty_ratio_samples": [],
        "max_censored_pending_age_ms": 0,
    }


def _append_decimal_sample(
    stats: dict[str, Any],
    key: str,
    value: Decimal | None,
) -> None:
    if value is None:
        return
    samples = stats.setdefault(key, [])
    samples.append(value)


def _execution_proxy_payload(
    *,
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> dict[str, Decimal]:
    price = _extract_price(signal)
    bid_px = _extract_bid(signal)
    ask_px = _extract_ask(signal)
    bid_qty = _extract_decimal_payload(signal, "imbalance_bid_sz")
    ask_qty = _extract_decimal_payload(signal, "imbalance_ask_sz")
    proxy: dict[str, Decimal] = {}
    spread_bps = _signal_spread_bps(signal=signal, price=price)
    if spread_bps is not None:
        proxy["spread_bps"] = spread_bps
    if (
        bid_px is not None
        and ask_px is not None
        and bid_qty is not None
        and ask_qty is not None
        and bid_px > 0
        and ask_px > 0
        and bid_qty > 0
        and ask_qty > 0
    ):
        proxy["depth_notional"] = (bid_px * bid_qty) + (ask_px * ask_qty)
    normalized_action = decision.action.strip().lower()
    touch_px = ask_px if normalized_action == "buy" else bid_px
    touch_qty = ask_qty if normalized_action == "buy" else bid_qty
    if touch_qty is not None and touch_qty > 0:
        proxy["queue_touch_qty"] = touch_qty
        proxy["order_qty_to_touch_qty_ratio"] = decision.qty / touch_qty
        if touch_px is not None and touch_px > 0:
            proxy["queue_touch_notional"] = touch_px * touch_qty
    return proxy


def _record_order_lifecycle_outcome(
    stats: dict[str, Any],
    *,
    decision: StrategyDecision,
    placement_signal: SignalEnvelope,
    created_at: datetime,
    resolved_at: datetime,
    outcome: str,
    censor_reason: str | None = None,
) -> None:
    age_ms = _order_age_ms(created_at=created_at, as_of=resolved_at)
    bucket = _latency_bucket(age_ms)
    normalized_outcome = outcome.strip().lower() or "unknown"
    order_type = decision.order_type.strip().lower() or "unknown"
    stats["submitted_order_count"] += 1
    stats["outcome_counts"][normalized_outcome] += 1
    stats["decision_count_by_order_type"][order_type] += 1
    stats["submitted_count_by_latency_bucket"][bucket] += 1
    if normalized_outcome == "filled":
        stats["filled_order_count"] += 1
        stats["filled_count_by_order_type"][order_type] += 1
        stats["filled_count_by_latency_bucket"][bucket] += 1
        stats["filled_latency_ms_samples"].append(age_ms)
    else:
        stats["pending_censored_count"] += 1
        stats["pending_age_ms_samples"].append(age_ms)
        stats["max_censored_pending_age_ms"] = max(
            int(stats.get("max_censored_pending_age_ms") or 0),
            age_ms,
        )
        if normalized_outcome == "replaced":
            stats["replaced_pending_count"] += 1
        if censor_reason:
            stats["censor_reason_counts"][censor_reason] += 1

    proxy = _execution_proxy_payload(decision=decision, signal=placement_signal)
    _append_decimal_sample(stats, "spread_bps_samples", proxy.get("spread_bps"))
    _append_decimal_sample(stats, "depth_notional_samples", proxy.get("depth_notional"))
    _append_decimal_sample(
        stats, "queue_touch_qty_samples", proxy.get("queue_touch_qty")
    )
    _append_decimal_sample(
        stats,
        "queue_touch_notional_samples",
        proxy.get("queue_touch_notional"),
    )
    _append_decimal_sample(
        stats,
        "order_qty_to_touch_qty_ratio_samples",
        proxy.get("order_qty_to_touch_qty_ratio"),
    )


def _record_order_lifecycle(
    *,
    order_lifecycle_stats: dict[str, Any],
    order_lifecycle_day_stats: dict[str, dict[str, Any]],
    order_lifecycle_symbol_stats: dict[str, dict[str, Any]],
    decision: StrategyDecision,
    placement_signal: SignalEnvelope,
    created_at: datetime,
    resolved_at: datetime,
    outcome: str,
    censor_reason: str | None = None,
) -> None:
    day_key = created_at.date().isoformat()
    symbol_key = decision.symbol.strip().upper()
    for stats in (
        order_lifecycle_stats,
        order_lifecycle_day_stats.setdefault(day_key, _init_order_lifecycle_stats()),
        order_lifecycle_symbol_stats.setdefault(
            symbol_key, _init_order_lifecycle_stats()
        ),
    ):
        _record_order_lifecycle_outcome(
            stats,
            decision=decision,
            placement_signal=placement_signal,
            created_at=created_at,
            resolved_at=resolved_at,
            outcome=outcome,
            censor_reason=censor_reason,
        )


def _pending_censor_time(
    *,
    pending: PendingOrder,
    fallback: datetime,
) -> datetime:
    close_ts = regular_session_close_utc_for(pending.created_at)
    if close_ts > pending.created_at:
        return close_ts
    return fallback


def _decimal_average(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _int_average(values: list[int]) -> Decimal | None:
    if not values:
        return None
    return Decimal(sum(values)) / Decimal(len(values))


def _decimal_percentile(values: list[Decimal], percentile: Decimal) -> Decimal | None:
    if not values:
        return None
    ordered = sorted(values)
    index = int(Decimal(len(ordered) - 1) * percentile)
    return ordered[index]


def _int_percentile(values: list[int], percentile: Decimal) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = int(Decimal(len(ordered) - 1) * percentile)
    return ordered[index]


def _decimal_or_none(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None


def _fill_probability_by_latency_bucket(stats: Mapping[str, Any]) -> dict[str, Any]:
    submitted = stats.get("submitted_count_by_latency_bucket") or {}
    filled = stats.get("filled_count_by_latency_bucket") or {}
    payload: dict[str, Any] = {}
    for bucket in sorted(submitted):
        submitted_count = int(submitted[bucket])
        filled_count = int(filled.get(bucket, 0))
        payload[str(bucket)] = {
            "submitted_order_count": submitted_count,
            "filled_order_count": filled_count,
            "fill_rate": str(
                Decimal(filled_count) / Decimal(submitted_count)
                if submitted_count > 0
                else Decimal("0")
            ),
        }
    return payload


def _fill_probability_by_latency_threshold(stats: Mapping[str, Any]) -> dict[str, Any]:
    filled_latency = [
        int(value) for value in stats.get("filled_latency_ms_samples") or []
    ]
    submitted_order_count = int(stats.get("submitted_order_count") or 0)
    payload: dict[str, Any] = {}
    for threshold_ms in _FILL_LATENCY_THRESHOLDS_MS:
        filled_within_count = sum(
            1 for value in filled_latency if value <= threshold_ms
        )
        payload[str(threshold_ms)] = {
            "submitted_order_count": submitted_order_count,
            "filled_within_count": filled_within_count,
            "fill_rate": str(
                Decimal(filled_within_count) / Decimal(submitted_order_count)
                if submitted_order_count > 0
                else Decimal("0")
            ),
        }
    return payload


def _order_lifecycle_summary(
    stats: Mapping[str, Any],
    *,
    post_cost_survivorship: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    filled_latency = [
        int(value) for value in stats.get("filled_latency_ms_samples") or []
    ]
    pending_age = [int(value) for value in stats.get("pending_age_ms_samples") or []]
    spread_bps_samples = list(stats.get("spread_bps_samples") or [])
    depth_notional_samples = list(stats.get("depth_notional_samples") or [])
    queue_touch_qty_samples = list(stats.get("queue_touch_qty_samples") or [])
    queue_touch_notional_samples = list(stats.get("queue_touch_notional_samples") or [])
    touch_ratio_samples = list(stats.get("order_qty_to_touch_qty_ratio_samples") or [])
    submitted_order_count = int(stats.get("submitted_order_count") or 0)
    filled_order_count = int(stats.get("filled_order_count") or 0)
    payload: dict[str, Any] = {
        "submitted_order_count": submitted_order_count,
        "filled_order_count": filled_order_count,
        "pending_censored_count": int(stats.get("pending_censored_count") or 0),
        "replaced_pending_count": int(stats.get("replaced_pending_count") or 0),
        "fill_rate": str(
            Decimal(filled_order_count) / Decimal(submitted_order_count)
            if submitted_order_count > 0
            else Decimal("0")
        ),
        "outcome_counts": dict(sorted((stats.get("outcome_counts") or {}).items())),
        "censor_reason_counts": dict(
            sorted((stats.get("censor_reason_counts") or {}).items())
        ),
        "decision_count_by_order_type": dict(
            sorted((stats.get("decision_count_by_order_type") or {}).items())
        ),
        "filled_count_by_order_type": dict(
            sorted((stats.get("filled_count_by_order_type") or {}).items())
        ),
        "fill_time_ms_avg": _decimal_or_none(_int_average(filled_latency)),
        "fill_time_ms_p50": _int_percentile(filled_latency, Decimal("0.50")),
        "fill_time_ms_p95": _int_percentile(filled_latency, Decimal("0.95")),
        "pending_age_ms_avg": _decimal_or_none(_int_average(pending_age)),
        "pending_age_ms_p95": _int_percentile(pending_age, Decimal("0.95")),
        "max_censored_pending_age_ms": int(
            stats.get("max_censored_pending_age_ms") or 0
        ),
        "fill_probability_by_latency_bucket": _fill_probability_by_latency_bucket(
            stats
        ),
        "fill_probability_by_latency_threshold_ms": _fill_probability_by_latency_threshold(
            stats
        ),
        "spread_bps_avg_at_order": _decimal_or_none(
            _decimal_average(spread_bps_samples)
        ),
        "spread_bps_p95_at_order": _decimal_or_none(
            _decimal_percentile(spread_bps_samples, Decimal("0.95"))
        ),
        "depth_notional_min_at_order": str(min(depth_notional_samples))
        if depth_notional_samples
        else None,
        "depth_notional_avg_at_order": _decimal_or_none(
            _decimal_average(depth_notional_samples)
        ),
        "queue_touch_qty_avg": _decimal_or_none(
            _decimal_average(queue_touch_qty_samples)
        ),
        "queue_touch_notional_avg": _decimal_or_none(
            _decimal_average(queue_touch_notional_samples)
        ),
        "order_qty_to_touch_qty_ratio_p95": _decimal_or_none(
            _decimal_percentile(touch_ratio_samples, Decimal("0.95"))
        ),
        "fill_survival_sample_count": submitted_order_count,
        "fill_survival_evidence_present": submitted_order_count > 0,
    }
    if post_cost_survivorship is not None:
        payload["post_cost_survivorship"] = dict(post_cost_survivorship)
    return payload


def _post_cost_survivorship_summary(trades: list[ClosedTrade]) -> dict[str, Any]:
    closed_trade_count = len(trades)
    gross_positive_count = sum(1 for trade in trades if trade.gross_pnl > 0)
    net_positive_count = sum(1 for trade in trades if trade.net_pnl > 0)
    survived_count = sum(
        1 for trade in trades if trade.gross_pnl > 0 and trade.net_pnl > 0
    )
    killed_count = sum(
        1 for trade in trades if trade.gross_pnl > 0 and trade.net_pnl <= 0
    )
    return {
        "closed_trade_count": closed_trade_count,
        "gross_positive_count": gross_positive_count,
        "net_positive_count": net_positive_count,
        "gross_positive_survived_post_cost_count": survived_count,
        "gross_positive_killed_by_cost_count": killed_count,
        "post_cost_survival_rate": str(
            Decimal(survived_count) / Decimal(gross_positive_count)
            if gross_positive_count > 0
            else Decimal("0")
        ),
    }


def _decision_entry_order_type(decision: StrategyDecision) -> str:
    raw = decision.params.get("entry_order_type")
    if raw is None:
        return "runtime_default"
    value = str(raw).strip().lower()
    return (
        value
        if value in {"market", "limit", "prefer_limit", "runtime_default"}
        else "runtime_default"
    )


def _decision_market_order_spread_bps_max(decision: StrategyDecision) -> Decimal:
    raw = decision.params.get("market_order_spread_bps_max")
    if raw is None:
        return Decimal("12")
    try:
        return max(Decimal("0"), min(Decimal("12"), Decimal(str(raw))))
    except Exception:
        return Decimal("12")


def _decision_spread_bps(
    decision: StrategyDecision,
    *,
    price: Decimal | None,
    spread: Decimal | None,
) -> Decimal | None:
    execution_features = decision.params.get("execution_features")
    if isinstance(execution_features, dict):
        raw = execution_features.get("spread_bps")
        if raw is not None:
            try:
                return Decimal(str(raw))
            except Exception:
                pass
    if spread is None or spread <= 0 or price is None or price <= 0:
        return None
    return (spread / price) * Decimal("10000")


def _apply_order_preferences(
    decision: StrategyDecision,
    signal: SignalEnvelope,
    strategy_params: Mapping[str, Any] | None = None,
) -> StrategyDecision:
    if strategy_params:
        decision = decision.model_copy(
            update={"params": {**dict(strategy_params), **decision.params}}
        )
    position_exit = decision.params.get("position_exit")
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get("type") or "").strip()
        if exit_type == "session_flatten_minute_utc":
            return decision
    entry_order_type = _decision_entry_order_type(decision)
    if entry_order_type == "market":
        return decision
    prefer_limit = (
        entry_order_type in {"limit", "prefer_limit"}
        or settings.trading_execution_prefer_limit
    )
    if not prefer_limit:
        return decision
    if decision.order_type != "market":
        return decision
    price = _extract_price(signal)
    spread = _extract_spread(signal)
    spread_bps = _decision_spread_bps(decision, price=price, spread=spread)
    market_spread_bps_max = _decision_market_order_spread_bps_max(decision)
    if (
        entry_order_type != "limit"
        and _should_keep_market_order_for_high_conviction_entry(
            decision,
            price=price,
            spread=spread,
        )
        and (spread_bps is None or spread_bps <= market_spread_bps_max)
    ):
        return decision
    return decision.model_copy(
        update={
            "order_type": "limit",
            "limit_price": _near_touch_limit_price(price, spread, decision.action),
        }
    )


def _init_day_stats() -> dict[str, Any]:
    return {
        "decision_count": 0,
        "filled_count": 0,
        "decision_count_by_order_type": defaultdict(int),
        "filled_count_by_order_type": defaultdict(int),
        "filled_notional": Decimal("0"),
        "daily_adv_notional": Decimal("0"),
        "depth_notional": None,
        "liquidity_observation_count": 0,
        "gross_pnl": Decimal("0"),
        "net_pnl": Decimal("0"),
        "cost_total": Decimal("0"),
        "wins": 0,
        "losses": 0,
        "closed_trades": [],
        "capital_snapshot_count": 0,
        "min_cash": None,
        "min_equity": None,
        "max_gross_exposure": Decimal("0"),
        "max_net_exposure_abs": Decimal("0"),
        "max_gross_exposure_pct_equity": Decimal("0"),
        "negative_cash_observation_count": 0,
    }


def _init_funnel_stats() -> dict[str, Any]:
    return {
        "retained_rows": 0,
        "runtime_evaluable_rows": 0,
        "quote_valid_rows": 0,
        "strategy_evaluations": 0,
        "gate_pass_counts": defaultdict(int),
        "first_failed_gate_counts": defaultdict(int),
        "failing_threshold_counts": defaultdict(int),
        "post_gate_block_reason_counts": defaultdict(int),
        "passed_trace_count": 0,
        "decision_count": 0,
        "filled_count": 0,
        "decision_count_by_order_type": defaultdict(int),
        "filled_count_by_order_type": defaultdict(int),
        "filled_notional": Decimal("0"),
        "closed_trade_count": 0,
        "gross_pnl": Decimal("0"),
        "net_pnl": Decimal("0"),
        "cost_total": Decimal("0"),
    }


def _ensure_replay_stats_bucket(bucket: dict[str, Any]) -> dict[str, Any]:
    bucket.setdefault("decision_count", 0)
    bucket.setdefault("filled_count", 0)
    bucket.setdefault("decision_count_by_order_type", defaultdict(int))
    bucket.setdefault("filled_count_by_order_type", defaultdict(int))
    bucket.setdefault("filled_notional", Decimal("0"))
    bucket.setdefault("daily_adv_notional", Decimal("0"))
    bucket.setdefault("depth_notional", None)
    bucket.setdefault("liquidity_observation_count", 0)
    bucket.setdefault("gross_pnl", Decimal("0"))
    bucket.setdefault("net_pnl", Decimal("0"))
    bucket.setdefault("cost_total", Decimal("0"))
    bucket.setdefault("wins", 0)
    bucket.setdefault("losses", 0)
    bucket.setdefault("closed_trades", [])
    bucket.setdefault("closed_trade_count", 0)
    bucket.setdefault("capital_snapshot_count", 0)
    bucket.setdefault("min_cash", None)
    bucket.setdefault("min_equity", None)
    bucket.setdefault("max_gross_exposure", Decimal("0"))
    bucket.setdefault("max_net_exposure_abs", Decimal("0"))
    bucket.setdefault("max_gross_exposure_pct_equity", Decimal("0"))
    bucket.setdefault("negative_cash_observation_count", 0)
    return bucket


def _record_liquidity_observation(
    *, bucket: dict[str, Any], signal: SignalEnvelope
) -> None:
    bucket = _ensure_replay_stats_bucket(bucket)
    price = _extract_price(signal)
    observed = False
    microbar_volume = _extract_decimal_payload(signal, "microbar_volume")
    if microbar_volume is not None and microbar_volume > 0 and price > 0:
        bucket["daily_adv_notional"] += microbar_volume * price
        observed = True

    bid_px = _extract_bid(signal)
    ask_px = _extract_ask(signal)
    bid_sz = _extract_decimal_payload(signal, "imbalance_bid_sz")
    ask_sz = _extract_decimal_payload(signal, "imbalance_ask_sz")
    if (
        bid_px is not None
        and ask_px is not None
        and bid_sz is not None
        and ask_sz is not None
        and bid_px > 0
        and ask_px > 0
        and bid_sz > 0
        and ask_sz > 0
    ):
        depth_notional = (bid_px * bid_sz) + (ask_px * ask_sz)
        current_depth = bucket.get("depth_notional")
        if not isinstance(current_depth, Decimal) or depth_notional < current_depth:
            bucket["depth_notional"] = depth_notional
        observed = True

    if observed:
        bucket["liquidity_observation_count"] += 1


def _record_capital_snapshot(
    *,
    bucket: dict[str, Any],
    cash: Decimal,
    positions: dict[tuple[str, str], PositionState],
    last_prices: dict[str, Decimal],
) -> Decimal:
    bucket = _ensure_replay_stats_bucket(bucket)
    equity = _position_equity(cash=cash, positions=positions, last_prices=last_prices)
    gross_exposure, net_exposure = _position_exposure(
        positions=positions,
        last_prices=last_prices,
    )
    gross_exposure_pct_equity = (
        gross_exposure / equity
        if equity > 0
        else Decimal("999999999")
        if gross_exposure > 0
        else Decimal("0")
    )
    min_cash = bucket.get("min_cash")
    if not isinstance(min_cash, Decimal) or cash < min_cash:
        bucket["min_cash"] = cash
    min_equity = bucket.get("min_equity")
    if not isinstance(min_equity, Decimal) or equity < min_equity:
        bucket["min_equity"] = equity
    if gross_exposure > bucket["max_gross_exposure"]:
        bucket["max_gross_exposure"] = gross_exposure
    net_exposure_abs = abs(net_exposure)
    if net_exposure_abs > bucket["max_net_exposure_abs"]:
        bucket["max_net_exposure_abs"] = net_exposure_abs
    if gross_exposure_pct_equity > bucket["max_gross_exposure_pct_equity"]:
        bucket["max_gross_exposure_pct_equity"] = gross_exposure_pct_equity
    bucket["capital_snapshot_count"] += 1
    if cash < 0:
        bucket["negative_cash_observation_count"] += 1
    return equity


def _record_trace_for_funnel(
    stats: dict[str, Any],
    trace: StrategyTrace,
) -> None:
    stats["strategy_evaluations"] += 1
    if trace.passed:
        stats["passed_trace_count"] += 1
    for gate in trace.gates:
        if not gate.passed:
            break
        gate_key = f"{trace.strategy_type}:{gate.gate}"
        stats["gate_pass_counts"][gate_key] += 1
    if trace.first_failed_gate is None:
        return
    failed_gate_key = f"{trace.strategy_type}:{trace.first_failed_gate}"
    stats["first_failed_gate_counts"][failed_gate_key] += 1
    failed_gate = trace.failed_gate()
    if failed_gate is None:
        return
    for threshold in failed_gate.failing_thresholds():
        threshold_key = f"{trace.strategy_type}:{failed_gate.gate}:{threshold.metric}"
        stats["failing_threshold_counts"][threshold_key] += 1


def _build_near_miss(
    trace: StrategyTrace, *, trading_day: str
) -> NearMissRecord | None:
    if trace.passed or trace.first_failed_gate is None:
        return None
    failed_gate = trace.failed_gate()
    if failed_gate is None:
        return None
    failing_thresholds = failed_gate.failing_thresholds()
    if not failing_thresholds:
        return None
    return NearMissRecord(
        trading_day=trading_day,
        symbol=trace.symbol,
        strategy_id=trace.strategy_id,
        strategy_type=trace.strategy_type,
        event_ts=trace.event_ts,
        action=trace.action,
        first_failed_gate=trace.first_failed_gate,
        distance_score=trace.distance_score(),
        thresholds=failing_thresholds,
    )


def _insert_near_miss(
    near_misses: dict[str, list[NearMissRecord]],
    record: NearMissRecord,
    *,
    limit: int = 20,
) -> None:
    bucket = near_misses.setdefault(record.trading_day, [])
    bucket.append(record)
    bucket.sort(
        key=lambda item: (
            item.distance_score,
            item.event_ts,
            item.strategy_id,
            item.symbol,
        )
    )
    del bucket[limit:]


def _decimal_text(value: Decimal) -> str:
    return format(value, "f")


def _log_decision_queued(decision: StrategyDecision, created_at: datetime) -> None:
    logger.info(
        "replay_decision_queued ts=%s strategy_id=%s symbol=%s action=%s qty=%s order_type=%s limit_price=%s rationale=%s",
        created_at.isoformat(),
        decision.strategy_id,
        decision.symbol,
        decision.action,
        _decimal_text(decision.qty),
        decision.order_type,
        _decimal_text(decision.limit_price)
        if decision.limit_price is not None
        else "None",
        decision.rationale or "",
    )


def _log_trade_closed(trade: ClosedTrade) -> None:
    logger.info(
        "replay_trade_closed symbol=%s strategy_id=%s opened_at=%s closed_at=%s qty=%s entry=%s exit=%s gross_pnl=%s net_pnl=%s exit_reason=%s",
        trade.symbol,
        trade.strategy_id,
        trade.opened_at.isoformat(),
        trade.closed_at.isoformat(),
        _decimal_text(trade.qty),
        _decimal_text(trade.entry_price),
        _decimal_text(trade.exit_price),
        _decimal_text(trade.gross_pnl),
        _decimal_text(trade.net_pnl),
        trade.exit_reason,
    )


def _resolve_pending_fill_price(
    decision: StrategyDecision,
    signal: SignalEnvelope,
) -> Decimal | None:
    price = _extract_price(signal)
    bid = _extract_bid(signal)
    ask = _extract_ask(signal)
    normalized_action = decision.action.strip().lower()

    if decision.order_type == "limit" and decision.limit_price is not None:
        if normalized_action == "buy":
            executable_price = ask if ask is not None else price
            if executable_price > decision.limit_price:
                return None
            return executable_price
        executable_price = bid if bid is not None else price
        if executable_price < decision.limit_price:
            return None
        return executable_price

    if normalized_action == "buy":
        return ask if ask is not None else price
    return bid if bid is not None else price


def _decision_exit_reason(decision: StrategyDecision) -> str:
    position_exit = decision.params.get("position_exit")
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get("type") or "").strip()
        if exit_type:
            return exit_type
    rationale = str(decision.rationale or "").strip()
    if rationale:
        return rationale.split(",")[0]
    return "signal_exit"


def _decision_position_owner(
    decision: StrategyDecision,
    *,
    force_position_isolation: bool = False,
) -> str:
    if force_position_isolation:
        return decision.strategy_id
    runtime_payload = decision.params.get("strategy_runtime")
    if isinstance(runtime_payload, dict):
        isolation_mode = (
            str(runtime_payload.get("position_isolation_mode") or "").strip().lower()
        )
        if isolation_mode == "per_strategy":
            return decision.strategy_id
    return _SHARED_POSITION_OWNER


def _first_reject_reason(
    *,
    reason_codes: Iterable[str],
    default_reason: str,
) -> str:
    for reason_code in reason_codes:
        cleaned = str(reason_code).strip()
        if cleaned:
            return cleaned
    return default_reason


def _resolve_passed_trace_block_reason(
    *,
    strategy_id: str,
    runtime_intent_strategy_ids: set[str],
    runtime_suppression_reason_by_strategy_id: dict[str, str],
    raw_decision_strategy_ids: set[str],
    allocation_reject_reason_by_strategy_id: dict[str, str],
    sizing_reject_reason_by_strategy_id: dict[str, str],
    emitted_strategy_ids: set[str],
) -> str | None:
    if strategy_id not in runtime_intent_strategy_ids:
        return "engine_runtime_no_intent"
    if strategy_id in runtime_suppression_reason_by_strategy_id:
        return runtime_suppression_reason_by_strategy_id[strategy_id]
    if strategy_id not in raw_decision_strategy_ids:
        return "engine_runtime_intent_not_emitted"
    if strategy_id in allocation_reject_reason_by_strategy_id:
        return allocation_reject_reason_by_strategy_id[strategy_id]
    if strategy_id in sizing_reject_reason_by_strategy_id:
        return sizing_reject_reason_by_strategy_id[strategy_id]
    if strategy_id not in emitted_strategy_ids:
        return "post_runtime_filter_rejected"
    return None


def _pending_order_priority(decision: StrategyDecision) -> int:
    if decision.action.strip().lower() != "sell":
        return 0
    position_exit = decision.params.get("position_exit")
    exit_type = ""
    if isinstance(position_exit, dict):
        exit_type = str(position_exit.get("type") or "").strip()
    if exit_type == "session_flatten_minute_utc":
        return 5
    if exit_type in {"long_stop_loss_bps", "long_trailing_stop_bps"}:
        return 4
    if decision.order_type == "market":
        return 3
    if exit_type:
        return 2
    return 1


def _should_replace_pending_order(
    *,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> bool:
    existing_priority = _pending_order_priority(existing)
    replacement_priority = _pending_order_priority(replacement)
    if replacement_priority != existing_priority:
        return replacement_priority > existing_priority

    existing_action = existing.action.strip().lower()
    replacement_action = replacement.action.strip().lower()
    if existing_action != replacement_action:
        return False

    if existing.order_type != replacement.order_type:
        return existing.order_type == "limit" and replacement.order_type == "market"

    if existing.order_type != "limit":
        return False

    existing_limit = existing.limit_price
    replacement_limit = replacement.limit_price
    if existing_limit is None or replacement_limit is None:
        return False

    if replacement_action == "sell":
        return replacement_limit < existing_limit
    if replacement_action == "buy":
        return replacement_limit > existing_limit
    return False


def _reconcile_pending_order_before_immediate_fill(
    *,
    decision: StrategyDecision,
    pending_orders: dict[tuple[str, str], PendingOrder],
    created_at: datetime,
    force_position_isolation: bool = False,
) -> PendingOrder | None:
    pending_key = _position_key(
        decision.symbol,
        _decision_position_owner(
            decision,
            force_position_isolation=force_position_isolation,
        ),
    )
    existing_pending = pending_orders.pop(pending_key, None)
    if existing_pending is None:
        return None
    logger.info(
        "replay_pending_order_cleared_for_immediate_fill ts=%s symbol=%s existing_order_type=%s existing_limit=%s existing_exit=%s immediate_order_type=%s immediate_limit=%s immediate_exit=%s",
        created_at.isoformat(),
        decision.symbol,
        existing_pending.decision.order_type,
        existing_pending.decision.limit_price,
        _decision_exit_reason(existing_pending.decision),
        decision.order_type,
        decision.limit_price,
        _decision_exit_reason(decision),
    )
    return existing_pending


def _log_pending_order_replaced(
    *,
    created_at: datetime,
    existing: StrategyDecision,
    replacement: StrategyDecision,
) -> None:
    logger.info(
        "replay_pending_order_replaced ts=%s symbol=%s existing_order_type=%s existing_limit=%s existing_exit=%s replacement_order_type=%s replacement_limit=%s replacement_exit=%s",
        created_at.isoformat(),
        replacement.symbol,
        existing.order_type,
        _decimal_text(existing.limit_price)
        if existing.limit_price is not None
        else "None",
        _decision_exit_reason(existing),
        replacement.order_type,
        _decimal_text(replacement.limit_price)
        if replacement.limit_price is not None
        else "None",
        _decision_exit_reason(replacement),
    )


def _log_day_summary(
    *,
    day: date,
    stats: dict[str, Any],
    cash: Decimal,
    equity: Decimal,
    open_positions: int,
) -> None:
    logger.info(
        "replay_day_complete day=%s decisions=%s fills=%s wins=%s losses=%s gross_pnl=%s net_pnl=%s cost_total=%s cash=%s equity=%s open_positions=%s",
        day.isoformat(),
        stats["decision_count"],
        stats["filled_count"],
        stats["wins"],
        stats["losses"],
        _decimal_text(stats["gross_pnl"]),
        _decimal_text(stats["net_pnl"]),
        _decimal_text(stats["cost_total"]),
        _decimal_text(cash),
        _decimal_text(equity),
        open_positions,
    )


def _log_progress(
    *,
    signal_day: date,
    signal_ts: datetime,
    signals_seen: int,
    day_bucket: dict[str, Any],
    positions: dict[str, PositionState],
    pending_orders: dict[str, PendingOrder],
    cash: Decimal,
    equity: Decimal,
) -> None:
    logger.info(
        "replay_progress day=%s ts=%s signals=%s decisions=%s fills=%s wins=%s losses=%s pending_orders=%s open_positions=%s cash=%s equity=%s",
        signal_day.isoformat(),
        signal_ts.isoformat(),
        signals_seen,
        day_bucket["decision_count"],
        day_bucket["filled_count"],
        day_bucket["wins"],
        day_bucket["losses"],
        len(pending_orders),
        len(positions),
        _decimal_text(cash),
        _decimal_text(equity),
    )


def _close_position(
    *,
    symbol: str,
    position: PositionState,
    close_qty: Decimal,
    fill_price: Decimal,
    closed_at: datetime,
    exit_reason: str,
    entry_cost_allocated: Decimal,
    exit_cost_total: Decimal,
) -> tuple[PositionState | None, ClosedTrade]:
    if position.qty < 0:
        remaining_qty = position.qty + close_qty
        gross_pnl = (position.avg_entry_price - fill_price) * close_qty
    else:
        remaining_qty = position.qty - close_qty
        gross_pnl = (fill_price - position.avg_entry_price) * close_qty
    net_pnl = gross_pnl - entry_cost_allocated - exit_cost_total
    remaining_position: PositionState | None = None
    if remaining_qty != 0:
        remaining_position = PositionState(
            strategy_id=position.strategy_id,
            qty=remaining_qty,
            avg_entry_price=position.avg_entry_price,
            opened_at=position.opened_at,
            entry_cost_total=position.entry_cost_total - entry_cost_allocated,
            decision_at=position.decision_at,
            pending_entry=False,
        )
    return remaining_position, ClosedTrade(
        symbol=symbol,
        strategy_id=position.strategy_id,
        decision_at=position.decision_at,
        opened_at=position.opened_at,
        closed_at=closed_at,
        qty=close_qty,
        entry_price=position.avg_entry_price,
        exit_price=fill_price,
        gross_pnl=gross_pnl,
        net_pnl=net_pnl,
        exit_reason=exit_reason,
    )


def _apply_filled_decision(
    *,
    decision: StrategyDecision,
    signal: SignalEnvelope,
    fill_price: Decimal,
    filled_at: datetime,
    created_at: datetime,
    positions: dict[tuple[str, str], PositionState],
    day_bucket: dict[str, Any],
    symbol_bucket: dict[str, Any] | None = None,
    cost_model: TransactionCostModel,
    cash: Decimal,
    all_closed_trades: list[ClosedTrade],
    force_position_isolation: bool = False,
    exact_ledger_rows: list[dict[str, Any]] | None = None,
    ledger_context: ReplayLedgerContext | None = None,
    ledger_strategy_id: str | None = None,
) -> Decimal:
    day_bucket = _ensure_replay_stats_bucket(day_bucket)
    if symbol_bucket is not None:
        symbol_bucket = _ensure_replay_stats_bucket(symbol_bucket)

    def _record_fill(
        *,
        fill_qty: Decimal,
        fill_notional: Decimal,
        fill_cost: Decimal,
        cost_lineage: ReplayCostLineage,
    ) -> None:
        day_bucket["cost_total"] += fill_cost
        day_bucket["filled_count"] += 1
        _record_fill_order_type(day_bucket, decision.order_type)
        day_bucket["filled_notional"] += fill_notional
        if symbol_bucket is not None:
            symbol_bucket["cost_total"] += fill_cost
            symbol_bucket["filled_count"] += 1
            _record_fill_order_type(symbol_bucket, decision.order_type)
            symbol_bucket["filled_notional"] += fill_notional
        _append_ledger_fill(
            rows=exact_ledger_rows,
            context=ledger_context,
            decision=decision,
            created_at=created_at,
            filled_at=filled_at,
            strategy_id=ledger_strategy_id or owner_strategy_id,
            filled_qty=fill_qty,
            avg_fill_price=fill_price,
            cost_amount=fill_cost,
            cost_lineage=cost_lineage,
        )

    owner_strategy_id = _decision_position_owner(
        decision,
        force_position_isolation=force_position_isolation,
    )
    position_key = _position_key(decision.symbol, owner_strategy_id)
    existing = positions.get(position_key)
    cost_lineage = _estimate_trade_cost_lineage(
        model=cost_model,
        decision=decision,
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    )
    fill_cost = cost_lineage.total_cost
    if decision.action == "buy":
        if existing is not None and existing.qty < 0:
            cover_qty = min(decision.qty, abs(existing.qty))
            fill_notional = fill_price * cover_qty
            _record_fill(
                fill_qty=cover_qty,
                fill_notional=fill_notional,
                fill_cost=fill_cost,
                cost_lineage=cost_lineage,
            )
            cash -= fill_notional + fill_cost
            entry_cost_allocated = existing.entry_cost_total * (
                cover_qty / abs(existing.qty)
            )
            remaining, trade = _close_position(
                symbol=decision.symbol,
                position=existing,
                close_qty=cover_qty,
                fill_price=fill_price,
                closed_at=filled_at,
                exit_reason=_decision_exit_reason(decision),
                entry_cost_allocated=entry_cost_allocated,
                exit_cost_total=fill_cost,
            )
            if remaining is None:
                positions.pop(position_key, None)
            else:
                positions[position_key] = remaining
            day_bucket["gross_pnl"] += trade.gross_pnl
            day_bucket["net_pnl"] += trade.net_pnl
            if symbol_bucket is not None:
                symbol_bucket["gross_pnl"] += trade.gross_pnl
                symbol_bucket["net_pnl"] += trade.net_pnl
                symbol_bucket["closed_trade_count"] += 1
            if trade.net_pnl > 0:
                day_bucket["wins"] += 1
            elif trade.net_pnl < 0:
                day_bucket["losses"] += 1
            day_bucket["closed_trades"].append(trade)
            all_closed_trades.append(trade)
            _log_trade_closed(trade)
            return cash

        fill_notional = fill_price * decision.qty
        _record_fill(
            fill_qty=decision.qty,
            fill_notional=fill_notional,
            fill_cost=fill_cost,
            cost_lineage=cost_lineage,
        )
        cash -= fill_notional + fill_cost
        if existing is None:
            positions[position_key] = PositionState(
                strategy_id=owner_strategy_id,
                qty=decision.qty,
                avg_entry_price=fill_price,
                opened_at=filled_at,
                entry_cost_total=fill_cost,
                decision_at=created_at,
                pending_entry=False,
            )
            return cash
        new_qty = existing.qty + decision.qty
        avg_entry = (
            (existing.avg_entry_price * existing.qty) + (fill_price * decision.qty)
        ) / new_qty
        positions[position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=new_qty,
            avg_entry_price=avg_entry,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total + fill_cost,
            decision_at=existing.decision_at,
            pending_entry=False,
        )
        return cash

    if existing is None:
        fill_notional = fill_price * decision.qty
        _record_fill(
            fill_qty=decision.qty,
            fill_notional=fill_notional,
            fill_cost=fill_cost,
            cost_lineage=cost_lineage,
        )
        cash += fill_notional - fill_cost
        positions[position_key] = PositionState(
            strategy_id=owner_strategy_id,
            qty=-decision.qty,
            avg_entry_price=fill_price,
            opened_at=filled_at,
            entry_cost_total=fill_cost,
            decision_at=created_at,
            pending_entry=False,
        )
        return cash

    if existing.qty < 0:
        fill_notional = fill_price * decision.qty
        _record_fill(
            fill_qty=decision.qty,
            fill_notional=fill_notional,
            fill_cost=fill_cost,
            cost_lineage=cost_lineage,
        )
        cash += fill_notional - fill_cost
        new_abs_qty = abs(existing.qty) + decision.qty
        avg_entry = (
            (existing.avg_entry_price * abs(existing.qty)) + (fill_price * decision.qty)
        ) / new_abs_qty
        positions[position_key] = PositionState(
            strategy_id=existing.strategy_id,
            qty=-new_abs_qty,
            avg_entry_price=avg_entry,
            opened_at=existing.opened_at,
            entry_cost_total=existing.entry_cost_total + fill_cost,
            decision_at=existing.decision_at,
            pending_entry=False,
        )
        return cash

    sell_qty = min(decision.qty, existing.qty)
    fill_notional = fill_price * sell_qty
    _record_fill(
        fill_qty=sell_qty,
        fill_notional=fill_notional,
        fill_cost=fill_cost,
        cost_lineage=cost_lineage,
    )
    cash += fill_notional - fill_cost
    entry_cost_allocated = existing.entry_cost_total * (sell_qty / existing.qty)
    remaining, trade = _close_position(
        symbol=decision.symbol,
        position=existing,
        close_qty=sell_qty,
        fill_price=fill_price,
        closed_at=filled_at,
        exit_reason=_decision_exit_reason(decision),
        entry_cost_allocated=entry_cost_allocated,
        exit_cost_total=fill_cost,
    )
    if remaining is None:
        positions.pop(position_key, None)
    else:
        positions[position_key] = remaining
    day_bucket["gross_pnl"] += trade.gross_pnl
    day_bucket["net_pnl"] += trade.net_pnl
    if symbol_bucket is not None:
        symbol_bucket["gross_pnl"] += trade.gross_pnl
        symbol_bucket["net_pnl"] += trade.net_pnl
        symbol_bucket["closed_trade_count"] += 1
    if trade.net_pnl > 0:
        day_bucket["wins"] += 1
    elif trade.net_pnl < 0:
        day_bucket["losses"] += 1
    day_bucket["closed_trades"].append(trade)
    all_closed_trades.append(trade)
    _log_trade_closed(trade)
    return cash


def run_replay(config: ReplayConfig) -> dict[str, Any]:
    strategies = _load_strategies(config.strategy_configmap_path)
    strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
    capture_runtime_traces = config.capture_traces or config.capture_trace_funnel
    engine = DecisionEngine(
        price_fetcher=None, runtime_trace_enabled=capture_runtime_traces
    )
    quote_quality = SignalQuoteQualityTracker(
        policy=QuoteQualityPolicy(
            max_executable_spread_bps=config.max_executable_spread_bps,
            max_quote_mid_jump_bps=config.max_quote_mid_jump_bps,
            max_jump_with_wide_spread_bps=config.max_jump_with_wide_spread_bps,
        )
    )
    session_context = SessionContextTracker(
        quote_quality_policy=quote_quality.policy,
    )
    cost_model = TransactionCostModel()
    ledger_context = (
        _build_replay_ledger_context(config=config, cost_model=cost_model)
        if config.capture_exact_replay_ledger
        else None
    )
    exact_ledger_rows: list[dict[str, Any]] | None = (
        [] if ledger_context is not None else None
    )
    positions: dict[tuple[str, str], PositionState] = {}
    pending_orders: dict[tuple[str, str], PendingOrder] = {}
    last_prices: dict[str, Decimal] = {}
    last_signals: dict[str, SignalEnvelope] = {}
    cash = config.start_equity
    day_stats: dict[str, dict[str, Any]] = {}
    funnel_stats: dict[tuple[str, str], dict[str, Any]] = {}
    order_lifecycle_stats = _init_order_lifecycle_stats()
    order_lifecycle_day_stats: dict[str, dict[str, Any]] = {}
    order_lifecycle_symbol_stats: dict[str, dict[str, Any]] = {}
    trace_records: list[ReplayTraceRecord] = []
    near_misses: dict[str, list[NearMissRecord]] = {}
    all_closed_trades: list[ClosedTrade] = []
    current_day: date | None = None
    signals_seen = 0
    replay_started_at = time_mod.monotonic()
    last_progress_at = replay_started_at

    logger.info(
        "replay_start start_date=%s end_date=%s chunk_minutes=%s flatten_eod=%s start_equity=%s symbol_count=%s symbols=%s",
        config.start_date.isoformat(),
        config.end_date.isoformat(),
        config.chunk_minutes,
        config.flatten_eod,
        _decimal_text(config.start_equity),
        len(config.symbols),
        ",".join(config.symbols) if config.symbols else "*",
    )

    def _active_day_stats(target_day: date) -> dict[str, Any]:
        return day_stats.setdefault(target_day.isoformat(), _init_day_stats())

    def _active_symbol_funnel(target_day: date, symbol: str) -> dict[str, Any]:
        return funnel_stats.setdefault(
            (target_day.isoformat(), symbol), _init_funnel_stats()
        )

    def _record_lifecycle_outcome(
        *,
        pending: PendingOrder | None,
        decision: StrategyDecision,
        placement_signal: SignalEnvelope,
        created_at: datetime,
        resolved_at: datetime,
        outcome: str,
        censor_reason: str | None = None,
    ) -> None:
        ledger_decision = pending.decision if pending is not None else decision
        ledger_created_at = pending.created_at if pending is not None else created_at
        ledger_strategy_id = _decision_position_owner(
            ledger_decision,
            force_position_isolation=config.force_position_isolation,
        )
        if (event_type := _ledger_resolution_event_type(outcome)) is not None:
            _append_ledger_resolution(
                rows=exact_ledger_rows,
                context=ledger_context,
                decision=ledger_decision,
                created_at=ledger_created_at,
                resolved_at=resolved_at,
                strategy_id=ledger_strategy_id,
                event_type=event_type,
                reason=censor_reason or outcome,
            )
        _record_order_lifecycle(
            order_lifecycle_stats=order_lifecycle_stats,
            order_lifecycle_day_stats=order_lifecycle_day_stats,
            order_lifecycle_symbol_stats=order_lifecycle_symbol_stats,
            decision=pending.decision if pending is not None else decision,
            placement_signal=pending.signal
            if pending is not None
            else placement_signal,
            created_at=pending.created_at if pending is not None else created_at,
            resolved_at=resolved_at,
            outcome=outcome,
            censor_reason=censor_reason,
        )

    def _censor_pending_orders(*, reason: str, fallback: datetime) -> None:
        for pending_key in sorted(list(pending_orders)):
            pending = pending_orders.pop(pending_key, None)
            if pending is None:
                continue
            _record_lifecycle_outcome(
                pending=pending,
                decision=pending.decision,
                placement_signal=pending.signal,
                created_at=pending.created_at,
                resolved_at=_pending_censor_time(pending=pending, fallback=fallback),
                outcome="censored",
                censor_reason=reason,
            )

    with (
        patch.object(settings, "trading_strategy_runtime_mode", "scheduler_v3"),
        patch.object(settings, "trading_strategy_scheduler_enabled", True),
        patch.object(settings, "trading_allow_shorts", True),
        patch.object(settings, "trading_fractional_equities_enabled", True),
    ):
        for signal in _iter_signal_rows(config):
            signal = signal.model_copy(
                update={"payload": session_context.enrich_signal_payload(signal)}
            )
            signal_day = signal.event_ts.date()
            if current_day is None:
                current_day = signal_day
                logger.info("replay_day_start day=%s", current_day.isoformat())
                _record_capital_snapshot(
                    bucket=_active_day_stats(current_day),
                    cash=cash,
                    positions=positions,
                    last_prices=last_prices,
                )
            if current_day != signal_day:
                if config.flatten_eod:
                    cash_ref = [cash]
                    _flatten_positions(
                        day=current_day,
                        stats=_active_day_stats(current_day),
                        funnel_stats=funnel_stats,
                        positions=positions,
                        last_signals=last_signals,
                        last_prices=last_prices,
                        cost_model=cost_model,
                        cash_ref=cash_ref,
                        all_closed_trades=all_closed_trades,
                        exact_ledger_rows=exact_ledger_rows,
                        ledger_context=ledger_context,
                    )
                    cash = cash_ref[0]
                _censor_pending_orders(
                    reason="day_boundary",
                    fallback=regular_session_close_utc_for(current_day),
                )
                completed_day_stats = _active_day_stats(current_day)
                completed_day_equity = _record_capital_snapshot(
                    bucket=completed_day_stats,
                    cash=cash,
                    positions=positions,
                    last_prices=last_prices,
                )
                _log_day_summary(
                    day=current_day,
                    stats=completed_day_stats,
                    cash=cash,
                    equity=completed_day_equity,
                    open_positions=len(positions),
                )
                current_day = signal_day
                logger.info("replay_day_start day=%s", current_day.isoformat())
                _record_capital_snapshot(
                    bucket=_active_day_stats(current_day),
                    cash=cash,
                    positions=positions,
                    last_prices=last_prices,
                )

            signals_seen += 1
            day_bucket = _active_day_stats(signal_day)
            symbol_bucket = _active_symbol_funnel(signal_day, signal.symbol)
            symbol_bucket["retained_rows"] += 1
            quote_status = quote_quality.assess(signal)
            if not quote_status.valid:
                engine.observe_signal(signal)
                has_open_position = any(
                    symbol == signal.symbol for symbol, _ in positions
                )
                has_pending_order = any(
                    symbol == signal.symbol for symbol, _ in pending_orders
                )
                if has_open_position or has_pending_order:
                    _log_quote_skipped(
                        signal=signal,
                        status=quote_status,
                        has_open_position=has_open_position,
                        has_pending_order=has_pending_order,
                    )
                continue

            price = _extract_price(signal)
            symbol_bucket["quote_valid_rows"] += 1
            last_prices[signal.symbol] = price
            last_signals[signal.symbol] = signal
            _record_liquidity_observation(bucket=day_bucket, signal=signal)
            _record_liquidity_observation(bucket=symbol_bucket, signal=signal)
            equity = _record_capital_snapshot(
                bucket=day_bucket,
                cash=cash,
                positions=positions,
                last_prices=last_prices,
            )

            matching_pending_keys = [
                pending_key
                for pending_key in sorted(pending_orders)
                if pending_key[0] == signal.symbol
            ]
            for pending_key in matching_pending_keys:
                pending = pending_orders.pop(pending_key, None)
                if pending is None:
                    continue
                decision = pending.decision
                fill_price = _resolve_pending_fill_price(decision, signal)
                if fill_price is None:
                    pending_orders[pending_key] = pending
                    continue
                _record_lifecycle_outcome(
                    pending=pending,
                    decision=decision,
                    placement_signal=pending.signal,
                    created_at=pending.created_at,
                    resolved_at=signal.event_ts,
                    outcome="filled",
                )
                pending_ledger_strategy_id = _decision_position_owner(
                    decision,
                    force_position_isolation=config.force_position_isolation,
                )
                cash = _apply_filled_decision(
                    decision=decision,
                    signal=signal,
                    fill_price=fill_price,
                    filled_at=signal.event_ts,
                    created_at=pending.created_at,
                    positions=positions,
                    day_bucket=day_bucket,
                    symbol_bucket=symbol_bucket,
                    cost_model=cost_model,
                    cash=cash,
                    all_closed_trades=all_closed_trades,
                    force_position_isolation=config.force_position_isolation,
                    exact_ledger_rows=exact_ledger_rows,
                    ledger_context=ledger_context,
                    ledger_strategy_id=pending_ledger_strategy_id,
                )
                equity = _record_capital_snapshot(
                    bucket=day_bucket,
                    cash=cash,
                    positions=positions,
                    last_prices=last_prices,
                )

            equity = _record_capital_snapshot(
                bucket=day_bucket,
                cash=cash,
                positions=positions,
                last_prices=last_prices,
            )
            live_positions = _positions_payload(
                positions,
                last_prices,
                pending_orders,
                force_position_isolation=config.force_position_isolation,
            )
            raw_decisions = engine.evaluate(
                signal,
                strategies,
                equity=equity,
                positions=live_positions,
            )
            telemetry = engine.consume_runtime_telemetry()
            symbol_bucket["runtime_evaluable_rows"] += 1
            telemetry_traces = telemetry.traces if capture_runtime_traces else ()
            for trace in telemetry_traces:
                _record_trace_for_funnel(symbol_bucket, trace)
                near_miss = _build_near_miss(trace, trading_day=signal_day.isoformat())
                if near_miss is not None:
                    _insert_near_miss(near_misses, near_miss)
            regime_label = _signal_regime_label(signal)
            allocator = allocator_from_settings(equity)
            account = {"equity": str(equity)}
            executable_decisions: list[StrategyDecision] = []
            raw_decision_strategy_ids = {
                decision.strategy_id for decision in raw_decisions
            }
            runtime_intent_strategy_ids = set(raw_decision_strategy_ids)
            runtime_suppression_reason_by_strategy_id: dict[str, str] = {}
            observation = getattr(telemetry, "observation", None)
            if observation is not None:
                runtime_intent_strategy_ids = set(observation.strategy_intents_total)
                for raw_key in observation.strategy_intent_suppression_total:
                    strategy_id, separator, reason = str(raw_key).partition("|")
                    if separator and strategy_id and reason:
                        runtime_suppression_reason_by_strategy_id.setdefault(
                            strategy_id, reason
                        )
            allocation_reject_reason_by_strategy_id: dict[str, str] = {}
            sizing_reject_reason_by_strategy_id: dict[str, str] = {}
            for allocation_result in allocator.allocate(
                raw_decisions,
                account=account,
                positions=live_positions,
                regime_label=regime_label,
            ):
                decision = allocation_result.decision
                if not allocation_result.approved:
                    allocation_reject_reason_by_strategy_id.setdefault(
                        decision.strategy_id,
                        _first_reject_reason(
                            reason_codes=allocation_result.reason_codes,
                            default_reason="allocator_rejected",
                        ),
                    )
                    continue
                strategy = strategies_by_id.get(decision.strategy_id)
                if strategy is None:
                    executable_decisions.append(decision)
                    continue
                sizing_result = sizer_from_settings(strategy, equity).size(
                    decision,
                    account=account,
                    positions=live_positions,
                )
                if not sizing_result.approved:
                    sizing_reject_reason_by_strategy_id.setdefault(
                        decision.strategy_id,
                        _first_reject_reason(
                            reason_codes=sizing_result.reasons,
                            default_reason="sizer_rejected",
                        ),
                    )
                    continue
                executable_decisions.append(sizing_result.decision)

            emitted_strategy_ids = {
                decision.strategy_id for decision in executable_decisions
            }
            fill_status_by_strategy_id: dict[str, str] = {}
            block_reason_by_strategy_id: dict[str, str] = {}
            if capture_runtime_traces:
                for trace in telemetry_traces:
                    if trace.passed:
                        block_reason = _resolve_passed_trace_block_reason(
                            strategy_id=trace.strategy_id,
                            runtime_intent_strategy_ids=runtime_intent_strategy_ids,
                            runtime_suppression_reason_by_strategy_id=runtime_suppression_reason_by_strategy_id,
                            raw_decision_strategy_ids=raw_decision_strategy_ids,
                            allocation_reject_reason_by_strategy_id=allocation_reject_reason_by_strategy_id,
                            sizing_reject_reason_by_strategy_id=sizing_reject_reason_by_strategy_id,
                            emitted_strategy_ids=emitted_strategy_ids,
                        )
                        if block_reason is not None:
                            block_reason_by_strategy_id[trace.strategy_id] = (
                                block_reason
                            )
                            symbol_bucket["post_gate_block_reason_counts"][
                                block_reason
                            ] += 1
                    elif not trace.passed and trace.first_failed_gate is not None:
                        block_reason_by_strategy_id[trace.strategy_id] = (
                            trace.first_failed_gate
                        )

            for decision in executable_decisions:
                strategy = strategies_by_id.get(decision.strategy_id)
                strategy_params = (
                    StrategyRuntime._strategy_params(strategy)
                    if strategy is not None
                    else None
                )
                decision = _apply_order_preferences(
                    decision,
                    signal,
                    strategy_params=strategy_params,
                )
                _record_decision(day_bucket, decision)
                decision_symbol_bucket = _active_symbol_funnel(
                    signal_day, decision.symbol
                )
                decision_symbol_bucket["decision_count"] += 1
                if decision.qty <= 0:
                    continue
                ledger_strategy_id = _decision_position_owner(
                    decision,
                    force_position_isolation=config.force_position_isolation,
                )
                immediate_fill_price = _resolve_pending_fill_price(decision, signal)
                if immediate_fill_price is not None:
                    replaced_pending = _reconcile_pending_order_before_immediate_fill(
                        decision=decision,
                        pending_orders=pending_orders,
                        created_at=signal.event_ts,
                        force_position_isolation=config.force_position_isolation,
                    )
                    if replaced_pending is not None:
                        _record_lifecycle_outcome(
                            pending=replaced_pending,
                            decision=replaced_pending.decision,
                            placement_signal=replaced_pending.signal,
                            created_at=replaced_pending.created_at,
                            resolved_at=signal.event_ts,
                            outcome="replaced",
                            censor_reason="immediate_fill_replaced_pending",
                        )
                    _record_lifecycle_outcome(
                        pending=None,
                        decision=decision,
                        placement_signal=signal,
                        created_at=signal.event_ts,
                        resolved_at=signal.event_ts,
                        outcome="filled",
                    )
                    _append_ledger_submission(
                        rows=exact_ledger_rows,
                        context=ledger_context,
                        decision=decision,
                        created_at=signal.event_ts,
                        strategy_id=ledger_strategy_id,
                    )
                    cash = _apply_filled_decision(
                        decision=decision,
                        signal=signal,
                        fill_price=immediate_fill_price,
                        filled_at=signal.event_ts,
                        created_at=signal.event_ts,
                        positions=positions,
                        day_bucket=day_bucket,
                        symbol_bucket=decision_symbol_bucket,
                        cost_model=cost_model,
                        cash=cash,
                        all_closed_trades=all_closed_trades,
                        force_position_isolation=config.force_position_isolation,
                        exact_ledger_rows=exact_ledger_rows,
                        ledger_context=ledger_context,
                        ledger_strategy_id=ledger_strategy_id,
                    )
                    equity = _record_capital_snapshot(
                        bucket=day_bucket,
                        cash=cash,
                        positions=positions,
                        last_prices=last_prices,
                    )
                    fill_status_by_strategy_id[decision.strategy_id] = "filled"
                    continue
                pending_key = _position_key(
                    decision.symbol,
                    _decision_position_owner(
                        decision,
                        force_position_isolation=config.force_position_isolation,
                    ),
                )
                existing_pending = pending_orders.get(pending_key)
                if existing_pending is not None:
                    if _should_replace_pending_order(
                        existing=existing_pending.decision,
                        replacement=decision,
                    ):
                        _record_lifecycle_outcome(
                            pending=existing_pending,
                            decision=existing_pending.decision,
                            placement_signal=existing_pending.signal,
                            created_at=existing_pending.created_at,
                            resolved_at=signal.event_ts,
                            outcome="replaced",
                            censor_reason="pending_replaced",
                        )
                        pending_orders[pending_key] = PendingOrder(
                            decision=decision,
                            created_at=signal.event_ts,
                            signal=signal,
                        )
                        _append_ledger_submission(
                            rows=exact_ledger_rows,
                            context=ledger_context,
                            decision=decision,
                            created_at=signal.event_ts,
                            strategy_id=ledger_strategy_id,
                        )
                        _log_pending_order_replaced(
                            created_at=signal.event_ts,
                            existing=existing_pending.decision,
                            replacement=decision,
                        )
                        _log_decision_queued(decision, signal.event_ts)
                        fill_status_by_strategy_id[decision.strategy_id] = "pending"
                    continue
                pending_orders[pending_key] = PendingOrder(
                    decision=decision,
                    created_at=signal.event_ts,
                    signal=signal,
                )
                _append_ledger_submission(
                    rows=exact_ledger_rows,
                    context=ledger_context,
                    decision=decision,
                    created_at=signal.event_ts,
                    strategy_id=ledger_strategy_id,
                )
                _log_decision_queued(decision, signal.event_ts)
                fill_status_by_strategy_id[decision.strategy_id] = "pending"

            if config.capture_traces:
                for trace in telemetry_traces:
                    trace_records.append(
                        ReplayTraceRecord(
                            trading_day=signal_day.isoformat(),
                            strategy_trace=trace,
                            decision_emitted=trace.strategy_id in emitted_strategy_ids,
                            fill_status=fill_status_by_strategy_id.get(
                                trace.strategy_id, "none"
                            ),
                            decision_strategy_id=trace.strategy_id
                            if trace.strategy_id in emitted_strategy_ids
                            else None,
                            block_reason=block_reason_by_strategy_id.get(
                                trace.strategy_id
                            ),
                        )
                    )

            equity = _record_capital_snapshot(
                bucket=day_bucket,
                cash=cash,
                positions=positions,
                last_prices=last_prices,
            )
            now = time_mod.monotonic()
            if now - last_progress_at >= config.progress_log_interval_seconds:
                _log_progress(
                    signal_day=signal_day,
                    signal_ts=signal.event_ts,
                    signals_seen=signals_seen,
                    day_bucket=day_bucket,
                    positions=positions,
                    pending_orders=pending_orders,
                    cash=cash,
                    equity=equity,
                )
                last_progress_at = now

        if current_day is not None and config.flatten_eod:
            cash_ref = [cash]
            _flatten_positions(
                day=current_day,
                stats=_active_day_stats(current_day),
                funnel_stats=funnel_stats,
                positions=positions,
                last_signals=last_signals,
                last_prices=last_prices,
                cost_model=cost_model,
                cash_ref=cash_ref,
                all_closed_trades=all_closed_trades,
                exact_ledger_rows=exact_ledger_rows,
                ledger_context=ledger_context,
            )
            cash = cash_ref[0]
        if current_day is not None:
            _censor_pending_orders(
                reason="replay_end",
                fallback=regular_session_close_utc_for(current_day),
            )
        if current_day is not None:
            final_day_stats = _active_day_stats(current_day)
            final_day_equity = _record_capital_snapshot(
                bucket=final_day_stats,
                cash=cash,
                positions=positions,
                last_prices=last_prices,
            )
            _log_day_summary(
                day=current_day,
                stats=final_day_stats,
                cash=cash,
                equity=final_day_equity,
                open_positions=len(positions),
            )

    final_equity = _position_equity(
        cash=cash, positions=positions, last_prices=last_prices
    )
    total_decisions = sum(item["decision_count"] for item in day_stats.values())
    total_filled = sum(item["filled_count"] for item in day_stats.values())
    total_filled_notional = sum(
        (item["filled_notional"] for item in day_stats.values()), Decimal("0")
    )
    decision_count_by_order_type: defaultdict[str, int] = defaultdict(int)
    filled_count_by_order_type: defaultdict[str, int] = defaultdict(int)
    for item in day_stats.values():
        for order_type, count in item.get("decision_count_by_order_type", {}).items():
            decision_count_by_order_type[str(order_type)] += int(count)
        for order_type, count in item.get("filled_count_by_order_type", {}).items():
            filled_count_by_order_type[str(order_type)] += int(count)
    total_gross = sum((item["gross_pnl"] for item in day_stats.values()), Decimal("0"))
    total_net = final_equity - config.start_equity
    total_cost = sum((item["cost_total"] for item in day_stats.values()), Decimal("0"))
    wins = sum(item["wins"] for item in day_stats.values())
    losses = sum(item["losses"] for item in day_stats.values())
    min_cash = min(
        (
            value
            for item in day_stats.values()
            for value in (item.get("min_cash"),)
            if isinstance(value, Decimal)
        ),
        default=cash,
    )
    min_equity = min(
        (
            value
            for item in day_stats.values()
            for value in (item.get("min_equity"),)
            if isinstance(value, Decimal)
        ),
        default=final_equity,
    )
    max_gross_exposure = max(
        (
            value
            for item in day_stats.values()
            for value in (item.get("max_gross_exposure"),)
            if isinstance(value, Decimal)
        ),
        default=Decimal("0"),
    )
    max_net_exposure_abs = max(
        (
            value
            for item in day_stats.values()
            for value in (item.get("max_net_exposure_abs"),)
            if isinstance(value, Decimal)
        ),
        default=Decimal("0"),
    )
    max_gross_exposure_pct_equity = max(
        (
            value
            for item in day_stats.values()
            for value in (item.get("max_gross_exposure_pct_equity"),)
            if isinstance(value, Decimal)
        ),
        default=Decimal("0"),
    )
    capital_snapshot_count = sum(
        int(item.get("capital_snapshot_count") or 0) for item in day_stats.values()
    )
    negative_cash_observation_count = sum(
        int(item.get("negative_cash_observation_count") or 0)
        for item in day_stats.values()
    )
    funnel_report = ReplayFunnelReport(
        start_date=config.start_date.isoformat(),
        end_date=config.end_date.isoformat(),
        buckets=tuple(
            ReplayFunnelBucket(
                trading_day=trading_day,
                symbol=symbol,
                retained_rows=int(bucket["retained_rows"]),
                runtime_evaluable_rows=int(bucket["runtime_evaluable_rows"]),
                quote_valid_rows=int(bucket["quote_valid_rows"]),
                strategy_evaluations=int(bucket["strategy_evaluations"]),
                gate_pass_counts=dict(bucket["gate_pass_counts"]),
                first_failed_gate_counts=dict(bucket["first_failed_gate_counts"]),
                failing_threshold_counts=dict(bucket["failing_threshold_counts"]),
                post_gate_block_reason_counts=dict(
                    bucket["post_gate_block_reason_counts"]
                ),
                passed_trace_count=int(bucket["passed_trace_count"]),
                decision_count=int(bucket["decision_count"]),
                filled_count=int(bucket["filled_count"]),
                filled_notional=bucket["filled_notional"],
                closed_trade_count=int(bucket["closed_trade_count"]),
                gross_pnl=bucket["gross_pnl"],
                net_pnl=bucket["net_pnl"],
                cost_total=bucket["cost_total"],
                daily_adv_notional=bucket.get("daily_adv_notional", Decimal("0")),
                depth_notional=bucket.get("depth_notional")
                if isinstance(bucket.get("depth_notional"), Decimal)
                else None,
                liquidity_observation_count=int(
                    bucket.get("liquidity_observation_count") or 0
                ),
            )
            for (trading_day, symbol), bucket in sorted(funnel_stats.items())
        ),
    )
    near_miss_payload = [
        item.to_payload()
        for trading_day in sorted(near_misses)
        for item in near_misses[trading_day]
    ]
    closed_trade_payload = sorted(
        all_closed_trades,
        key=lambda item: item.net_pnl,
    )
    logger.info(
        "replay_complete elapsed_s=%.3f signals=%s decisions=%s fills=%s wins=%s losses=%s gross_pnl=%s net_pnl=%s total_cost=%s final_equity=%s",
        time_mod.monotonic() - replay_started_at,
        signals_seen,
        total_decisions,
        total_filled,
        wins,
        losses,
        _decimal_text(total_gross),
        _decimal_text(total_net),
        _decimal_text(total_cost),
        _decimal_text(final_equity),
    )
    post_cost_survivorship = _post_cost_survivorship_summary(all_closed_trades)
    payload = {
        "start_date": config.start_date.isoformat(),
        "end_date": config.end_date.isoformat(),
        "start_equity": str(config.start_equity),
        "final_cash": str(cash),
        "final_equity": str(final_equity),
        "net_pnl": str(total_net),
        "gross_pnl": str(total_gross),
        "total_cost": str(total_cost),
        "decision_count": total_decisions,
        "decision_count_by_order_type": dict(
            sorted(decision_count_by_order_type.items())
        ),
        "filled_count": total_filled,
        "filled_count_by_order_type": dict(sorted(filled_count_by_order_type.items())),
        "limit_fill_rate": (
            str(
                Decimal(filled_count_by_order_type.get("limit", 0))
                / Decimal(decision_count_by_order_type.get("limit", 1))
            )
            if decision_count_by_order_type.get("limit", 0) > 0
            else None
        ),
        "filled_notional": str(total_filled_notional),
        "wins": wins,
        "losses": losses,
        "capital_snapshot_count": capital_snapshot_count,
        "min_cash": str(min_cash),
        "min_equity": str(min_equity),
        "max_gross_exposure": str(max_gross_exposure),
        "max_net_exposure_abs": str(max_net_exposure_abs),
        "max_gross_exposure_pct_equity": str(max_gross_exposure_pct_equity),
        "negative_cash_observation_count": negative_cash_observation_count,
        "open_positions": {
            f"{symbol}|{owner_strategy_id}": {
                "strategy_id": position.strategy_id,
                "qty": str(position.qty),
                "avg_entry_price": str(position.avg_entry_price),
                "last_price": str(last_prices.get(symbol, position.avg_entry_price)),
            }
            for (symbol, owner_strategy_id), position in positions.items()
        },
        "daily": {
            key: {
                "decision_count": value["decision_count"],
                "decision_count_by_order_type": dict(
                    sorted(value.get("decision_count_by_order_type", {}).items())
                ),
                "filled_count": value["filled_count"],
                "filled_count_by_order_type": dict(
                    sorted(value.get("filled_count_by_order_type", {}).items())
                ),
                "limit_fill_rate": (
                    str(
                        Decimal(
                            value.get("filled_count_by_order_type", {}).get("limit", 0)
                        )
                        / Decimal(
                            value.get("decision_count_by_order_type", {}).get(
                                "limit", 1
                            )
                        )
                    )
                    if value.get("decision_count_by_order_type", {}).get("limit", 0) > 0
                    else None
                ),
                "filled_notional": str(value["filled_notional"]),
                "daily_adv_notional": str(value["daily_adv_notional"]),
                "depth_notional": str(value["depth_notional"])
                if isinstance(value.get("depth_notional"), Decimal)
                else None,
                "liquidity_observation_count": int(
                    value.get("liquidity_observation_count") or 0
                ),
                "gross_pnl": str(value["gross_pnl"]),
                "net_pnl": str(value["net_pnl"]),
                "cost_total": str(value["cost_total"]),
                "wins": value["wins"],
                "losses": value["losses"],
                "capital_snapshot_count": int(value.get("capital_snapshot_count") or 0),
                "min_cash": str(value["min_cash"])
                if isinstance(value.get("min_cash"), Decimal)
                else None,
                "min_equity": str(value["min_equity"])
                if isinstance(value.get("min_equity"), Decimal)
                else None,
                "max_gross_exposure": str(
                    value.get("max_gross_exposure", Decimal("0"))
                ),
                "max_net_exposure_abs": str(
                    value.get("max_net_exposure_abs", Decimal("0"))
                ),
                "max_gross_exposure_pct_equity": str(
                    value.get("max_gross_exposure_pct_equity", Decimal("0"))
                ),
                "negative_cash_observation_count": int(
                    value.get("negative_cash_observation_count") or 0
                ),
            }
            for key, value in sorted(day_stats.items())
        },
        "largest_losses": [
            {
                "symbol": item.symbol,
                "strategy_id": item.strategy_id,
                "decision_at": item.decision_at.isoformat(),
                "opened_at": item.opened_at.isoformat(),
                "closed_at": item.closed_at.isoformat(),
                "qty": str(item.qty),
                "entry_price": str(item.entry_price),
                "exit_price": str(item.exit_price),
                "net_pnl": str(item.net_pnl),
                "exit_reason": item.exit_reason,
            }
            for item in closed_trade_payload[:10]
        ],
        "largest_wins": [
            {
                "symbol": item.symbol,
                "strategy_id": item.strategy_id,
                "decision_at": item.decision_at.isoformat(),
                "opened_at": item.opened_at.isoformat(),
                "closed_at": item.closed_at.isoformat(),
                "qty": str(item.qty),
                "entry_price": str(item.entry_price),
                "exit_price": str(item.exit_price),
                "net_pnl": str(item.net_pnl),
                "exit_reason": item.exit_reason,
            }
            for item in list(reversed(closed_trade_payload[-10:]))
        ],
        "trace": [item.to_payload() for item in trace_records],
        "funnel": funnel_report.to_payload(),
        "near_misses": near_miss_payload,
        "order_lifecycle": _order_lifecycle_summary(
            order_lifecycle_stats,
            post_cost_survivorship=post_cost_survivorship,
        ),
        "order_lifecycle_by_day": {
            key: _order_lifecycle_summary(value)
            for key, value in sorted(order_lifecycle_day_stats.items())
        },
        "order_lifecycle_by_symbol": {
            key: _order_lifecycle_summary(value)
            for key, value in sorted(order_lifecycle_symbol_stats.items())
        },
    }
    if exact_ledger_rows is not None and ledger_context is not None:
        payload["exact_replay_ledger"] = _exact_replay_ledger_payload(
            rows=exact_ledger_rows,
            config=config,
            context=ledger_context,
        )
    return payload


def _signal_regime_label(signal: SignalEnvelope) -> str | None:
    payload = signal.payload or {}
    for key in ("route_regime_label", "regime_label"):
        raw = payload.get(key)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            return value
    return None


def _flatten_positions(
    *,
    day: date,
    stats: dict[str, Any],
    funnel_stats: dict[tuple[str, str], dict[str, Any]],
    positions: dict[tuple[str, str], PositionState],
    last_signals: dict[str, SignalEnvelope],
    last_prices: dict[str, Decimal],
    cost_model: TransactionCostModel,
    cash_ref: list[Decimal],
    all_closed_trades: list[ClosedTrade],
    exact_ledger_rows: list[dict[str, Any]] | None = None,
    ledger_context: ReplayLedgerContext | None = None,
) -> None:
    if not positions:
        return
    stats = _ensure_replay_stats_bucket(stats)
    current_cash = cash_ref[0]
    for position_key in sorted(list(positions)):
        symbol, _owner_strategy_id = position_key
        position = positions.pop(position_key)
        last_signal = last_signals.get(symbol)
        if last_signal is None:
            continue
        symbol_bucket = funnel_stats.setdefault(
            (day.isoformat(), symbol), _init_funnel_stats()
        )
        fill_price = last_prices.get(symbol, position.avg_entry_price)
        exit_action = "buy" if position.qty < 0 else "sell"
        exit_qty = abs(position.qty)
        closed_at = regular_session_close_utc_for(day)
        synthetic_decision = StrategyDecision(
            strategy_id=position.strategy_id,
            symbol=symbol,
            event_ts=closed_at,
            timeframe="1Sec",
            action=exit_action,
            qty=exit_qty,
            order_type="market",
            time_in_force="day",
            params={},
        )
        exit_cost_lineage = _estimate_trade_cost_lineage(
            model=cost_model,
            decision=synthetic_decision,
            signal=last_signal,
            day_bucket=stats,
            symbol_bucket=symbol_bucket,
        )
        exit_cost = exit_cost_lineage.total_cost
        exit_notional = fill_price * exit_qty
        if position.qty < 0:
            current_cash -= exit_notional + exit_cost
        else:
            current_cash += exit_notional - exit_cost
        _append_ledger_submission(
            rows=exact_ledger_rows,
            context=ledger_context,
            decision=synthetic_decision,
            created_at=closed_at,
            strategy_id=position.strategy_id,
        )
        _append_ledger_fill(
            rows=exact_ledger_rows,
            context=ledger_context,
            decision=synthetic_decision,
            created_at=closed_at,
            filled_at=closed_at,
            strategy_id=position.strategy_id,
            filled_qty=exit_qty,
            avg_fill_price=fill_price,
            cost_amount=exit_cost,
            cost_lineage=exit_cost_lineage,
        )
        trade = ClosedTrade(
            symbol=symbol,
            strategy_id=position.strategy_id,
            decision_at=position.decision_at,
            opened_at=position.opened_at,
            closed_at=closed_at,
            qty=exit_qty,
            entry_price=position.avg_entry_price,
            exit_price=fill_price,
            gross_pnl=(
                (position.avg_entry_price - fill_price) * exit_qty
                if position.qty < 0
                else (fill_price - position.avg_entry_price) * exit_qty
            ),
            net_pnl=(
                (
                    (position.avg_entry_price - fill_price) * exit_qty
                    if position.qty < 0
                    else (fill_price - position.avg_entry_price) * exit_qty
                )
                - position.entry_cost_total
                - exit_cost
            ),
            exit_reason="eod_flatten",
        )
        stats["gross_pnl"] += trade.gross_pnl
        stats["net_pnl"] += trade.net_pnl
        stats["cost_total"] += exit_cost
        stats["filled_count"] += 1
        _record_fill_order_type(stats, "market")
        stats["filled_notional"] += exit_notional
        symbol_bucket["gross_pnl"] += trade.gross_pnl
        symbol_bucket["net_pnl"] += trade.net_pnl
        symbol_bucket["cost_total"] += exit_cost
        symbol_bucket["filled_count"] += 1
        _record_fill_order_type(symbol_bucket, "market")
        symbol_bucket["filled_notional"] += exit_notional
        symbol_bucket["closed_trade_count"] += 1
        if trade.net_pnl > 0:
            stats["wins"] += 1
        elif trade.net_pnl < 0:
            stats["losses"] += 1
        stats["closed_trades"].append(trade)
        all_closed_trades.append(trade)
        _log_trade_closed(trade)
    cash_ref[0] = current_cash


def main() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logging.getLogger("alembic").setLevel(logging.WARNING)
    config = ReplayConfig(
        strategy_configmap_path=Path(args.strategy_configmap).resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_date=date.fromisoformat(args.start_date),
        end_date=date.fromisoformat(args.end_date),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        flatten_eod=not args.no_flatten_eod,
        start_equity=Decimal(str(args.start_equity)),
        symbols=tuple(
            symbol.strip().upper()
            for symbol in str(args.symbols or "").split(",")
            if symbol.strip()
        ),
        replay_tape_path=(
            Path(replay_tape_path).resolve()
            if (replay_tape_path := getattr(args, "replay_tape_path", None)) is not None
            else None
        ),
        replay_tape_manifest_path=(
            Path(replay_tape_manifest).resolve()
            if (replay_tape_manifest := getattr(args, "replay_tape_manifest", None))
            is not None
            else None
        ),
        allow_stale_tape=bool(getattr(args, "allow_stale_tape", False)),
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
        capture_traces=(
            bool(getattr(args, "collect_traces", False))
            or args.trace_output is not None
            or args.funnel_output is not None
            or args.near_misses_output is not None
        ),
        capture_trace_funnel=bool(getattr(args, "collect_trace_funnel", False)),
        capture_exact_replay_ledger=(
            getattr(args, "exact_replay_ledger_output", None) is not None
        ),
        force_position_isolation=bool(getattr(args, "force_position_isolation", False)),
        max_executable_spread_bps=Decimal(str(args.max_executable_spread_bps)),
        max_quote_mid_jump_bps=Decimal(str(args.max_quote_mid_jump_bps)),
        max_jump_with_wide_spread_bps=Decimal(str(args.max_jump_with_wide_spread_bps)),
        clickhouse_query_timeout_seconds=max(
            1,
            int(
                getattr(
                    args,
                    "clickhouse_query_timeout_seconds",
                    DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
                )
            ),
        ),
    )
    payload = run_replay(config)
    if args.trace_output:
        args.trace_output.write_text(
            "".join(
                json.dumps(item, sort_keys=True) + "\n" for item in payload["trace"]
            ),
            encoding="utf-8",
        )
    if args.funnel_output:
        args.funnel_output.write_text(
            json.dumps(payload["funnel"], indent=2, sort_keys=True),
            encoding="utf-8",
        )
    if args.near_misses_output:
        args.near_misses_output.write_text(
            json.dumps(payload["near_misses"], indent=2, sort_keys=True),
            encoding="utf-8",
        )
    exact_replay_ledger_output = getattr(args, "exact_replay_ledger_output", None)
    if exact_replay_ledger_output is not None:
        exact_replay_ledger_output.write_text(
            json.dumps(payload["exact_replay_ledger"], indent=2, sort_keys=True),
            encoding="utf-8",
        )
    if args.json:
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        return
    print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
