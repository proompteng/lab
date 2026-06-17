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
from typing import cast

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

from .shared_context import (
    AUTHORITY_CANDIDATE_READY,
    AUTHORITY_DISTRIBUTION_MISSING,
    CANDIDATE_CONFIG_MISMATCH_BLOCKER,
    CensusIdentity,
    CensusSourceRows,
    ECONOMICS_MISSING,
    LADDER_BLOCKED,
    LADDER_MISSING,
    LADDER_PASS,
    LIFECYCLE_MISSING,
    NO_SOURCE_ACTIVITY,
    OPEN_POSITIONS,
    SCHEMA_VERSION,
    SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER,
    SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER,
    SOURCE_REFS_MISSING,
    SUBMITTED_ORDERS_MISSING_BLOCKER,
    _DISTRIBUTION_BLOCKERS,
    _ECONOMICS_BLOCKERS,
    _LIFECYCLE_BLOCKERS,
    _PRIMARY_LIFECYCLE_BLOCKERS,
    _SOURCE_REF_BLOCKERS,
    _authority_scope_rows,
    _load_session_rows,
    _source_account_label,
    _sqlalchemy_dsn,
    build_source_proof_census,
    census_json,
    load_dsn_rows,
    load_fixture_rows,
    parse_args,
)
from .source_event_row_matches_identity import (
    _daily_census,
    _daily_payload,
    _effective_linked_order_event_fill_count,
    _event_quantity_present,
    _event_source_offset_present,
    _fill_event,
    _filled_execution,
    _ledger_row_matches_identity,
    _linked_execution_id,
    _mapping_aliases_target,
    _optional_row_ref_matches,
    _payload_identifier_values,
    _row_account_label,
    _row_aliases_target_account,
    _row_has_any_ref,
    _row_ids,
    _row_ref_matches,
    _row_ref_mismatches,
    _row_text_values,
    _source_account_event_scope_diagnostics,
    _source_account_window_scope_diagnostics,
    _source_event_has_canonical_ref_mismatch,
    _source_event_ref_diagnostics,
    _source_event_row_matches_identity,
    _source_window_has_canonical_ref_mismatch,
    _source_window_row_matches_identity,
    _sum_daily_int,
    _text_values,
    _unique_row_value_map,
    _value_mentions_text,
)


def _mapping(value: object) -> Mapping[str, object]:
    from .parse_timestamp import _mapping as owned

    return owned(value)


def _sequence(value: object) -> Sequence[object]:
    from .parse_timestamp import _sequence as owned

    return owned(value)


def _text(value: object, *, default: str | None = None) -> str | None:
    from .parse_timestamp import _text as owned

    return owned(value, default=default)


def _int(value: object) -> int:
    from .parse_timestamp import _int as owned

    return owned(value)


def _decimal(value: object) -> Decimal:
    from .parse_timestamp import _decimal as owned

    return owned(value)


