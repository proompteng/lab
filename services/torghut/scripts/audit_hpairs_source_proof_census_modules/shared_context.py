# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false
#!/usr/bin/env python
"""Read-only H-PAIRS/TORGHUT_SIM source-proof census/readback CLI.

This command deliberately performs diagnostics only: it reads SQLAlchemy rows or
fixture JSON and emits a deterministic machine-readable census of the gap between
paper-route activity and authority-grade runtime-ledger proof. It never writes
proof artifacts, promotion state, or database rows.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence, Set
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast

from sqlalchemy import create_engine, or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
    Strategy,
    TradeDecision,
)
from app.trading.runtime_authority_verifier import (
    AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER,
    AUTHORITY_BUCKET_BLOCKERS_PRESENT,
    AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
    AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
    AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
    AUTHORITY_MEAN_PNL_BLOCKER,
    AUTHORITY_MEDIAN_PNL_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_P10_PNL_BLOCKER,
    AUTHORITY_READ_ERROR_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    AUTHORITY_TRADING_DAYS_BLOCKER,
    AUTHORITY_WORST_DAY_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    build_runtime_authority_report,
    load_runtime_authority_rows,
)
from app.trading.runtime_ledger_source_authority import (
    EXECUTION_ECONOMICS_MISSING_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
)

# ruff: noqa: F401,F811,F821


SCHEMA_VERSION = "torghut.hpairs-source-proof-census.v1"

AUTHORITY_CANDIDATE_READY = "authority_candidate_ready"

NO_SOURCE_ACTIVITY = "no_source_activity"

LIFECYCLE_MISSING = "lifecycle_missing"

ECONOMICS_MISSING = "economics_missing"

SOURCE_REFS_MISSING = "source_refs_missing"

OPEN_POSITIONS = "open_positions"

AUTHORITY_DISTRIBUTION_MISSING = "authority_distribution_missing"

CANDIDATE_CONFIG_MISMATCH_BLOCKER = "candidate_config_mismatch"

SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER = (
    "source_account_alias_only_source_proof"
)

SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER = "source_account_canonical_ref_mismatch"

LADDER_PASS = "pass"

LADDER_MISSING = "missing"

LADDER_BLOCKED = "blocked"

SUBMITTED_ORDERS_MISSING_BLOCKER = "submitted_orders_missing"

_SOURCE_REF_BLOCKERS = frozenset(
    {
        RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
        RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
        ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER,
        SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER,
        SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER,
    }
)

_DISTRIBUTION_BLOCKERS = frozenset(
    {
        AUTHORITY_EVIDENCE_MISSING_BLOCKER,
        AUTHORITY_TRADING_DAYS_BLOCKER,
        AUTHORITY_MEAN_PNL_BLOCKER,
        AUTHORITY_MEDIAN_PNL_BLOCKER,
        AUTHORITY_P10_PNL_BLOCKER,
        AUTHORITY_WORST_DAY_BLOCKER,
        AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER,
        AUTHORITY_FILLED_NOTIONAL_BLOCKER,
        AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
    }
)

_LIFECYCLE_BLOCKERS = frozenset(
    {
        AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
        AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
        AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
        ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
        SUBMITTED_ORDERS_MISSING_BLOCKER,
    }
)

_PRIMARY_LIFECYCLE_BLOCKERS = frozenset(
    {
        AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
        AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    }
)

_ECONOMICS_BLOCKERS = frozenset(
    {
        AUTHORITY_EXPLICIT_COSTS_BLOCKER,
        AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
        EXECUTION_ECONOMICS_MISSING_BLOCKER,
    }
)


def _facade_attr(name: str, fallback: object) -> object:
    facade = sys.modules.get("scripts.audit_hpairs_source_proof_census")
    if facade is None:
        return fallback
    return getattr(facade, name, fallback)


@dataclass(frozen=True)
class CensusIdentity:
    hypothesis_id: str
    candidate_id: str
    runtime_strategy_name: str
    account_label: str
    observed_stage: str | None
    source_account_label: str | None = None


@dataclass
class CensusSourceRows:
    trade_decisions: list[Mapping[str, object]] = field(default_factory=list)
    executions: list[Mapping[str, object]] = field(default_factory=list)
    execution_order_events: list[Mapping[str, object]] = field(default_factory=list)
    execution_tca_metrics: list[Mapping[str, object]] = field(default_factory=list)
    order_feed_source_windows: list[Mapping[str, object]] = field(default_factory=list)
    runtime_ledger_buckets: list[Mapping[str, object]] = field(default_factory=list)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--dsn", help="SQLAlchemy DSN to read with a short read-only session"
    )
    source.add_argument(
        "--fixture-json", type=Path, help="Fixture JSON containing source row arrays"
    )
    parser.add_argument("--hypothesis-id", default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument("--candidate-id", default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument(
        "--runtime-strategy-name", default=DEFAULT_HPAIRS_RUNTIME_STRATEGY
    )
    parser.add_argument("--account-label", default=DEFAULT_HPAIRS_ACCOUNT_LABEL)
    parser.add_argument(
        "--source-account-label",
        default="",
        help=(
            "Optional source/broker account label to reconcile against the logical "
            "--account-label. Source-account rows only count when linked to the "
            "logical account by durable decision/execution refs or alias payloads."
        ),
    )
    parser.add_argument("--observed-stage", default="paper")
    parser.add_argument("--start", dest="started_at")
    parser.add_argument("--end", dest="ended_at")
    parser.add_argument(
        "--fail-on-blockers",
        action="store_true",
        help="exit non-zero unless the census verdict is authority_candidate_ready",
    )
    return parser.parse_args(argv)


def build_source_proof_census(
    rows: CensusSourceRows,
    *,
    identity: CensusIdentity,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
    read_error: str | None = None,
    source_kind: str = "fixture_json",
) -> dict[str, object]:
    """Build a deterministic source-proof census from already-read rows."""

    from .blocker_ladder import (
        _blocker_ladder,
        _classify_verdict,
        _next_action,
        _next_ladder_blocker,
    )
    from .parse_timestamp import _isoformat
    from .source_event_row_matches_identity import _daily_census
    from .totals import (
        _candidate_config_match,
        _census_blockers,
        _missing_requirement_categories,
        _missing_source_ref_categories,
        _totals,
    )

    scoped_rows = _authority_scope_rows(rows, identity)
    ledger_report = build_runtime_authority_report(
        scoped_rows.runtime_ledger_buckets,
        hypothesis_id=identity.hypothesis_id,
        candidate_id=identity.candidate_id,
        runtime_strategy_name=identity.runtime_strategy_name,
        account_label=identity.account_label,
        observed_stage=identity.observed_stage,
        started_at=started_at,
        ended_at=ended_at,
        evidence_read_error=read_error,
    )
    daily = _daily_census(scoped_rows, ledger_report)
    candidate_config_match = _candidate_config_match(rows, identity, ledger_report)
    totals = _totals(
        scoped_rows,
        daily,
        ledger_report,
        candidate_config_match=candidate_config_match,
    )
    blockers = _census_blockers(
        scoped_rows, totals, ledger_report, read_error=read_error
    )
    missing_source_ref_categories = _missing_source_ref_categories(blockers)
    missing_requirement_categories = _missing_requirement_categories(blockers)
    blocker_ladder = _blocker_ladder(
        totals,
        daily,
        ledger_report,
        blockers,
        observed_stage=identity.observed_stage,
        source_kind=source_kind,
    )
    classification = _classify_verdict(totals, blockers)
    return {
        "schema_version": SCHEMA_VERSION,
        "identity": {
            "hypothesis_id": identity.hypothesis_id,
            "candidate_id": identity.candidate_id,
            "runtime_strategy_name": identity.runtime_strategy_name,
            "account_label": identity.account_label,
            "source_account_label": _source_account_label(identity),
            "observed_stage": identity.observed_stage,
        },
        "window": {
            "started_at": _isoformat(started_at) if started_at is not None else None,
            "ended_at": _isoformat(ended_at) if ended_at is not None else None,
        },
        "source": {
            "kind": source_kind,
            "read_only": True,
            "writes_proof": False,
            "modifies_rows": False,
            "runtime_stage": identity.observed_stage,
            "account_label": identity.account_label,
            "source_account_label": _source_account_label(identity),
            "replay_outputs_count_as_runtime_proof": False,
            "synthetic_proof_created": False,
        },
        "totals": totals,
        "candidate_config_match": candidate_config_match,
        "daily": daily,
        "runtime_authority": {
            "final_authority_ok": ledger_report["final_authority_ok"],
            "blockers": ledger_report["blockers"],
            "aggregate": ledger_report["aggregate"],
        },
        "missing_source_ref_categories": missing_source_ref_categories,
        "missing_requirement_categories": missing_requirement_categories,
        "blocker_ladder": blocker_ladder,
        "blockers": blockers,
        "verdict": {
            "classification": classification,
            "authority_candidate_ready": classification == AUTHORITY_CANDIDATE_READY,
            "next_blocker": _next_ladder_blocker(blocker_ladder),
            "next_action": _next_action(classification),
        },
    }


def census_json(report: Mapping[str, object]) -> str:
    """Serialize a census as stable JSON."""

    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def load_fixture_rows(path: Path) -> CensusSourceRows:
    from .blocker_ladder import _row_list
    from .parse_timestamp import _mapping

    payload = json.loads(path.read_text())
    data = _mapping(payload)
    return CensusSourceRows(
        trade_decisions=_row_list(data.get("trade_decisions")),
        executions=_row_list(data.get("executions")),
        execution_order_events=_row_list(data.get("execution_order_events")),
        execution_tca_metrics=_row_list(
            data.get("execution_tca_metrics") or data.get("tca_metrics")
        ),
        order_feed_source_windows=_row_list(
            data.get("order_feed_source_windows") or data.get("source_windows")
        ),
        runtime_ledger_buckets=_row_list(data.get("runtime_ledger_buckets")),
    )


def load_dsn_rows(
    dsn: str,
    *,
    identity: CensusIdentity,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> CensusSourceRows:
    """Read only the bounded H-PAIRS source rows needed for the census."""

    create_engine_fn = cast(Any, _facade_attr("create_engine", create_engine))
    sessionmaker_fn = cast(Any, _facade_attr("sessionmaker", sessionmaker))
    load_rows = cast(Any, _facade_attr("_load_session_rows", _load_session_rows))
    engine = create_engine_fn(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    session_factory = sessionmaker_fn(bind=engine)
    with session_factory() as session:
        return load_rows(
            session,
            identity=identity,
            started_at=started_at,
            ended_at=ended_at,
        )


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _load_session_rows(
    session: Session,
    *,
    identity: CensusIdentity,
    started_at: datetime | None,
    ended_at: datetime | None,
) -> CensusSourceRows:
    from .blocker_ladder import (
        _decision_projection_row,
        _execution_row,
        _order_event_row,
        _source_window_row,
        _tca_row,
    )
    from .parse_timestamp import _text
    from .source_event_row_matches_identity import _row_text_values

    source_account_label = _source_account_label(identity)
    account_labels = sorted({identity.account_label, source_account_label})
    decision_stmt = (
        select(
            TradeDecision.id.label("id"),
            TradeDecision.strategy_id.label("strategy_id"),
            Strategy.name.label("strategy_name"),
            TradeDecision.alpaca_account_label.label("alpaca_account_label"),
            TradeDecision.symbol.label("symbol"),
            TradeDecision.status.label("status"),
            TradeDecision.decision_hash.label("decision_hash"),
            TradeDecision.created_at.label("created_at"),
            TradeDecision.executed_at.label("executed_at"),
        )
        .join(Strategy, TradeDecision.strategy_id == Strategy.id)
        .where(TradeDecision.alpaca_account_label == identity.account_label)
        .where(Strategy.name == identity.runtime_strategy_name)
        .order_by(TradeDecision.created_at.asc(), TradeDecision.id.asc())
    )
    if started_at is not None:
        decision_stmt = decision_stmt.where(TradeDecision.created_at >= started_at)
    if ended_at is not None:
        decision_stmt = decision_stmt.where(TradeDecision.created_at < ended_at)
    decision_rows = list(session.execute(decision_stmt).mappings().all())
    decisions = [_decision_projection_row(row) for row in decision_rows]
    decision_ids = {str(row["id"]) for row in decision_rows}

    execution_stmt = (
        select(Execution)
        .where(Execution.alpaca_account_label == identity.account_label)
        .order_by(Execution.created_at.asc(), Execution.id.asc())
    )
    if started_at is not None:
        execution_stmt = execution_stmt.where(Execution.created_at >= started_at)
    if ended_at is not None:
        execution_stmt = execution_stmt.where(Execution.created_at < ended_at)
    if decision_ids:
        execution_stmt = execution_stmt.where(
            Execution.trade_decision_id.in_(decision_ids)
        )
    executions = [_execution_row(row) for row in session.scalars(execution_stmt).all()]
    execution_ids = {str(row["id"]) for row in executions}
    execution_order_ids = _row_text_values(executions, "alpaca_order_id")
    client_order_ids = _row_text_values(
        executions, "client_order_id"
    ) | _row_text_values(decisions, "decision_hash")

    event_stmt = (
        select(ExecutionOrderEvent)
        .where(ExecutionOrderEvent.alpaca_account_label.in_(account_labels))
        .order_by(
            ExecutionOrderEvent.event_ts.asc().nulls_last(),
            ExecutionOrderEvent.created_at.asc(),
            ExecutionOrderEvent.id.asc(),
        )
    )
    if started_at is not None:
        event_stmt = event_stmt.where(
            or_(
                ExecutionOrderEvent.event_ts >= started_at,
                ExecutionOrderEvent.created_at >= started_at,
            )
        )
    if ended_at is not None:
        event_stmt = event_stmt.where(
            or_(
                ExecutionOrderEvent.event_ts < ended_at,
                ExecutionOrderEvent.created_at < ended_at,
            )
        )
    if decision_ids or execution_ids or execution_order_ids or client_order_ids:
        event_filters = []
        if decision_ids:
            event_filters.append(
                ExecutionOrderEvent.trade_decision_id.in_(decision_ids)
            )
        if execution_ids:
            event_filters.append(ExecutionOrderEvent.execution_id.in_(execution_ids))
        if execution_order_ids:
            event_filters.append(
                ExecutionOrderEvent.alpaca_order_id.in_(execution_order_ids)
            )
        if client_order_ids:
            event_filters.append(
                ExecutionOrderEvent.client_order_id.in_(client_order_ids)
            )
        event_stmt = event_stmt.where(or_(*event_filters))
    else:
        event_stmt = event_stmt.where(
            ExecutionOrderEvent.alpaca_account_label == identity.account_label
        )
    order_events = [_order_event_row(row) for row in session.scalars(event_stmt).all()]
    order_event_source_window_ids = {
        source_window_id
        for row in order_events
        if (source_window_id := _text(row.get("source_window_id"))) is not None
    }

    tca_stmt = (
        select(ExecutionTCAMetric)
        .where(ExecutionTCAMetric.alpaca_account_label == identity.account_label)
        .order_by(ExecutionTCAMetric.computed_at.asc(), ExecutionTCAMetric.id.asc())
    )
    if started_at is not None:
        tca_stmt = tca_stmt.where(ExecutionTCAMetric.computed_at >= started_at)
    if ended_at is not None:
        tca_stmt = tca_stmt.where(ExecutionTCAMetric.computed_at < ended_at)
    if decision_ids or execution_ids:
        tca_filters = []
        if decision_ids:
            tca_filters.append(ExecutionTCAMetric.trade_decision_id.in_(decision_ids))
        if execution_ids:
            tca_filters.append(ExecutionTCAMetric.execution_id.in_(execution_ids))
        tca_stmt = tca_stmt.where(or_(*tca_filters))
    tca_metrics = [_tca_row(row) for row in session.scalars(tca_stmt).all()]

    source_window_stmt = select(OrderFeedSourceWindow).order_by(
        OrderFeedSourceWindow.window_started_at.asc(),
        OrderFeedSourceWindow.id.asc(),
    )
    source_window_account_filters = [
        OrderFeedSourceWindow.alpaca_account_label == identity.account_label
    ]
    if source_account_label != identity.account_label and order_event_source_window_ids:
        source_window_account_filters.append(
            (OrderFeedSourceWindow.alpaca_account_label == source_account_label)
            & OrderFeedSourceWindow.id.in_(order_event_source_window_ids)
        )
    source_window_stmt = source_window_stmt.where(or_(*source_window_account_filters))
    if started_at is not None:
        source_window_stmt = source_window_stmt.where(
            OrderFeedSourceWindow.window_ended_at >= started_at
        )
    if ended_at is not None:
        source_window_stmt = source_window_stmt.where(
            OrderFeedSourceWindow.window_started_at < ended_at
        )
    source_windows = [
        _source_window_row(row) for row in session.scalars(source_window_stmt).all()
    ]

    load_authority_rows = cast(
        Any,
        _facade_attr("load_runtime_authority_rows", load_runtime_authority_rows),
    )
    ledger_rows = load_authority_rows(
        session,
        hypothesis_id=identity.hypothesis_id,
        candidate_id=identity.candidate_id,
        runtime_strategy_name=identity.runtime_strategy_name,
        account_label=identity.account_label,
        observed_stage=identity.observed_stage,
        started_at=started_at,
        ended_at=ended_at,
    )
    runtime_ledger_buckets = [
        {
            "id": row.row_id,
            "run_id": row.run_id,
            "candidate_id": row.candidate_id,
            "hypothesis_id": row.hypothesis_id,
            "observed_stage": row.observed_stage,
            "bucket_started_at": row.bucket_started_at,
            "bucket_ended_at": row.bucket_ended_at,
            "account_label": row.account_label,
            "runtime_strategy_name": row.runtime_strategy_name,
            "strategy_family": row.strategy_family,
            "fill_count": row.fill_count,
            "decision_count": row.decision_count,
            "submitted_order_count": row.submitted_order_count,
            "cancelled_order_count": row.cancelled_order_count,
            "rejected_order_count": row.rejected_order_count,
            "unfilled_order_count": row.unfilled_order_count,
            "closed_trade_count": row.closed_trade_count,
            "open_position_count": row.open_position_count,
            "filled_notional": row.filled_notional,
            "gross_strategy_pnl": row.gross_strategy_pnl,
            "cost_amount": row.cost_amount,
            "net_strategy_pnl_after_costs": row.net_strategy_pnl_after_costs,
            "post_cost_expectancy_bps": row.post_cost_expectancy_bps,
            "ledger_schema_version": row.ledger_schema_version,
            "pnl_basis": row.pnl_basis,
            "execution_policy_hash_counts": dict(row.execution_policy_hash_counts),
            "cost_model_hash_counts": dict(row.cost_model_hash_counts),
            "lineage_hash_counts": dict(row.lineage_hash_counts),
            "blockers": list(row.blockers),
            "payload": dict(row.payload),
        }
        for row in ledger_rows
    ]
    return CensusSourceRows(
        trade_decisions=decisions,
        executions=executions,
        execution_order_events=order_events,
        execution_tca_metrics=tca_metrics,
        order_feed_source_windows=source_windows,
        runtime_ledger_buckets=runtime_ledger_buckets,
    )


def _source_account_label(identity: CensusIdentity) -> str:
    return (identity.source_account_label or "").strip() or identity.account_label


def _authority_scope_rows(
    rows: CensusSourceRows,
    identity: CensusIdentity,
) -> CensusSourceRows:
    """Return only rows allowed to contribute proof for the requested identity."""

    from .parse_timestamp import _text
    from .source_event_row_matches_identity import (
        _ledger_row_matches_identity,
        _optional_row_ref_matches,
        _payload_identifier_values,
        _row_account_label,
        _row_ids,
        _row_text_values,
        _source_event_row_matches_identity,
        _source_window_row_matches_identity,
    )

    source_account_label = _source_account_label(identity)
    target_account_label = identity.account_label
    scoped_trade_decisions = [
        row
        for row in rows.trade_decisions
        if _row_account_label(row) in (None, target_account_label)
        and _text(row.get("strategy_name")) in (None, identity.runtime_strategy_name)
    ]
    scoped_decision_ids = _row_ids(scoped_trade_decisions)
    scoped_executions = [
        row
        for row in rows.executions
        if _row_account_label(row) in (None, target_account_label)
        and _optional_row_ref_matches(row, "trade_decision_id", scoped_decision_ids)
    ]
    scoped_execution_ids = _row_ids(scoped_executions)
    scoped_tca_metrics = [
        row
        for row in rows.execution_tca_metrics
        if _row_account_label(row) in (None, target_account_label)
        and _optional_row_ref_matches(row, "trade_decision_id", scoped_decision_ids)
        and _optional_row_ref_matches(row, "execution_id", scoped_execution_ids)
    ]
    ledger_rows = [
        row
        for row in rows.runtime_ledger_buckets
        if _ledger_row_matches_identity(row, identity)
    ]
    ledger_decision_ids = _payload_identifier_values(
        ledger_rows,
        "trade_decision_ids",
        "decision_ids",
        "decision_hashes",
    )
    ledger_execution_ids = _payload_identifier_values(ledger_rows, "execution_ids")
    ledger_source_window_ids = _payload_identifier_values(
        ledger_rows,
        "source_window_ids",
        "runtime_ledger_source_window_ids",
    )
    canonical_decision_ids = scoped_decision_ids | ledger_decision_ids
    canonical_execution_ids = scoped_execution_ids | ledger_execution_ids
    canonical_order_ids = _row_text_values(scoped_executions, "alpaca_order_id")
    canonical_client_order_ids = _row_text_values(
        scoped_executions, "client_order_id"
    ) | _row_text_values(scoped_trade_decisions, "decision_hash")
    scoped_events = [
        row
        for row in rows.execution_order_events
        if _source_event_row_matches_identity(
            row,
            identity=identity,
            source_account_label=source_account_label,
            target_account_label=target_account_label,
            canonical_decision_ids=canonical_decision_ids,
            canonical_execution_ids=canonical_execution_ids,
            canonical_order_ids=canonical_order_ids,
            canonical_client_order_ids=canonical_client_order_ids,
        )
    ]
    scoped_event_source_window_ids = {
        source_window_id
        for row in scoped_events
        if (source_window_id := _text(row.get("source_window_id"))) is not None
    }
    canonical_source_window_ids = (
        scoped_event_source_window_ids | ledger_source_window_ids
    )
    scoped_source_windows = [
        row
        for row in rows.order_feed_source_windows
        if _source_window_row_matches_identity(
            row,
            identity=identity,
            source_account_label=source_account_label,
            target_account_label=target_account_label,
            canonical_source_window_ids=canonical_source_window_ids,
        )
    ]
    return CensusSourceRows(
        trade_decisions=scoped_trade_decisions,
        executions=scoped_executions,
        execution_order_events=scoped_events,
        execution_tca_metrics=scoped_tca_metrics,
        order_feed_source_windows=scoped_source_windows,
        runtime_ledger_buckets=ledger_rows,
    )


__all__ = (
    "SCHEMA_VERSION",
    "AUTHORITY_CANDIDATE_READY",
    "NO_SOURCE_ACTIVITY",
    "LIFECYCLE_MISSING",
    "ECONOMICS_MISSING",
    "SOURCE_REFS_MISSING",
    "OPEN_POSITIONS",
    "AUTHORITY_DISTRIBUTION_MISSING",
    "CANDIDATE_CONFIG_MISMATCH_BLOCKER",
    "SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER",
    "SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER",
    "LADDER_PASS",
    "LADDER_MISSING",
    "LADDER_BLOCKED",
    "SUBMITTED_ORDERS_MISSING_BLOCKER",
    "CensusIdentity",
    "CensusSourceRows",
    "parse_args",
    "build_source_proof_census",
    "census_json",
    "load_fixture_rows",
    "load_dsn_rows",
)
