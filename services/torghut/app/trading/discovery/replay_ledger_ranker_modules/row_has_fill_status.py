# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION,
    EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION,
    EXECUTION_QUALITY_SCHEMA_VERSION,
    ReplayLedgerCandidateRanking,
    ReplayLedgerRankingFailure,
    ReplayLedgerRankingPolicy,
    _CLOSING_AUCTION_CLEARING_PRICE_FIELDS,
    _CLOSING_AUCTION_FIELDS,
    _CLOSING_AUCTION_PROJECTION_FIELDS,
    _CLOSING_WINDOW_FIELDS,
    _EXECUTION_QUALITY_SOURCE_PAPERS,
    _EXECUTION_SHORTFALL_FIELDS,
    _FILL_STATUS_FIELDS,
    _LIMIT_FILL_PROBABILITY_FIELDS,
    _LIVE_PROMOTION_AUTHORITIES,
    _OPPORTUNITY_COST_FIELDS,
    _ORDER_TYPE_FIELDS,
    _PRICE_IMPROVEMENT_FIELDS,
    _QUEUE_POSITION_FIELDS,
    _TERMINAL_INVENTORY_PATH_FIELDS,
    _full_window_bucket,
    _ledger_window,
    _runtime_rows_with_defaults,
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
    rank_replay_ledger_files,
    rank_replay_ledger_payload,
)
from .promotion_blockers import (
    _average_decimal,
    _candidate_id,
    _candidate_identity_blockers,
    _capacity_lineage_summary,
    _cost_lineage_blockers,
    _count_texts,
    _daily_bucket_ranges,
    _decimal,
    _dedupe_source_papers,
    _evidence_present,
    _execution_quality_summary,
    _first_decimal,
    _first_evidence,
    _first_text,
    _lob_reality_gap_stress_summary,
    _lob_signal_rows,
    _mapping,
    _microstructure_stress_summary,
    _normalized_order_type,
    _order_type_for_row,
    _parse_window_datetime,
    _payload_object,
    _promotion_blockers,
    _row_event_ts,
    _row_ingest_ts,
    _stress_penalty_bps,
    _string_list,
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


__all__ = [name for name in globals() if not name.startswith("__")]