def _totals(
    rows: CensusSourceRows,
    daily: Sequence[Mapping[str, object]],
    ledger_report: Mapping[str, object],
    *,
    candidate_config_match: Mapping[str, object],
) -> dict[str, object]:
    aggregate = _mapping(ledger_report.get("aggregate"))
    daily_ledger = [
        _mapping(item) for item in _sequence(ledger_report.get("trading_days"))
    ]
    source_authority_bucket_count = _int(aggregate.get("source_authority_bucket_count"))
    runtime_ledger_bucket_count = len(rows.runtime_ledger_buckets)
    explicit_cost_runtime_ledger_bucket_count = _int(
        aggregate.get("explicit_cost_bucket_count")
    )
    event_ref_diagnostics = _source_event_ref_diagnostics(
        rows.execution_order_events,
        executions=rows.executions,
        trade_decisions=rows.trade_decisions,
    )
    return {
        "trade_decision_count": len(rows.trade_decisions),
        "matched_trade_decision_count": len(rows.trade_decisions),
        "execution_count": len(rows.executions),
        "filled_execution_count": sum(
            1 for row in rows.executions if _filled_execution(row)
        ),
        "execution_order_event_count": len(rows.execution_order_events),
        "fill_lifecycle_event_count": sum(
            1 for row in rows.execution_order_events if _fill_event(row)
        ),
        "linked_order_event_fill_count": _effective_linked_order_event_fill_count(
            rows.execution_order_events,
            executions=rows.executions,
            trade_decisions=rows.trade_decisions,
        ),
        "execution_order_events_with_execution_ref_count": event_ref_diagnostics[
            "effective_execution_ref_count"
        ],
        "execution_order_events_with_direct_execution_ref_count": event_ref_diagnostics[
            "direct_execution_ref_count"
        ],
        "execution_order_events_with_trade_decision_ref_count": event_ref_diagnostics[
            "effective_trade_decision_ref_count"
        ],
        "execution_order_events_with_direct_trade_decision_ref_count": event_ref_diagnostics[
            "direct_trade_decision_ref_count"
        ],
        "execution_order_events_with_broker_order_link_count": event_ref_diagnostics[
            "broker_order_link_count"
        ],
        "execution_order_events_with_client_order_link_count": event_ref_diagnostics[
            "client_order_link_count"
        ],
        "execution_order_events_with_filled_notional_delta_count": sum(
            1
            for row in rows.execution_order_events
            if _decimal(row.get("filled_notional_delta")) > 0
        ),
        "execution_order_events_with_quantity_count": sum(
            1 for row in rows.execution_order_events if _event_quantity_present(row)
        ),
        "execution_order_events_with_avg_price_count": sum(
            1
            for row in rows.execution_order_events
            if _decimal(row.get("avg_fill_price")) > 0
        ),
        "tca_cost_row_count": len(rows.execution_tca_metrics),
        "tca_cost_rows_with_execution_ref_count": sum(
            1
            for row in rows.execution_tca_metrics
            if _text(row.get("execution_id")) is not None
        ),
        "tca_cost_rows_with_trade_decision_ref_count": sum(
            1
            for row in rows.execution_tca_metrics
            if _text(row.get("trade_decision_id")) is not None
        ),
        "source_window_count": len(rows.order_feed_source_windows),
        "execution_order_events_with_source_window_count": sum(
            1
            for row in rows.execution_order_events
            if _text(row.get("source_window_id")) is not None
        ),
        "execution_order_events_with_source_offset_count": sum(
            1
            for row in rows.execution_order_events
            if _event_source_offset_present(row)
        ),
        "execution_order_events_with_source_window_and_offset_count": sum(
            1
            for row in rows.execution_order_events
            if _text(row.get("source_window_id")) is not None
            and _event_source_offset_present(row)
        ),
        "execution_tca_metric_count": len(rows.execution_tca_metrics),
        "runtime_ledger_bucket_count": runtime_ledger_bucket_count,
        "blocker_free_runtime_ledger_bucket_count": source_authority_bucket_count,
        "runtime_ledger_evidence_grade_bucket_count": _int(
            aggregate.get("clean_authority_bucket_count")
        ),
        "runtime_ledger_aggregate_only_bucket_count": max(
            0, runtime_ledger_bucket_count - source_authority_bucket_count
        ),
        "runtime_submitted_order_count": _sum_daily_int(
            daily_ledger, "submitted_order_count"
        ),
        "runtime_ledger_source_materialization_count": _sum_daily_int(
            daily_ledger, "source_materialization_count"
        ),
        "runtime_ledger_clean_authority_trading_day_count": _int(
            aggregate.get("clean_authority_trading_day_count")
        ),
        "explicit_cost_runtime_ledger_bucket_count": explicit_cost_runtime_ledger_bucket_count,
        "explicit_cost_required_bucket_count": runtime_ledger_bucket_count,
        "explicit_cost_coverage_complete": runtime_ledger_bucket_count == 0
        or explicit_cost_runtime_ledger_bucket_count >= runtime_ledger_bucket_count,
        "runtime_ledger_buckets_with_filled_notional_count": sum(
            1
            for row in rows.runtime_ledger_buckets
            if _decimal(row.get("filled_notional")) > 0
        ),
        "closed_trade_count": _int(aggregate.get("closed_round_trips")),
        "open_position_count": _int(aggregate.get("open_position_count")),
        "filled_notional": _text(aggregate.get("total_filled_notional"), default="0"),
        "target_implied_notional_gap": _text(
            aggregate.get("target_implied_notional_gap"), default="0"
        ),
        "post_cost_pnl": _text(
            aggregate.get("total_net_strategy_pnl_after_costs"), default="0"
        ),
        "trading_day_count": len(daily),
        "candidate_config_match": bool(candidate_config_match.get("matches")),
        "candidate_config_mismatch_count": _int(
            candidate_config_match.get("mismatch_count")
        ),
        "candidate_matched_runtime_ledger_bucket_count": _int(
            candidate_config_match.get("matched_runtime_ledger_bucket_count")
        ),
        "candidate_mismatched_runtime_ledger_bucket_count": _int(
            candidate_config_match.get("mismatched_runtime_ledger_bucket_count")
        ),
        "source_account_alias_only_order_event_count": _int(
            candidate_config_match.get("source_account_alias_only_order_event_count")
        ),
        "source_account_canonical_ref_mismatch_order_event_count": _int(
            candidate_config_match.get(
                "source_account_canonical_ref_mismatch_order_event_count"
            )
        ),
        "source_account_alias_only_source_window_count": _int(
            candidate_config_match.get("source_account_alias_only_source_window_count")
        ),
        "source_account_canonical_ref_mismatch_source_window_count": _int(
            candidate_config_match.get(
                "source_account_canonical_ref_mismatch_source_window_count"
            )
        ),
    }


