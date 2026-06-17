# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Rank exact replay ledger artifacts with runtime-ledger PnL semantics."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast

from app.trading.discovery.adaptive_market_limit_allocation_stress import (
    extract_adaptive_market_limit_allocation_stress,
)
from app.trading.discovery.cluster_lob_features import extract_cluster_lob_features
from app.trading.discovery.lob_reality_gap_stress import (
    extract_lob_reality_gap_stress,
)
from app.trading.discovery.order_book_observability_stress import (
    extract_order_book_observability_stress,
)
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.models import SignalEnvelope
from app.trading.runtime_ledger import RuntimeLedgerBucket, build_runtime_ledger_buckets

# ruff: noqa: F401,F811,F821

from .shared_context import (
    EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION,
    EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION,
    EXECUTION_QUALITY_SCHEMA_VERSION,
    ReplayLedgerCandidateRanking,
    ReplayLedgerRankingFailure,
    ReplayLedgerRankingPolicy,
    CLOSING_AUCTION_CLEARING_PRICE_FIELDS as _CLOSING_AUCTION_CLEARING_PRICE_FIELDS,
    CLOSING_AUCTION_FIELDS as _CLOSING_AUCTION_FIELDS,
    CLOSING_AUCTION_PROJECTION_FIELDS as _CLOSING_AUCTION_PROJECTION_FIELDS,
    CLOSING_WINDOW_FIELDS as _CLOSING_WINDOW_FIELDS,
    EXECUTION_QUALITY_SOURCE_PAPERS as _EXECUTION_QUALITY_SOURCE_PAPERS,
    EXECUTION_SHORTFALL_FIELDS as _EXECUTION_SHORTFALL_FIELDS,
    FILL_STATUS_FIELDS as _FILL_STATUS_FIELDS,
    LIMIT_FILL_PROBABILITY_FIELDS as _LIMIT_FILL_PROBABILITY_FIELDS,
    LIVE_PROMOTION_AUTHORITIES as _LIVE_PROMOTION_AUTHORITIES,
    OPPORTUNITY_COST_FIELDS as _OPPORTUNITY_COST_FIELDS,
    ORDER_TYPE_FIELDS as _ORDER_TYPE_FIELDS,
    PRICE_IMPROVEMENT_FIELDS as _PRICE_IMPROVEMENT_FIELDS,
    QUEUE_POSITION_FIELDS as _QUEUE_POSITION_FIELDS,
    TERMINAL_INVENTORY_PATH_FIELDS as _TERMINAL_INVENTORY_PATH_FIELDS,
    full_window_bucket as _full_window_bucket,
    ledger_window as _ledger_window,
    runtime_rows_with_defaults as _runtime_rows_with_defaults,
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
    rank_replay_ledger_files,
    rank_replay_ledger_payload,
)
from .promotion_blockers import (
    average_decimal as _average_decimal,
    candidate_id as _candidate_id,
    candidate_identity_blockers as _candidate_identity_blockers,
    capacity_lineage_summary as _capacity_lineage_summary,
    cost_lineage_blockers as _cost_lineage_blockers,
    count_texts as _count_texts,
    daily_bucket_ranges as _daily_bucket_ranges,
    decimal as _decimal,
    dedupe_source_papers as _dedupe_source_papers,
    evidence_present as _evidence_present,
    execution_quality_summary as _execution_quality_summary,
    first_decimal as _first_decimal,
    first_evidence as _first_evidence,
    first_text as _first_text,
    lob_reality_gap_stress_summary as _lob_reality_gap_stress_summary,
    lob_signal_rows as _lob_signal_rows,
    mapping as _mapping,
    microstructure_stress_summary as _microstructure_stress_summary,
    normalized_order_type as _normalized_order_type,
    order_type_for_row as _order_type_for_row,
    parse_window_datetime as _parse_window_datetime,
    payload_object as _payload_object,
    promotion_blockers as _promotion_blockers,
    row_event_ts as _row_event_ts,
    row_ingest_ts as _row_ingest_ts,
    stress_penalty_bps as _stress_penalty_bps,
    string_list as _string_list,
)


