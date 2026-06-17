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

# ruff: noqa: F401,F403,F405,F811,F821

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
    _text_values,
    _unique_row_value_map,
    _value_mentions_text,
)
from .totals import (
    _candidate_config_match,
    _census_blockers,
    _missing_requirement_categories,
    _missing_source_ref_categories,
    _totals,
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


def _parse_timestamp(value: object) -> datetime | None:
    from .parse_timestamp import _parse_timestamp as owned

    return owned(value)


def _blocker_ladder(
    totals: Mapping[str, object],
    daily: Sequence[Mapping[str, object]],
    ledger_report: Mapping[str, object],
    blockers: Sequence[str],
    *,
    observed_stage: str | None,
    source_kind: str,
) -> list[dict[str, object]]:
    """Return a compact, ordered read-only ladder that points at the next missing proof input."""

    aggregate = _mapping(ledger_report.get("aggregate"))
    daily_ledger = [
        _mapping(item) for item in _sequence(ledger_report.get("trading_days"))
    ]
    daily_pnl_blockers = {
        AUTHORITY_TRADING_DAYS_BLOCKER,
        AUTHORITY_MEAN_PNL_BLOCKER,
        AUTHORITY_MEDIAN_PNL_BLOCKER,
        AUTHORITY_P10_PNL_BLOCKER,
        AUTHORITY_WORST_DAY_BLOCKER,
        AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER,
    }
    return [
        _ladder_step(
            "candidate_config_match",
            blockers=blockers,
            step_blockers={CANDIDATE_CONFIG_MISMATCH_BLOCKER},
            present=bool(totals.get("candidate_config_match")),
            observed={
                "candidate_config_match": bool(totals.get("candidate_config_match")),
                "candidate_config_mismatch_count": _int(
                    totals.get("candidate_config_mismatch_count")
                ),
                "matched_runtime_ledger_bucket_count": _int(
                    totals.get("candidate_matched_runtime_ledger_bucket_count")
                ),
                "mismatched_runtime_ledger_bucket_count": _int(
                    totals.get("candidate_mismatched_runtime_ledger_bucket_count")
                ),
                "source_account_alias_only_order_event_count": _int(
                    totals.get("source_account_alias_only_order_event_count")
                ),
                "source_account_canonical_ref_mismatch_order_event_count": _int(
                    totals.get(
                        "source_account_canonical_ref_mismatch_order_event_count"
                    )
                ),
                "source_account_alias_only_source_window_count": _int(
                    totals.get("source_account_alias_only_source_window_count")
                ),
                "source_account_canonical_ref_mismatch_source_window_count": _int(
                    totals.get(
                        "source_account_canonical_ref_mismatch_source_window_count"
                    )
                ),
                "observed_stage": observed_stage,
            },
            next_action="rerun the read-only census with the intended H-PAIRS candidate/config and paper account",
        ),
        _ladder_step(
            "decisions_present",
            blockers=blockers,
            step_blockers={
                AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
                RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
            },
            present=_int(totals.get("trade_decision_count")) > 0,
            observed={
                "source_trade_decision_count": _int(totals.get("trade_decision_count")),
                "runtime_ledger_decision_count": _sum_daily_int(
                    daily_ledger, "decision_count"
                ),
                "observed_stage": observed_stage,
            },
            next_action="run the strategy through paper/live routing until durable TradeDecision rows exist",
        ),
        _ladder_step(
            "submitted_orders_present",
            blockers=blockers,
            step_blockers={
                SUBMITTED_ORDERS_MISSING_BLOCKER,
                ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
            },
            present=_int(totals.get("runtime_submitted_order_count")) > 0,
            observed={
                "runtime_submitted_order_count": _int(
                    totals.get("runtime_submitted_order_count")
                ),
                "source_execution_count": _int(totals.get("execution_count")),
                "observed_stage": observed_stage,
            },
            next_action="route selected H-PAIRS decisions as submitted paper/live orders before proof review",
        ),
        _ladder_step(
            "fill_lifecycle_present",
            blockers=blockers,
            step_blockers={
                AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
                ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
            },
            present=_int(totals.get("filled_execution_count")) > 0,
            observed={
                "source_execution_count": _int(totals.get("execution_count")),
                "source_filled_execution_count": _int(
                    totals.get("filled_execution_count")
                ),
                "runtime_ledger_fill_count": _sum_daily_int(daily_ledger, "fill_count"),
            },
            next_action="connect decisions to broker fills before relying on any replay-only result",
        ),
        _ladder_step(
            "linked_executions_present",
            blockers=blockers,
            step_blockers={
                RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
                RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
                RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
            },
            present=_int(totals.get("linked_order_event_fill_count")) > 0,
            observed={
                "execution_order_event_count": _int(
                    totals.get("execution_order_event_count")
                ),
                "fill_lifecycle_event_count": _int(
                    totals.get("fill_lifecycle_event_count")
                ),
                "linked_order_event_fill_count": _int(
                    totals.get("linked_order_event_fill_count")
                ),
                "events_with_execution_ref_count": _int(
                    totals.get("execution_order_events_with_execution_ref_count")
                ),
                "events_with_trade_decision_ref_count": _int(
                    totals.get("execution_order_events_with_trade_decision_ref_count")
                ),
            },
            next_action="materialize order-feed fill lifecycle events linked to executions and decisions",
        ),
        _ladder_step(
            "source_windows_refs_offsets_present",
            blockers=blockers,
            step_blockers={
                RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
                RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
                RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
                RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
                ORDER_FEED_SOURCE_WINDOW_GAP_BLOCKER,
                SOURCE_ACCOUNT_ALIAS_ONLY_SOURCE_PROOF_BLOCKER,
                SOURCE_ACCOUNT_CANONICAL_REF_MISMATCH_BLOCKER,
            },
            present=_int(totals.get("source_window_count")) > 0
            and _int(totals.get("execution_order_events_with_source_window_count"))
            >= _int(totals.get("execution_order_event_count"))
            and _int(totals.get("execution_order_events_with_source_offset_count"))
            >= _int(totals.get("execution_order_event_count")),
            observed={
                "source_window_count": _int(totals.get("source_window_count")),
                "events_with_source_window_count": _int(
                    totals.get("execution_order_events_with_source_window_count")
                ),
                "events_with_source_offset_count": _int(
                    totals.get("execution_order_events_with_source_offset_count")
                ),
                "events_with_source_window_and_offset_count": _int(
                    totals.get(
                        "execution_order_events_with_source_window_and_offset_count"
                    )
                ),
                "runtime_source_authority_bucket_count": _int(
                    totals.get("blocker_free_runtime_ledger_bucket_count")
                ),
            },
            next_action="backfill runtime-ledger source windows, offsets, refs, materialization, and authority class",
        ),
        _ladder_step(
            "runtime_ledger_source_materialization_present",
            blockers=blockers,
            step_blockers={
                AUTHORITY_EVIDENCE_MISSING_BLOCKER,
                AUTHORITY_READ_ERROR_BLOCKER,
                AUTHORITY_BUCKET_BLOCKERS_PRESENT,
                RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
                RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
            },
            present=_int(totals.get("runtime_ledger_bucket_count")) > 0
            and _int(totals.get("runtime_ledger_source_materialization_count"))
            >= _int(totals.get("runtime_ledger_bucket_count")),
            observed={
                "runtime_ledger_bucket_count": _int(
                    totals.get("runtime_ledger_bucket_count")
                ),
                "runtime_ledger_evidence_grade_bucket_count": _int(
                    totals.get("runtime_ledger_evidence_grade_bucket_count")
                ),
                "runtime_ledger_aggregate_only_bucket_count": _int(
                    totals.get("runtime_ledger_aggregate_only_bucket_count")
                ),
                "runtime_ledger_source_materialization_count": _int(
                    totals.get("runtime_ledger_source_materialization_count")
                ),
                "blocker_free_runtime_ledger_bucket_count": _int(
                    totals.get("blocker_free_runtime_ledger_bucket_count")
                ),
                "source_kind": source_kind,
                "read_only": True,
                "writes_proof": False,
            },
            next_action="emit durable runtime-ledger buckets from paper/live runtime rows without synthetic proof",
        ),
        _ladder_step(
            "closed_round_trips_present",
            blockers=blockers,
            step_blockers={
                AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
                AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
            },
            present=_int(totals.get("closed_trade_count")) > 0,
            observed={
                "closed_round_trip_count": _int(totals.get("closed_trade_count")),
                "authority_min_closed_round_trips": _int(
                    aggregate.get("authority_min_closed_round_trips")
                ),
            },
            next_action="wait for source-backed entry and exit fills that close round trips",
        ),
        _ladder_step(
            "explicit_costs_present",
            blockers=blockers,
            step_blockers={
                AUTHORITY_EXPLICIT_COSTS_BLOCKER,
                EXECUTION_ECONOMICS_MISSING_BLOCKER,
            },
            present=_int(totals.get("tca_cost_row_count")) > 0
            and _int(totals.get("explicit_cost_runtime_ledger_bucket_count")) > 0,
            observed={
                "tca_cost_row_count": _int(totals.get("tca_cost_row_count")),
                "execution_tca_metric_count": _int(
                    totals.get("execution_tca_metric_count")
                ),
                "explicit_cost_runtime_ledger_bucket_count": _int(
                    totals.get("explicit_cost_runtime_ledger_bucket_count")
                ),
                "explicit_cost_required_bucket_count": _int(
                    totals.get("explicit_cost_required_bucket_count")
                ),
                "explicit_cost_coverage_complete": bool(
                    totals.get("explicit_cost_coverage_complete")
                ),
                "total_explicit_costs": _text(
                    aggregate.get("total_explicit_costs"), default="0"
                ),
            },
            next_action="record broker/TCA costs and promotion-grade runtime cost bases for every bucket",
        ),
        _ladder_step(
            "filled_notional_present_and_target_implied",
            blockers=blockers,
            step_blockers={
                AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
                AUTHORITY_FILLED_NOTIONAL_BLOCKER,
            },
            present=_decimal(totals.get("filled_notional")) > 0
            and _decimal(totals.get("target_implied_notional_gap")) <= 0,
            observed={
                "filled_notional": _text(totals.get("filled_notional"), default="0"),
                "buckets_with_filled_notional_count": _int(
                    totals.get("runtime_ledger_buckets_with_filled_notional_count")
                ),
                "authority_min_filled_notional": _text(
                    aggregate.get("authority_min_filled_notional"), default="0"
                ),
                "target_implied_notional_gap": _text(
                    totals.get("target_implied_notional_gap"), default="0"
                ),
            },
            next_action="accumulate source-backed filled notional, including target-implied scale, not replay-only simulated volume",
        ),
        _ladder_step(
            "flat_no_open_positions_after_grace",
            blockers=blockers,
            step_blockers={AUTHORITY_OPEN_POSITIONS_BLOCKER},
            present=_int(totals.get("open_position_count")) == 0,
            observed={"open_position_count": _int(totals.get("open_position_count"))},
            next_action="flatten or let paper/live positions close before promotion",
        ),
        _ladder_step(
            "twenty_authority_grade_trading_days_daily_post_cost_distribution",
            blockers=blockers,
            step_blockers=daily_pnl_blockers,
            present=_int(totals.get("runtime_ledger_clean_authority_trading_day_count"))
            >= _int(aggregate.get("authority_min_trading_days")),
            observed={
                "trading_day_count": _int(totals.get("trading_day_count")),
                "clean_authority_trading_day_count": _int(
                    totals.get("runtime_ledger_clean_authority_trading_day_count")
                ),
                "authority_min_trading_days": _int(
                    aggregate.get("authority_min_trading_days")
                ),
                "post_cost_pnl": _text(totals.get("post_cost_pnl"), default="0"),
                "mean_daily_net_pnl_after_costs": _text(
                    aggregate.get("mean_daily_net_pnl_after_costs"), default="0"
                ),
                "median_daily_net_pnl_after_costs": _text(
                    aggregate.get("median_daily_net_pnl_after_costs"), default="0"
                ),
                "p10_daily_net_pnl_after_costs": _text(
                    aggregate.get("p10_daily_net_pnl_after_costs"), default="0"
                ),
                "worst_day_net_pnl_after_costs": _text(
                    aggregate.get("worst_day_net_pnl_after_costs"), default="0"
                ),
            },
            next_action="continue source-backed paper/live runtime until post-cost daily PnL clears gates",
        ),
    ]


def _ladder_step(
    step: str,
    *,
    blockers: Sequence[str],
    step_blockers: Set[str],
    present: bool,
    observed: Mapping[str, object],
    next_action: str,
) -> dict[str, object]:
    blocker_codes = sorted(code for code in blockers if code in step_blockers)
    if blocker_codes:
        status = LADDER_BLOCKED
    elif present:
        status = LADDER_PASS
    else:
        status = LADDER_MISSING
    return {
        "step": step,
        "status": status,
        "observed": dict(observed),
        "blocker_codes": blocker_codes,
        "next_action": next_action if status != LADDER_PASS else None,
    }


def _next_ladder_blocker(
    ladder: Sequence[Mapping[str, object]],
) -> dict[str, object] | None:
    for step in ladder:
        if step.get("status") != LADDER_PASS:
            return {
                "step": step.get("step"),
                "status": step.get("status"),
                "blocker_codes": list(_sequence(step.get("blocker_codes"))),
                "next_action": step.get("next_action"),
            }
    return None


def _sum_daily_int(daily: Sequence[Mapping[str, object]], key: str) -> int:
    return sum(_int(item.get(key)) for item in daily)


def _classify_verdict(totals: Mapping[str, object], blockers: Sequence[str]) -> str:
    blocker_set = set(blockers)
    source_activity = (
        _int(totals.get("trade_decision_count"))
        + _int(totals.get("execution_count"))
        + _int(totals.get("execution_order_event_count"))
        + _int(totals.get("tca_cost_row_count"))
        + _int(totals.get("runtime_ledger_bucket_count"))
    )
    if source_activity <= 0:
        return NO_SOURCE_ACTIVITY
    if blocker_set.intersection(_PRIMARY_LIFECYCLE_BLOCKERS):
        return LIFECYCLE_MISSING
    if blocker_set.intersection(_SOURCE_REF_BLOCKERS):
        return SOURCE_REFS_MISSING
    if blocker_set.intersection(_ECONOMICS_BLOCKERS):
        return ECONOMICS_MISSING
    if AUTHORITY_OPEN_POSITIONS_BLOCKER in blocker_set:
        return OPEN_POSITIONS
    if blocker_set.intersection(_LIFECYCLE_BLOCKERS):
        return LIFECYCLE_MISSING
    if blocker_set.intersection(_DISTRIBUTION_BLOCKERS):
        return AUTHORITY_DISTRIBUTION_MISSING
    if blocker_set:
        return SOURCE_REFS_MISSING
    return AUTHORITY_CANDIDATE_READY


def _next_action(classification: str) -> str:
    return {
        NO_SOURCE_ACTIVITY: "collect bounded paper-route source rows before treating replay output as authority",
        LIFECYCLE_MISSING: "materialize linked decisions, executions, order events, fills, and closed round trips",
        ECONOMICS_MISSING: "materialize execution TCA/cost rows and explicit runtime cost bases",
        SOURCE_REFS_MISSING: "backfill runtime-ledger source refs, source windows, offsets, materialization, and authority class",
        OPEN_POSITIONS: "flatten or wait for source-backed closed round trips before authority promotion",
        AUTHORITY_DISTRIBUTION_MISSING: "continue source-backed paper runtime until authority distribution thresholds are met",
        AUTHORITY_CANDIDATE_READY: "assemble authority proof packet from the same source-backed runtime rows",
    }[classification]


def _row_days(
    rows: Sequence[Mapping[str, object]], key: str, *, fallback_key: str | None = None
) -> set[str]:
    days: set[str] = set()
    for row in rows:
        timestamp = _parse_timestamp(row.get(key))
        if timestamp is None and fallback_key is not None:
            timestamp = _parse_timestamp(row.get(fallback_key))
        if timestamp is not None:
            days.add(timestamp.date().isoformat())
    return days


def _ledger_days(ledger_report: Mapping[str, object]) -> set[str]:
    return {
        text
        for item in _sequence(ledger_report.get("trading_days"))
        if (text := _text(_mapping(item).get("trading_day"))) is not None
    }


def _rows_on_day(
    rows: Sequence[Mapping[str, object]],
    day: str,
    key: str,
    *,
    fallback_key: str | None = None,
) -> list[Mapping[str, object]]:
    matches: list[Mapping[str, object]] = []
    for row in rows:
        timestamp = _parse_timestamp(row.get(key))
        if timestamp is None and fallback_key is not None:
            timestamp = _parse_timestamp(row.get(fallback_key))
        if timestamp is not None and timestamp.date().isoformat() == day:
            matches.append(row)
    return matches


def _filled_execution(row: Mapping[str, object]) -> bool:
    status = (_text(row.get("status")) or "").lower()
    return (
        status in {"filled", "partially_filled"} or _decimal(row.get("filled_qty")) > 0
    )


def _fill_event(row: Mapping[str, object]) -> bool:
    event_type = (_text(row.get("event_type")) or "").lower()
    status = (_text(row.get("status")) or "").lower()
    return (
        "fill" in event_type
        or status in {"filled", "partially_filled"}
        or _decimal(row.get("filled_qty_delta")) > 0
    )


def _event_quantity_present(row: Mapping[str, object]) -> bool:
    return any(
        _decimal(row.get(key)) > 0
        for key in ("filled_qty_delta", "filled_qty", "qty", "quantity")
    )


def _linked_order_event_fill(row: Mapping[str, object]) -> bool:
    return (
        _fill_event(row)
        and _text(row.get("execution_id")) is not None
        and _text(row.get("trade_decision_id")) is not None
        and _text(row.get("source_window_id")) is not None
        and _event_source_offset_present(row)
        and _event_quantity_present(row)
        and _decimal(row.get("avg_fill_price")) > 0
        and _decimal(row.get("filled_notional_delta")) > 0
    )


def _event_source_offset_present(row: Mapping[str, object]) -> bool:
    return (
        _text(row.get("source_topic")) is not None
        and row.get("source_partition") is not None
        and row.get("source_offset") is not None
    )


def _decision_row(row: TradeDecision, strategy_name: str | None) -> dict[str, object]:
    return {
        "id": str(row.id),
        "strategy_id": str(row.strategy_id),
        "strategy_name": strategy_name,
        "alpaca_account_label": row.alpaca_account_label,
        "symbol": row.symbol,
        "status": row.status,
        "decision_hash": row.decision_hash,
        "created_at": row.created_at,
        "executed_at": row.executed_at,
    }


def _decision_projection_row(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "id": str(row["id"]),
        "strategy_id": str(row["strategy_id"]),
        "strategy_name": row.get("strategy_name"),
        "alpaca_account_label": row.get("alpaca_account_label"),
        "symbol": row.get("symbol"),
        "status": row.get("status"),
        "decision_hash": row.get("decision_hash"),
        "created_at": row.get("created_at"),
        "executed_at": row.get("executed_at"),
    }


def _execution_row(row: Execution) -> dict[str, object]:
    return {
        "id": str(row.id),
        "trade_decision_id": str(row.trade_decision_id)
        if row.trade_decision_id is not None
        else None,
        "alpaca_account_label": row.alpaca_account_label,
        "alpaca_order_id": row.alpaca_order_id,
        "client_order_id": row.client_order_id,
        "symbol": row.symbol,
        "side": row.side,
        "status": row.status,
        "filled_qty": row.filled_qty,
        "avg_fill_price": row.avg_fill_price,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "order_feed_last_event_ts": row.order_feed_last_event_ts,
    }


def _order_event_row(row: ExecutionOrderEvent) -> dict[str, object]:
    return {
        "id": str(row.id),
        "source_topic": row.source_topic,
        "source_partition": row.source_partition,
        "source_offset": row.source_offset,
        "alpaca_account_label": row.alpaca_account_label,
        "event_ts": row.event_ts,
        "created_at": row.created_at,
        "symbol": row.symbol,
        "alpaca_order_id": row.alpaca_order_id,
        "client_order_id": row.client_order_id,
        "event_type": row.event_type,
        "status": row.status,
        "filled_qty": row.filled_qty,
        "filled_qty_delta": row.filled_qty_delta,
        "avg_fill_price": row.avg_fill_price,
        "filled_notional_delta": row.filled_notional_delta,
        "raw_event": getattr(row, "raw_event", None),
        "execution_id": str(row.execution_id) if row.execution_id is not None else None,
        "trade_decision_id": str(row.trade_decision_id)
        if row.trade_decision_id is not None
        else None,
        "source_window_id": str(row.source_window_id)
        if row.source_window_id is not None
        else None,
    }


def _tca_row(row: ExecutionTCAMetric) -> dict[str, object]:
    return {
        "id": str(row.id),
        "execution_id": str(row.execution_id),
        "trade_decision_id": str(row.trade_decision_id)
        if row.trade_decision_id is not None
        else None,
        "strategy_id": str(row.strategy_id) if row.strategy_id is not None else None,
        "alpaca_account_label": row.alpaca_account_label,
        "symbol": row.symbol,
        "side": row.side,
        "filled_qty": row.filled_qty,
        "shortfall_notional": row.shortfall_notional,
        "realized_shortfall_bps": row.realized_shortfall_bps,
        "computed_at": row.computed_at,
    }


def _source_window_row(row: OrderFeedSourceWindow) -> dict[str, object]:
    return {
        "id": str(row.id),
        "consumer_group": row.consumer_group,
        "source_topic": row.source_topic,
        "source_partition": row.source_partition,
        "alpaca_account_label": row.alpaca_account_label,
        "window_started_at": row.window_started_at,
        "window_ended_at": row.window_ended_at,
        "start_offset": row.start_offset,
        "end_offset": row.end_offset,
        "consumed_count": row.consumed_count,
        "inserted_count": row.inserted_count,
        "gap_count": row.gap_count,
        "status": row.status,
    }


def _row_list(value: object) -> list[Mapping[str, object]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    rows: list[Mapping[str, object]] = []
    for item in cast(Sequence[object], value):
        if isinstance(item, Mapping):
            rows.append(
                {
                    str(key): _json_value(raw)
                    for key, raw in cast(Mapping[object, object], item).items()
                }
            )
    return rows


def _json_value(value: object) -> object:
    if isinstance(value, str):
        parsed = _parse_timestamp(value)
        return parsed if parsed is not None else value
    if isinstance(value, Mapping):
        return {
            str(key): _json_value(raw)
            for key, raw in cast(Mapping[object, object], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_value(item) for item in cast(Sequence[object], value)]
    return value


def _parse_cli_timestamp(value: str | None) -> datetime | None:
    if value is None or not value.strip():
        return None
    parsed = _parse_timestamp(value)
    if parsed is None:
        raise ValueError(f"invalid timestamp: {value}")
    return parsed


__all__ = [name for name in globals() if not name.startswith("__")]
