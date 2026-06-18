"""Shared imports, constants, and scalar helpers for submission council."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from typing import Any, NamedTuple, Protocol, cast
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

CAPITAL_STAGE_ORDER = (
    "shadow",
    "0.10x canary",
    "0.25x canary",
    "0.50x live",
    "1.00x live",
)
LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES = frozenset(
    {
        "TRADING_ENABLED",
        "TRADING_KILL_SWITCH_ENABLED",
        "TRADING_MODE",
    }
)
TYPED_QUANT_HEALTH_PATH = "/api/torghut/trading/control-plane/quant/health"
QUANT_HEALTH_CACHE_LOCK = Lock()
QUANT_HEALTH_CACHE: dict[str, object] = {}
STALE_SEGMENT_STATES = frozenset({"stale", "down", "degraded", "error", "blocked"})
TA_CORE_REASON_CODES = frozenset(
    {
        "feature_rows_missing",
        "no_signal_streak_exceeded",
        "required_feature_set_unavailable",
        "signal_continuity_alert_active",
        "signal_lag_exceeded",
    }
)
AUTORESEARCH_PORTFOLIO_READY_STATUSES = (
    "paper_candidate",
    "promotion_ready",
    "ready_for_promotion",
    "ready_for_promotion_review",
    "target_met",
    "accepted",
    "promoted",
)
RUNTIME_LEDGER_REPAIR_SCAN_LIMIT = 256
RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT = 8
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS = 2500
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS = 500
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS = 10000
RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV = (
    "TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS"
)
RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT = 16
PROMOTION_TABLE_COUNT_SCAN_LIMIT = 1000
PROMOTION_PORTFOLIO_READY_SCAN_LIMIT = 256
CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT = 8
CERTIFICATE_EVIDENCE_WINDOW_LIMIT = CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT = 16
PROMOTION_SCALAR_COUNT_LIMIT = PROMOTION_TABLE_COUNT_SCAN_LIMIT
PROMOTION_PORTFOLIO_SAMPLE_LIMIT = PROMOTION_PORTFOLIO_READY_SCAN_LIMIT


class RuntimeLedgerReadSession(Protocol):
    """Minimal read-session surface used by runtime-ledger status probes."""

    def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any: ...


class PortfolioPromotionRow(NamedTuple):
    status: str
    portfolio_candidate_id: str
    source_candidate_ids_json: Any
    target_net_pnl_per_day: Decimal
    objective_scorecard_json: Any


RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES = frozenset(
    {
        "signals_present",
        "expected_market_closed_staleness",
    }
)


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


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def bounded_paper_route_probe_notional() -> Decimal:
    return max(
        _safe_decimal(settings.trading_simple_paper_route_probe_max_notional)
        or Decimal("0"),
        Decimal("0"),
    )


def _bounded_paper_route_probe_collection_payload(
    *,
    authorized: bool,
) -> dict[str, object]:
    notional = bounded_paper_route_probe_notional() if authorized else Decimal("0")
    bounded_authorized = notional > 0
    if not bounded_authorized:
        return {
            "bounded_evidence_collection_authorized": False,
            "bounded_evidence_collection_max_notional": "0",
            "max_notional": "0",
        }
    notional_text = decimal_text(notional)
    return {
        "bounded_evidence_collection_authorized": True,
        "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
        "bounded_evidence_collection_max_notional": notional_text,
        "paper_route_probe_next_session_max_notional": notional_text,
        "paper_route_probe_effective_max_notional": notional_text,
        "target_notional": notional_text,
        "max_notional": notional_text,
    }


def safe_bool(value: object) -> bool | None:
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


def safe_attr_text(value: object, name: str) -> str | None:
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


def stage_rank(stage: object) -> int:
    text = _safe_text(stage)
    if text is None:
        return -1
    try:
        return CAPITAL_STAGE_ORDER.index(text)
    except ValueError:
        return -1


def runtime_ledger_status_query_timeout_ms() -> int:
    raw_timeout = os.getenv(RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV)
    if raw_timeout is None:
        return RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
    try:
        timeout_ms = int(raw_timeout)
    except ValueError:
        return RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
    return min(
        RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS,
        max(RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS, timeout_ms),
    )


def maybe_set_runtime_ledger_status_statement_timeout(session: object) -> None:
    get_bind = getattr(session, "get_bind", None)
    if callable(get_bind):
        try:
            bind = get_bind()
            dialect = getattr(getattr(bind, "dialect", None), "name", "")
            if dialect != "postgresql":
                return
        except Exception:
            pass
    execute = getattr(session, "execute", None)
    if not callable(execute):
        return
    execute(
        sql_text(
            f"SET LOCAL statement_timeout = {runtime_ledger_status_query_timeout_ms()}"
        )
    )


def rollback_runtime_ledger_status_session(session: object) -> None:
    rollback = getattr(session, "rollback", None)
    if not callable(rollback):
        return
    try:
        rollback()
    except SQLAlchemyError:
        logger.warning("Failed to roll back runtime-ledger status session")


def sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def unavailable_certificate_evidence_rows(
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


def certificate_evidence_reason_codes(row: Mapping[str, object]) -> list[str]:
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


def coerce_aware_datetime(value: object) -> datetime | None:
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
    "RuntimeLedgerReadSession",
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
    "AUTORESEARCH_PORTFOLIO_READY_STATUSES",
    "CAPITAL_STAGE_ORDER",
    "CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT",
    "CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT",
    "CERTIFICATE_EVIDENCE_WINDOW_LIMIT",
    "LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES",
    "PROMOTION_PORTFOLIO_READY_SCAN_LIMIT",
    "PROMOTION_PORTFOLIO_SAMPLE_LIMIT",
    "PROMOTION_SCALAR_COUNT_LIMIT",
    "PROMOTION_TABLE_COUNT_SCAN_LIMIT",
    "PortfolioPromotionRow",
    "QUANT_HEALTH_CACHE",
    "QUANT_HEALTH_CACHE_LOCK",
    "RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT",
    "RUNTIME_LEDGER_REPAIR_SCAN_LIMIT",
    "RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS",
    "RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV",
    "RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS",
    "RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS",
    "RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT",
    "RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES",
    "STALE_SEGMENT_STATES",
    "TA_CORE_REASON_CODES",
    "TYPED_QUANT_HEALTH_PATH",
    "_bounded_paper_route_probe_collection_payload",
    "bounded_paper_route_probe_notional",
    "certificate_evidence_reason_codes",
    "coerce_aware_datetime",
    "decimal_text",
    "maybe_set_runtime_ledger_status_statement_timeout",
    "_normalize_reason_codes",
    "rollback_runtime_ledger_status_session",
    "runtime_ledger_status_query_timeout_ms",
    "safe_attr_text",
    "safe_bool",
    "_safe_decimal",
    "_safe_int",
    "_safe_text",
    "sqlalchemy_error_indicates_statement_timeout",
    "stage_rank",
    "unavailable_certificate_evidence_rows",
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
    "timedelta",
    "timezone",
    "urlencode",
    "urlopen",
    "urlsplit",
    "urlunsplit",
]