def _row_has_fill_status(row: Mapping[str, object]) -> bool:
    status = _first_text(row, _FILL_STATUS_FIELDS).lower().replace("-", "_")
    if not status:
        return False
    return any(token in status for token in ("fill", "filled", "partial"))


def _text(value: object) -> str:
    return str(value or "").strip()


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _best_day_share(daily_net: Mapping[str, Decimal], total_net: Decimal) -> Decimal:
    if total_net <= 0:
        return Decimal("1")
    best = max(
        (value for value in daily_net.values() if value > 0), default=Decimal("0")
    )
    return best / total_net


def _max_drawdown(daily_net: Mapping[str, Decimal]) -> Decimal:
    cumulative = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    for day in sorted(daily_net):
        cumulative += daily_net[day]
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, peak - cumulative)
    return max_drawdown


def _profit_factor(daily_net: Mapping[str, Decimal]) -> Decimal | None:
    positive = sum((value for value in daily_net.values() if value > 0), Decimal("0"))
    negative = sum((value for value in daily_net.values() if value < 0), Decimal("0"))
    if negative == 0:
        return None
    return positive / abs(negative)


def _max_single_fill_notional(rows: Sequence[Mapping[str, object]]) -> Decimal:
    values = [
        notional
        for row in rows
        if _event_type(row) == "fill"
        if (notional := _fill_notional(row)) is not None
    ]
    return max(values, default=Decimal("0"))


def _fill_notional(row: Mapping[str, object]) -> Decimal | None:
    explicit = _positive_decimal(
        row.get("filled_notional") or row.get("notional") or row.get("fill_notional")
    )
    if explicit is not None:
        return explicit
    qty = _positive_decimal(
        row.get("filled_qty") or row.get("qty") or row.get("quantity")
    )
    price = _positive_decimal(
        row.get("avg_fill_price") or row.get("filled_avg_price") or row.get("price")
    )
    if qty is None or price is None:
        return None
    return qty * price


def _symbols(rows: Sequence[Mapping[str, object]]) -> tuple[str, ...]:
    return tuple(
        sorted(
            {
                str(symbol)
                for row in rows
                if (symbol := row.get("symbol")) not in (None, "")
            }
        )
    )


def _event_type(row: Mapping[str, object]) -> str:
    raw = str(
        row.get("ledger_event_type")
        or row.get("runtime_ledger_event_type")
        or row.get("event_type")
        or ""
    ).strip()
    if raw:
        normalized = raw.lower().replace("-", "_").replace(" ", "_")
        if normalized in {"filled", "partial_fill", "partially_filled"}:
            return "fill"
        if normalized in {"trade_decision", "signal_decision"}:
            return "decision"
        if normalized in {"submitted", "accepted", "new", "new_order"}:
            return "order_submitted"
        return normalized
    if row.get("filled_qty") is not None or row.get("avg_fill_price") is not None:
        return "fill"
    return ""


def _positive_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if parsed <= 0:
        return None
    return parsed


def _safe_divide(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal("0")
    return numerator / denominator


def _dedupe(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _ranking_sort_key(candidate: ReplayLedgerCandidateRanking) -> tuple[object, ...]:
    return (
        -candidate.replay_quality_adjusted_window_net_pnl_per_day,
        -candidate.execution_quality_adjusted_window_net_pnl_per_day,
        -candidate.window_net_pnl_per_day,
        -candidate.total_net_pnl_after_costs,
        candidate.lob_reality_gap_penalty_bps,
        candidate.microstructure_stress_penalty_bps,
        candidate.execution_quality_penalty_bps,
        candidate.best_day_share,
        candidate.max_drawdown,
        candidate.candidate_id,
    )


# Public aliases used by split-module consumers.
best_day_share = _best_day_share
dedupe = _dedupe
event_type = _event_type
fill_notional = _fill_notional
max_drawdown = _max_drawdown
max_single_fill_notional = _max_single_fill_notional
parse_window_datetime = _parse_window_datetime
positive_decimal = _positive_decimal
profit_factor = _profit_factor
ranking_sort_key = _ranking_sort_key
safe_divide = _safe_divide
symbols = _symbols
text = _text

__all__ = [name for name in globals() if not name.startswith("__")]