def _candidate_config_match(
    rows: CensusSourceRows,
    identity: CensusIdentity,
    ledger_report: Mapping[str, object],
) -> dict[str, object]:
    """Summarize whether read rows match the requested H-PAIRS candidate/config."""

    scoped_rows = _authority_scope_rows(rows, identity)
    scoped_order_event_ids = _row_ids(scoped_rows.execution_order_events)
    scoped_source_window_ids = _row_ids(scoped_rows.order_feed_source_windows)
    source_account_label = _source_account_label(identity)
    ledger_decision_ids = _payload_identifier_values(
        scoped_rows.runtime_ledger_buckets,
        "trade_decision_ids",
        "decision_ids",
        "decision_hashes",
    )
    ledger_execution_ids = _payload_identifier_values(
        scoped_rows.runtime_ledger_buckets, "execution_ids"
    )
    ledger_source_window_ids = _payload_identifier_values(
        scoped_rows.runtime_ledger_buckets,
        "source_window_ids",
        "runtime_ledger_source_window_ids",
    )
    source_account_event_diagnostics = _source_account_event_scope_diagnostics(
        rows.execution_order_events,
        source_account_label=source_account_label,
        target_account_label=identity.account_label,
        canonical_decision_ids=_row_ids(scoped_rows.trade_decisions)
        | ledger_decision_ids,
        canonical_execution_ids=_row_ids(scoped_rows.executions) | ledger_execution_ids,
        canonical_order_ids=_row_text_values(scoped_rows.executions, "alpaca_order_id"),
        canonical_client_order_ids=_row_text_values(
            scoped_rows.executions, "client_order_id"
        )
        | _row_text_values(scoped_rows.trade_decisions, "decision_hash"),
    )
    source_account_window_diagnostics = _source_account_window_scope_diagnostics(
        rows.order_feed_source_windows,
        source_account_label=source_account_label,
        target_account_label=identity.account_label,
        canonical_source_window_ids=scoped_source_window_ids | ledger_source_window_ids,
    )
    trade_decision_mismatches = sum(
        1
        for row in rows.trade_decisions
        if _text(row.get("strategy_name")) not in (None, identity.runtime_strategy_name)
        or _text(row.get("alpaca_account_label")) not in (None, identity.account_label)
    )
    execution_mismatches = sum(
        1
        for row in rows.executions
        if _text(row.get("alpaca_account_label")) not in (None, identity.account_label)
    )
    order_event_mismatches = sum(
        1
        for row in rows.execution_order_events
        if _text(row.get("id")) not in scoped_order_event_ids
    )
    tca_metric_mismatches = sum(
        1
        for row in rows.execution_tca_metrics
        if _text(row.get("alpaca_account_label")) not in (None, identity.account_label)
    )
    source_window_mismatches = sum(
        1
        for row in rows.order_feed_source_windows
        if _text(row.get("id")) not in scoped_source_window_ids
    )
    ledger_mismatches = [
        row
        for row in rows.runtime_ledger_buckets
        if _text(row.get("candidate_id")) not in (None, identity.candidate_id)
        or _text(row.get("hypothesis_id")) not in (None, identity.hypothesis_id)
        or _text(row.get("runtime_strategy_name"))
        not in (None, identity.runtime_strategy_name)
        or _text(row.get("account_label")) not in (None, identity.account_label)
        or _text(row.get("observed_stage")) not in (None, identity.observed_stage)
    ]
    aggregate = _mapping(ledger_report.get("aggregate"))
    runtime_ledger_bucket_count = len(rows.runtime_ledger_buckets)
    mismatch_count = (
        trade_decision_mismatches
        + execution_mismatches
        + order_event_mismatches
        + tca_metric_mismatches
        + source_window_mismatches
        + len(ledger_mismatches)
    )
    return {
        "matches": mismatch_count == 0,
        "mismatch_count": mismatch_count,
        "requested": {
            "hypothesis_id": identity.hypothesis_id,
            "candidate_id": identity.candidate_id,
            "runtime_strategy_name": identity.runtime_strategy_name,
            "account_label": identity.account_label,
            "source_account_label": _source_account_label(identity),
            "observed_stage": identity.observed_stage,
        },
        "trade_decision_mismatch_count": trade_decision_mismatches,
        "execution_mismatch_count": execution_mismatches,
        "execution_order_event_mismatch_count": order_event_mismatches,
        "execution_tca_metric_mismatch_count": tca_metric_mismatches,
        "order_feed_source_window_mismatch_count": source_window_mismatches,
        "source_account_alias_only_order_event_count": source_account_event_diagnostics[
            "alias_only_count"
        ],
        "source_account_canonical_ref_mismatch_order_event_count": source_account_event_diagnostics[
            "canonical_ref_mismatch_count"
        ],
        "source_account_alias_only_source_window_count": source_account_window_diagnostics[
            "alias_only_count"
        ],
        "source_account_canonical_ref_mismatch_source_window_count": source_account_window_diagnostics[
            "canonical_ref_mismatch_count"
        ],
        "matched_runtime_ledger_bucket_count": max(
            0, runtime_ledger_bucket_count - len(ledger_mismatches)
        ),
        "mismatched_runtime_ledger_bucket_count": len(ledger_mismatches),
        "runtime_authority_aggregate_bucket_count": _int(aggregate.get("bucket_count")),
    }


