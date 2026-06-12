# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ...config import settings
from ...models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    VNextDatasetSnapshot,
)
from ..hypotheses import (
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    load_hypothesis_registry,
)
from ..runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
from ..runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from ..runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_ledger_proof_policy import runtime_ledger_proof_policy_from_env
from ..runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_DISABLED,
    TIGERBEETLE_BLOCKER_JOURNAL_ENTRY_UNAVAILABLE,
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TigerBeetleLedgerJournal,
    tigerbeetle_runtime_ledger_journal_payload,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_63 import *
from .part_02_delay_adjusted_depth_stress_blocking_reaso import *
from .part_03_build_observed_runtime_buckets import *
from .part_04_runtime_ledger_bucket_replacement_scopes import *


def _runtime_ledger_daily_summary_from_observed_buckets(
    buckets: Sequence[ObservedRuntimeBucket],
) -> dict[str, Any]:
    ordered_buckets = sorted(buckets, key=lambda item: item.window_started_at)
    trading_days = sorted(
        {
            _runtime_ledger_trading_day_key(bucket.window_started_at)
            for bucket in ordered_buckets
        }
    )
    net_pnl_by_day = {day: Decimal("0") for day in trading_days}
    filled_notional_by_day = {day: Decimal("0") for day in trading_days}
    closed_trade_count_by_day = {day: 0 for day in trading_days}
    cumulative_by_day = {day: Decimal("0") for day in trading_days}
    peak_by_day = {day: Decimal("0") for day in trading_days}
    max_intraday_drawdown = Decimal("0")
    symbol_net_pnl: dict[str, Decimal] = {}
    equity_denominators: list[tuple[Decimal, str]] = []

    for bucket in ordered_buckets:
        day = _runtime_ledger_trading_day_key(bucket.window_started_at)
        bucket_net_pnl = Decimal("0")
        for ledger_payload in _runtime_ledger_bucket_payloads(bucket.payload_json):
            if _runtime_ledger_bucket_blockers(ledger_payload):
                continue
            net_pnl = _optional_decimal(
                ledger_payload.get("net_strategy_pnl_after_costs")
            )
            filled_notional = _optional_decimal(ledger_payload.get("filled_notional"))
            if net_pnl is not None:
                bucket_net_pnl += net_pnl
                net_pnl_by_day[day] += net_pnl
            if filled_notional is not None and filled_notional > 0:
                filled_notional_by_day[day] += filled_notional
            closed_trade_count_by_day[day] += _observation_int(
                ledger_payload.get("closed_trade_count")
            )
            for symbol, pnl in _runtime_ledger_symbol_pnl_items(
                ledger_payload,
                net_pnl=net_pnl,
            ):
                symbol_net_pnl[symbol] = symbol_net_pnl.get(symbol, Decimal("0")) + pnl
            equity_denominator = _runtime_ledger_equity_denominator(ledger_payload)
            if equity_denominator is not None:
                equity_denominators.append(equity_denominator)
        cumulative_by_day[day] += bucket_net_pnl
        if cumulative_by_day[day] > peak_by_day[day]:
            peak_by_day[day] = cumulative_by_day[day]
        drawdown = peak_by_day[day] - cumulative_by_day[day]
        if drawdown > max_intraday_drawdown:
            max_intraday_drawdown = drawdown

    day_count = len(trading_days)
    daily_net_values = [net_pnl_by_day[day] for day in trading_days]
    total_daily_net_pnl = sum(daily_net_values, Decimal("0"))
    total_filled_notional = sum(
        (filled_notional_by_day[day] for day in trading_days),
        Decimal("0"),
    )
    mean_daily_net_pnl = (
        total_daily_net_pnl / Decimal(day_count) if day_count > 0 else Decimal("0")
    )
    avg_daily_filled_notional = (
        total_filled_notional / Decimal(day_count) if day_count > 0 else Decimal("0")
    )
    positive_daily_values = [value for value in daily_net_values if value > 0]
    total_positive_daily_net_pnl = sum(positive_daily_values, Decimal("0"))
    summary: dict[str, Any] = {
        "runtime_ledger_observed_trading_day_count": day_count,
        "runtime_ledger_net_pnl_by_trading_day": {
            day: str(net_pnl_by_day[day]) for day in trading_days
        },
        "runtime_ledger_mean_daily_net_pnl_after_costs": str(mean_daily_net_pnl),
        "runtime_ledger_median_daily_net_pnl_after_costs": str(
            _median_decimal(daily_net_values)
        ),
        "runtime_ledger_p10_daily_net_pnl_after_costs": str(
            _p10_decimal(daily_net_values)
        ),
        "runtime_ledger_worst_day_net_pnl_after_costs": str(
            min(daily_net_values) if daily_net_values else Decimal("0")
        ),
        "runtime_ledger_max_intraday_drawdown": str(max_intraday_drawdown),
        "runtime_ledger_avg_daily_filled_notional": str(avg_daily_filled_notional),
        "runtime_ledger_filled_notional_by_trading_day": {
            day: str(filled_notional_by_day[day]) for day in trading_days
        },
        "runtime_ledger_closed_trade_count_by_day": {
            day: closed_trade_count_by_day[day] for day in trading_days
        },
    }
    if total_positive_daily_net_pnl > 0:
        summary["runtime_ledger_best_day_share"] = str(
            max(positive_daily_values) / total_positive_daily_net_pnl
        )

    if equity_denominators:
        equity_denominator, equity_source = min(
            equity_denominators, key=lambda item: item[0]
        )
        summary["runtime_ledger_drawdown_pct_equity"] = str(
            max_intraday_drawdown / equity_denominator
        )
        summary["runtime_ledger_max_drawdown_pct_equity"] = summary[
            "runtime_ledger_drawdown_pct_equity"
        ]
        summary["runtime_ledger_drawdown_pct_equity_source"] = equity_source

    symbol_abs_pnl = {
        symbol: abs(value) for symbol, value in symbol_net_pnl.items() if value != 0
    }
    total_symbol_abs_pnl = sum(symbol_abs_pnl.values(), Decimal("0"))
    if total_symbol_abs_pnl > 0:
        summary["runtime_ledger_net_pnl_by_symbol"] = {
            symbol: str(symbol_net_pnl[symbol]) for symbol in sorted(symbol_net_pnl)
        }
        summary["runtime_ledger_symbol_concentration_share"] = str(
            max(symbol_abs_pnl.values()) / total_symbol_abs_pnl
        )
        summary["runtime_ledger_symbol_concentration_basis"] = "absolute_net_pnl"

    return summary


__all__ = [name for name in globals() if not name.startswith("__")]
