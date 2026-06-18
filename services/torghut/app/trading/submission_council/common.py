"""Shared imports, constants, and scalar helpers for submission council."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from typing import Any, NamedTuple, TypeVar, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from sqlalchemy import func, select, text as sql_text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    ResearchCandidate,
    ResearchPromotion,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
    VNextDatasetSnapshot,
    VNextPromotionDecision,
)
from ..hypotheses import (
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)
from ..market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)
from ..discovery.profit_target_oracle import evaluate_profit_target_oracle
from ..profit_windows import build_profit_window_contract
from ..profit_leases import build_profit_lease_projection
from ..runtime_ledger import POST_COST_PNL_BASIS
from ..runtime_ledger_source_authority import (
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_promotion_source_authority_present,
)
from ..runtime_strategy_resolution import (
    derived_strategy_name_from_strategy_id,
    explicit_runtime_strategy_name_or_family_harness,
    strategy_names_from_strategy_id,
)
from ..session_context import (
    regular_session_close_utc_for,
    regular_session_open_utc_for,
)
from ..tca import build_tca_gate_inputs


logger = logging.getLogger("app.trading.submission_council")

_CompatSymbol = TypeVar("_CompatSymbol")

_CAPITAL_STAGE_ORDER = (
    "shadow",
    "0.10x canary",
    "0.25x canary",
    "0.50x live",
    "1.00x live",
)
_LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES = frozenset(
    {
        "TRADING_ENABLED",
        "TRADING_KILL_SWITCH_ENABLED",
        "TRADING_MODE",
    }
)
_TYPED_QUANT_HEALTH_PATH = "/api/torghut/trading/control-plane/quant/health"
_QUANT_HEALTH_CACHE_LOCK = Lock()
_QUANT_HEALTH_CACHE: dict[str, object] = {}
_STALE_SEGMENT_STATES = frozenset({"stale", "down", "degraded", "error", "blocked"})
_TA_CORE_REASON_CODES = frozenset(
    {
        "feature_rows_missing",
        "no_signal_streak_exceeded",
        "required_feature_set_unavailable",
        "signal_continuity_alert_active",
        "signal_lag_exceeded",
    }
)
_AUTORESEARCH_PORTFOLIO_READY_STATUSES = (
    "paper_candidate",
    "promotion_ready",
    "ready_for_promotion",
    "ready_for_promotion_review",
    "target_met",
    "accepted",
    "promoted",
)
_RUNTIME_LEDGER_REPAIR_SCAN_LIMIT = 256
_RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT = 8
_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS = 2500
_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS = 500
_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS = 10000
_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV = (
    "TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS"
)
_RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT = 16
_PROMOTION_TABLE_COUNT_SCAN_LIMIT = 1000
_PROMOTION_PORTFOLIO_READY_SCAN_LIMIT = 256
_CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT = 8
_CERTIFICATE_EVIDENCE_WINDOW_LIMIT = _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
_CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT = 16
_PROMOTION_SCALAR_COUNT_LIMIT = _PROMOTION_TABLE_COUNT_SCAN_LIMIT
_PROMOTION_PORTFOLIO_SAMPLE_LIMIT = _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT


class _PortfolioPromotionRow(NamedTuple):
    status: str
    portfolio_candidate_id: str
    source_candidate_ids_json: Any
    target_net_pnl_per_day: Decimal
    objective_scorecard_json: Any


_RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES = frozenset(
    {
        "signals_present",
        "expected_market_closed_staleness",
    }
)


def _compat_symbol(name: str, fallback: _CompatSymbol) -> _CompatSymbol:
    facade = sys.modules.get("app.trading.submission_council")
    if facade is None:
        return fallback
    return cast(_CompatSymbol, getattr(facade, name, fallback))


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _safe_decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def _bounded_paper_route_probe_notional() -> Decimal:
    return max(
        _safe_decimal(settings.trading_simple_paper_route_probe_max_notional)
        or Decimal("0"),
        Decimal("0"),
    )


def _bounded_paper_route_probe_collection_payload(
    *,
    authorized: bool,
) -> dict[str, object]:
    notional = _bounded_paper_route_probe_notional() if authorized else Decimal("0")
    bounded_authorized = notional > 0
    if not bounded_authorized:
        return {
            "bounded_evidence_collection_authorized": False,
            "bounded_evidence_collection_max_notional": "0",
            "max_notional": "0",
        }
    notional_text = _decimal_text(notional)
    return {
        "bounded_evidence_collection_authorized": True,
        "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
        "bounded_evidence_collection_max_notional": notional_text,
        "paper_route_probe_next_session_max_notional": notional_text,
        "paper_route_probe_effective_max_notional": notional_text,
        "target_notional": notional_text,
        "max_notional": notional_text,
    }


def _safe_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True
        if normalized in {"false", "0", "no", "n", "off"}:
            return False
    return None


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_attr_text(value: object, name: str) -> str | None:
    return _safe_text(cast(object, getattr(value, name, None)))


def _normalize_reason_codes(values: Sequence[object]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value).strip()
        if not item or item in seen:
            continue
        normalized.append(item)
        seen.add(item)
    return normalized


def _stage_rank(stage: object) -> int:
    text = _safe_text(stage)
    if text is None:
        return -1
    try:
        return _CAPITAL_STAGE_ORDER.index(text)
    except ValueError:
        return -1


def _runtime_ledger_status_query_timeout_ms() -> int:
    raw_timeout = os.getenv(_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV)
    if raw_timeout is None:
        return _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
    try:
        timeout_ms = int(raw_timeout)
    except ValueError:
        return _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
    return min(
        _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS,
        max(_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS, timeout_ms),
    )


def _maybe_set_runtime_ledger_status_statement_timeout(session: Session) -> None:
    get_bind = getattr(session, "get_bind", None)
    if callable(get_bind):
        try:
            bind = get_bind()
            dialect = getattr(getattr(bind, "dialect", None), "name", "")
            if dialect != "postgresql":
                return
        except Exception:
            pass
    session.execute(
        sql_text(
            f"SET LOCAL statement_timeout = {_runtime_ledger_status_query_timeout_ms()}"
        )
    )


def _rollback_runtime_ledger_status_session(session: Session) -> None:
    rollback = getattr(session, "rollback", None)
    if not callable(rollback):
        return
    try:
        rollback()
    except SQLAlchemyError:
        logger.warning("Failed to roll back runtime-ledger status session")


def _sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def _unavailable_certificate_evidence_rows(
    *,
    hypothesis_ids: Sequence[str],
    reason_code: str,
) -> list[dict[str, object]]:
    return [
        {
            "hypothesis_id": hypothesis_id,
            "metric_window": None,
            "promotion_decision": None,
            "runtime_ledger_bucket": None,
            "reason_codes": [reason_code],
            "read_model_unavailable": True,
        }
        for hypothesis_id in hypothesis_ids
    ]


def _certificate_evidence_reason_codes(row: Mapping[str, object]) -> list[str]:
    reasons: list[str] = []
    reasons.extend(
        str(reason).strip()
        for reason in cast(Sequence[object], row.get("reason_codes") or [])
        if str(reason).strip()
    )
    reasons.extend(
        str(reason).strip()
        for reason in cast(Sequence[object], row.get("query_reason_codes") or [])
        if str(reason).strip()
    )
    return _normalize_reason_codes(reasons)


def _coerce_aware_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = f"{normalized[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


bounded_paper_route_probe_collection_payload = (
    _bounded_paper_route_probe_collection_payload
)
normalize_reason_codes = _normalize_reason_codes
safe_decimal = _safe_decimal
safe_int = _safe_int
safe_text = _safe_text


__all__ = [
    "Any",
    "AutoresearchCandidateSpec",
    "AutoresearchEpoch",
    "AutoresearchPortfolioCandidate",
    "AutoresearchProposalScore",
    "Decimal",
    "InvalidOperation",
    "Lock",
    "Mapping",
    "NamedTuple",
    "POST_COST_PNL_BASIS",
    "RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER",
    "Request",
    "ResearchCandidate",
    "ResearchPromotion",
    "SQLAlchemyError",
    "Sequence",
    "Session",
    "StrategyHypothesis",
    "StrategyHypothesisMetricWindow",
    "StrategyPromotionDecision",
    "StrategyRuntimeLedgerBucket",
    "TradeDecision",
    "VNextDatasetSnapshot",
    "VNextPromotionDecision",
    "_AUTORESEARCH_PORTFOLIO_READY_STATUSES",
    "_CAPITAL_STAGE_ORDER",
    "_CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT",
    "_CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT",
    "_CERTIFICATE_EVIDENCE_WINDOW_LIMIT",
    "_LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES",
    "_PROMOTION_PORTFOLIO_READY_SCAN_LIMIT",
    "_PROMOTION_PORTFOLIO_SAMPLE_LIMIT",
    "_PROMOTION_SCALAR_COUNT_LIMIT",
    "_PROMOTION_TABLE_COUNT_SCAN_LIMIT",
    "_PortfolioPromotionRow",
    "_QUANT_HEALTH_CACHE",
    "_QUANT_HEALTH_CACHE_LOCK",
    "_RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT",
    "_RUNTIME_LEDGER_REPAIR_SCAN_LIMIT",
    "_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS",
    "_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV",
    "_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS",
    "_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS",
    "_RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT",
    "_RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES",
    "_STALE_SEGMENT_STATES",
    "_TA_CORE_REASON_CODES",
    "_TYPED_QUANT_HEALTH_PATH",
    "_bounded_paper_route_probe_collection_payload",
    "_bounded_paper_route_probe_notional",
    "_certificate_evidence_reason_codes",
    "_coerce_aware_datetime",
    "_compat_symbol",
    "_decimal_text",
    "_maybe_set_runtime_ledger_status_statement_timeout",
    "_normalize_reason_codes",
    "_rollback_runtime_ledger_status_session",
    "_runtime_ledger_status_query_timeout_ms",
    "_safe_attr_text",
    "_safe_bool",
    "_safe_decimal",
    "_safe_int",
    "_safe_text",
    "_sqlalchemy_error_indicates_statement_timeout",
    "_stage_rank",
    "_unavailable_certificate_evidence_rows",
    "active_market_context_mapping",
    "active_market_context_reasons",
    "bounded_paper_route_probe_collection_payload",
    "build_profit_lease_projection",
    "build_profit_window_contract",
    "build_tca_gate_inputs",
    "cast",
    "compile_hypothesis_runtime_statuses",
    "datetime",
    "derived_strategy_name_from_strategy_id",
    "evaluate_profit_target_oracle",
    "explicit_runtime_strategy_name_or_family_harness",
    "func",
    "hashlib",
    "json",
    "load_hypothesis_registry",
    "logger",
    "logging",
    "normalize_reason_codes",
    "os",
    "parse_qsl",
    "regular_session_close_utc_for",
    "regular_session_open_utc_for",
    "resolve_hypothesis_dependency_quorum",
    "runtime_ledger_promotion_source_authority_blockers",
    "runtime_ledger_promotion_source_authority_present",
    "safe_decimal",
    "safe_int",
    "safe_text",
    "select",
    "settings",
    "sql_text",
    "strategy_names_from_strategy_id",
    "summarize_hypothesis_runtime_statuses",
    "sys",
    "timedelta",
    "timezone",
    "urlencode",
    "urlopen",
    "urlsplit",
    "urlunsplit",
]

# Public aliases used by split modules.
AUTORESEARCH_PORTFOLIO_READY_STATUSES = _AUTORESEARCH_PORTFOLIO_READY_STATUSES
bounded_paper_route_probe_notional = _bounded_paper_route_probe_notional
CAPITAL_STAGE_ORDER = _CAPITAL_STAGE_ORDER
CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT = _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
certificate_evidence_reason_codes = _certificate_evidence_reason_codes
CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT = _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT
CERTIFICATE_EVIDENCE_WINDOW_LIMIT = _CERTIFICATE_EVIDENCE_WINDOW_LIMIT
coerce_aware_datetime = _coerce_aware_datetime
compat_symbol = _compat_symbol
decimal_text = _decimal_text
LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES = _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES
maybe_set_runtime_ledger_status_statement_timeout = (
    _maybe_set_runtime_ledger_status_statement_timeout
)
PortfolioPromotionRow = _PortfolioPromotionRow
PROMOTION_PORTFOLIO_READY_SCAN_LIMIT = _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT
PROMOTION_PORTFOLIO_SAMPLE_LIMIT = _PROMOTION_PORTFOLIO_SAMPLE_LIMIT
PROMOTION_SCALAR_COUNT_LIMIT = _PROMOTION_SCALAR_COUNT_LIMIT
PROMOTION_TABLE_COUNT_SCAN_LIMIT = _PROMOTION_TABLE_COUNT_SCAN_LIMIT
QUANT_HEALTH_CACHE = _QUANT_HEALTH_CACHE
QUANT_HEALTH_CACHE_LOCK = _QUANT_HEALTH_CACHE_LOCK
rollback_runtime_ledger_status_session = _rollback_runtime_ledger_status_session
RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT = _RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT
RUNTIME_LEDGER_REPAIR_SCAN_LIMIT = _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS = (
    _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
)
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV = _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS = _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS = _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS
runtime_ledger_status_query_timeout_ms = _runtime_ledger_status_query_timeout_ms
RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT = (
    _RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT
)
RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES = (
    _RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES
)
safe_attr_text = _safe_attr_text
safe_bool = _safe_bool
sqlalchemy_error_indicates_statement_timeout = (
    _sqlalchemy_error_indicates_statement_timeout
)
stage_rank = _stage_rank
STALE_SEGMENT_STATES = _STALE_SEGMENT_STATES
TA_CORE_REASON_CODES = _TA_CORE_REASON_CODES
TYPED_QUANT_HEALTH_PATH = _TYPED_QUANT_HEALTH_PATH
unavailable_certificate_evidence_rows = _unavailable_certificate_evidence_rows