def _census_blockers(
    rows: CensusSourceRows,
    totals: Mapping[str, object],
    ledger_report: Mapping[str, object],
    *,
    read_error: str | None,
) -> list[str]:
    blockers: list[str] = []
    if read_error is not None:
        blockers.append("source_proof_census_read_error")
    if _int(totals.get("candidate_config_mismatch_count")) > 0:
        blockers.append(CANDIDATE_CONFIG_MISMATCH_BLOCKER)
    if (
        _int(totals.get("source_account_alias_only_order_event_count")) > 0
        or _int(totals.get("source_account_alias_only_source_window_count")) > 0
    ):
        blockers.append(SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER)
    if (
        _int(totals.get("source_account_canonical_ref_mismatch_order_event_count")) > 0
        or _int(totals.get("source_account_canonical_ref_mismatch_source_window_count"))
        > 0
    ):
        blockers.append(SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER)
    if _int(totals.get("trade_decision_count")) <= 0:
        blockers.extend(
            [
                AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
                RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
            ]
        )
    if _int(totals.get("execution_count")) <= 0:
        blockers.append(RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER)
    if _int(totals.get("filled_execution_count")) <= 0:
        blockers.append(AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER)
    if _int(totals.get("runtime_submitted_order_count")) <= 0:
        blockers.append(SUBMITTED_ORDERS_MISSING_BLOCKER)
    if _int(totals.get("execution_order_event_count")) <= 0:
        blockers.extend(
            [
                RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
                ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
            ]
        )
    if _int(totals.get("fill_lifecycle_event_count")) <= 0:
        blockers.append(ORDER_FEED_LIFECYCLE_MISSING_BLOCKER)
    if _int(totals.get("execution_order_events_with_execution_ref_count")) < _int(
        totals.get("execution_order_event_count")
    ):
        blockers.append(RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER)
    if _int(totals.get("execution_order_events_with_trade_decision_ref_count")) < _int(
        totals.get("execution_order_event_count")
    ):
        blockers.append(RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER)
    if _int(
        totals.get("execution_order_events_with_filled_notional_delta_count")
    ) < _int(totals.get("fill_lifecycle_event_count")):
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if _int(totals.get("tca_cost_row_count")) <= 0:
        blockers.extend(
            [AUTHORITY_EXPLICIT_COSTS_BLOCKER, EXECUTION_ECONOMICS_MISSING_BLOCKER]
        )
    if _int(totals.get("source_window_count")) <= 0:
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER)
    if _int(totals.get("execution_order_events_with_source_window_count")) < _int(
        totals.get("execution_order_event_count")
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER)
    if _int(totals.get("execution_order_events_with_source_offset_count")) < _int(
        totals.get("execution_order_event_count")
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER)
    if _int(totals.get("open_position_count")) > 0:
        blockers.append(AUTHORITY_OPEN_POSITIONS_BLOCKER)
    if _int(totals.get("closed_trade_count")) <= 0:
        blockers.append(AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER)
    if _decimal(totals.get("filled_notional")) <= 0:
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if rows.runtime_ledger_buckets and _int(
        totals.get("explicit_cost_runtime_ledger_bucket_count")
    ) < len(rows.runtime_ledger_buckets):
        blockers.append(AUTHORITY_EXPLICIT_COSTS_BLOCKER)
    if not rows.runtime_ledger_buckets:
        blockers.append(AUTHORITY_EVIDENCE_MISSING_BLOCKER)
    elif _int(totals.get("runtime_ledger_source_materialization_count")) < len(
        rows.runtime_ledger_buckets
    ):
        blockers.append(RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER)
    blockers.extend(str(item) for item in _sequence(ledger_report.get("blockers")))
    return sorted(dict.fromkeys(blockers))


def _missing_source_ref_categories(blockers: Sequence[str]) -> dict[str, bool]:
    return {code: code in blockers for code in sorted(_SOURCE_REF_BLOCKERS)}


def _missing_requirement_categories(blockers: Sequence[str]) -> dict[str, bool]:
    blocker_set = set(blockers)
    return {
        "filled_notional": AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER in blocker_set,
        "submitted_orders": SUBMITTED_ORDERS_MISSING_BLOCKER in blocker_set
        or ORDER_FEED_LIFECYCLE_MISSING_BLOCKER in blocker_set,
        "explicit_costs": AUTHORITY_EXPLICIT_COSTS_BLOCKER in blocker_set
        or EXECUTION_ECONOMICS_MISSING_BLOCKER in blocker_set,
        "closed_round_trip": AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER in blocker_set,
        "execution_refs": RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER in blocker_set,
        "execution_order_event_refs": RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER
        in blocker_set,
        "source_window_refs": RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER
        in blocker_set
        or RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER in blocker_set,
        "source_offsets": RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER in blocker_set,
        "tca_cost_rows": AUTHORITY_EXPLICIT_COSTS_BLOCKER in blocker_set,
    }


__all__ = [name for name in globals() if not name.startswith("__")]
