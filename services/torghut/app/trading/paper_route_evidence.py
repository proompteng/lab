"""Paper-route evidence audit helpers.

This module keeps paper-probation observability separate from promotion
authority. It explains why a target is still evidence collection only instead
of mutating any live submission gate.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    Execution,
    ExecutionTCAMetric,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from .runtime_ledger import POST_COST_PNL_BASIS


PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION = "torghut.paper-route-evidence.v1"
NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION = (
    "torghut.next-paper-route-runtime-window-targets.v1"
)
DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS = 72
DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT = 20
PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL = "TORGHUT_SIM"
US_EQUITIES_TIMEZONE = "America/New_York"
US_EQUITIES_OPEN = time(hour=9, minute=30)
US_EQUITIES_CLOSE = time(hour=16, minute=0)
PROMOTION_ONLY_READINESS_BLOCKERS = frozenset(
    {
        "paper_probation_evidence_collection_only",
        "paper_route_evidence_audit_stripped_promotion_authority",
        "runtime_ledger_stage_not_live",
        "live_runtime_ledger_required",
    }
)


def _as_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[str, Any], value).items()}


def _as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _as_mapping_items(value: object) -> list[dict[str, Any]]:
    return [
        _as_mapping(cast(object, item))
        for item in _as_sequence(value)
        if isinstance(item, Mapping)
    ]


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _safe_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return Decimal(int(value))
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value).strip())
        except (InvalidOperation, ValueError):
            return Decimal("0")
    return Decimal("0")


def _decimal_text(value: object) -> str:
    amount = _safe_decimal(value)
    text = format(amount, "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        text = _safe_text(value)
        if text is None:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _easter_date(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    correction = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * correction) // 451
    month = (h + correction - 7 * m + 114) // 31
    day = ((h + correction - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    value = date(year, month, 1)
    offset = (weekday - value.weekday()) % 7
    return value + timedelta(days=offset + (nth - 1) * 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    value = date(year + int(month == 12), 1 if month == 12 else month + 1, 1)
    value -= timedelta(days=1)
    return value - timedelta(days=(value.weekday() - weekday) % 7)


def _observed_fixed_holiday(year: int, month: int, day: int) -> date | None:
    value = date(year, month, day)
    if value.weekday() == 5:
        return None if month == 1 and day == 1 else value - timedelta(days=1)
    if value.weekday() == 6:
        return value + timedelta(days=1)
    return value


def _nyse_full_day_holidays(year: int) -> set[date]:
    holidays = {
        _nth_weekday(year, 1, 0, 3),
        _nth_weekday(year, 2, 0, 3),
        _easter_date(year) - timedelta(days=2),
        _last_weekday(year, 5, 0),
        _nth_weekday(year, 9, 0, 1),
        _nth_weekday(year, 11, 3, 4),
    }
    for month, day in ((1, 1), (6, 19), (7, 4), (12, 25)):
        observed = _observed_fixed_holiday(year, month, day)
        if observed is not None:
            holidays.add(observed)
    return holidays


def _regular_equities_session_date(value: date) -> bool:
    return value.weekday() < 5 and value not in _nyse_full_day_holidays(value.year)


def _next_regular_equities_session_window(
    generated_at: datetime,
) -> tuple[datetime, datetime]:
    """Return the current local trading date, or the next regular session.

    The empirical renewal job reads this dynamic plan after the close to import
    the just-finished paper-route window. Keep the current regular session until
    the New York calendar date rolls over, otherwise the importer chases the
    following session before it can ledger the one that just closed.
    """

    zone = ZoneInfo(US_EQUITIES_TIMEZONE)
    local_generated_at = generated_at.astimezone(zone)
    candidate_date = local_generated_at.date()
    while not _regular_equities_session_date(candidate_date):
        candidate_date += timedelta(days=1)
    start = datetime.combine(candidate_date, US_EQUITIES_OPEN, tzinfo=zone)
    end = datetime.combine(candidate_date, US_EQUITIES_CLOSE, tzinfo=zone)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _seconds_until(*, generated_at: datetime, target: datetime) -> int:
    return max(0, int((target - generated_at).total_seconds()))


def _paper_route_session_readiness(
    *,
    generated_at: datetime,
    window_start: datetime,
    window_end: datetime,
    probe_ready: bool,
) -> dict[str, object]:
    window_open = window_start <= generated_at <= window_end
    window_closed = generated_at > window_end
    import_blockers: list[str] = []
    if generated_at < window_start:
        state = "waiting_for_session_open"
        import_blockers.append("paper_route_session_window_not_open")
    elif window_open:
        state = "collecting_session_evidence"
        import_blockers.append("paper_route_session_window_not_closed")
    else:
        state = "window_closed_import_ready"
    if not probe_ready:
        state = "window_closed_import_blocked" if window_closed else state
        import_blockers.append("paper_route_probe_not_ready")
    return {
        "state": state,
        "session_window": {
            "start": _isoformat(window_start),
            "end": _isoformat(window_end),
        },
        "window_open": window_open,
        "window_closed": window_closed,
        "probe_ready": probe_ready,
        "import_ready": window_closed and probe_ready,
        "seconds_until_window_start": _seconds_until(
            generated_at=generated_at,
            target=window_start,
        ),
        "seconds_until_window_end": _seconds_until(
            generated_at=generated_at,
            target=window_end,
        ),
        "import_blockers": import_blockers,
    }


def _paper_route_probe_summary(
    route_reacquisition_book: Mapping[str, Any],
) -> dict[str, object]:
    summary = _as_mapping(route_reacquisition_book.get("summary"))
    probe = _as_mapping(route_reacquisition_book.get("paper_route_probe"))
    eligible_symbols = [
        str(item).strip()
        for item in _as_sequence(
            probe.get("eligible_symbols")
            or summary.get("paper_route_probe_eligible_symbols")
        )
        if str(item).strip()
    ]
    active_symbols = [
        str(item).strip()
        for item in _as_sequence(
            probe.get("active_symbols")
            or summary.get("paper_route_probe_active_symbols")
        )
        if str(item).strip()
    ]
    blocking_reasons = [
        str(item).strip()
        for item in _as_sequence(probe.get("blocking_reasons"))
        if str(item).strip()
    ]
    return {
        "schema_version": _safe_text(route_reacquisition_book.get("schema_version"))
        or "missing",
        "state": _safe_text(route_reacquisition_book.get("state")) or "unknown",
        "configured_enabled": bool(probe.get("configured_enabled")),
        "active": bool(probe.get("active")),
        "effective_max_notional": _safe_text(probe.get("effective_max_notional"))
        or "0",
        "next_session_max_notional": _safe_text(probe.get("next_session_max_notional"))
        or "0",
        "eligible_symbol_count": _safe_int(
            probe.get("eligible_symbol_count") or len(eligible_symbols)
        ),
        "eligible_symbols": eligible_symbols,
        "active_symbols": active_symbols,
        "blocking_reasons": blocking_reasons,
    }


def _paper_route_probe_symbols(probe: Mapping[str, object]) -> list[str]:
    symbols: list[str] = []
    for key in ("active_symbols", "eligible_symbols"):
        for item in _as_sequence(probe.get(key)):
            symbol = str(item).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _target_probe_symbols(
    target: Mapping[str, object],
    probe: Mapping[str, object],
) -> list[str]:
    symbols: list[str] = []
    for item in _as_sequence(target.get("paper_route_probe_symbols")):
        symbol = str(item).strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    if symbols:
        return symbols
    return _paper_route_probe_symbols(probe)


def _next_session_probe_notional(probe: Mapping[str, object]) -> str:
    next_notional = _safe_decimal(probe.get("next_session_max_notional"))
    if next_notional > 0:
        return _decimal_text(next_notional)
    return _decimal_text(probe.get("effective_max_notional"))


def _target_identity(target: Mapping[str, Any]) -> dict[str, object]:
    source_promotion_allowed = bool(target.get("promotion_allowed"))
    source_final_promotion_allowed = bool(
        target.get("final_promotion_allowed")
        or target.get("final_promotion_authorized")
    )
    return {
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
        "strategy_family": _safe_text(target.get("strategy_family")),
        "strategy_name": _safe_text(target.get("strategy_name")),
        "account_label": _safe_text(target.get("account_label")),
        "source_kind": _safe_text(target.get("source_kind")),
        "source_dsn_env": _safe_text(target.get("source_dsn_env")),
        "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
        "dataset_snapshot_ref": _safe_text(target.get("dataset_snapshot_ref")),
        "window_start": _safe_text(target.get("window_start")),
        "window_end": _safe_text(target.get("window_end")),
        "paper_route_probe_symbols": [
            str(item).strip()
            for item in _as_sequence(target.get("paper_route_probe_symbols"))
            if str(item).strip()
        ],
        "runtime_ledger_bucket_ref": _safe_text(
            target.get("runtime_ledger_bucket_ref")
        ),
        "paper_probation_authorized": bool(target.get("paper_probation_authorized")),
        "paper_probation_authorization_scope": _safe_text(
            target.get("paper_probation_authorization_scope")
        ),
        "source_promotion_allowed": source_promotion_allowed,
        "source_final_promotion_allowed": source_final_promotion_allowed,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "max_notional": _safe_text(target.get("max_notional")) or "0",
        "final_promotion_blockers": [
            str(item).strip()
            for item in _as_sequence(target.get("final_promotion_blockers"))
            if str(item).strip()
        ],
        "candidate_blockers": [
            str(item).strip()
            for item in _as_sequence(target.get("candidate_blockers"))
            if str(item).strip()
        ],
        "runtime_ledger_target_metadata_blockers": [
            str(item).strip()
            for item in _as_sequence(
                target.get("runtime_ledger_target_metadata_blockers")
            )
            if str(item).strip()
        ],
    }


def _target_window(
    target: Mapping[str, Any],
    *,
    generated_at: datetime,
    lookback_hours: int,
) -> tuple[datetime, datetime]:
    fallback_end = generated_at
    fallback_start = fallback_end - timedelta(hours=max(1, lookback_hours))
    window_start = _parse_datetime(target.get("window_start")) or fallback_start
    window_end = _parse_datetime(target.get("window_end")) or fallback_end
    if window_end < window_start:
        return fallback_start, fallback_end
    return window_start, window_end


def _next_paper_route_runtime_window_targets(
    *,
    targets: Sequence[Mapping[str, Any]],
    probe: Mapping[str, object],
    generated_at: datetime,
) -> dict[str, object]:
    window_start, window_end = _next_regular_equities_session_window(generated_at)
    probe_symbols = _paper_route_probe_symbols(probe)
    next_notional = _next_session_probe_notional(probe)
    probe_ready = (
        bool(probe.get("configured_enabled"))
        and _safe_decimal(next_notional) > 0
        and bool(probe_symbols)
    )
    session_readiness = _paper_route_session_readiness(
        generated_at=generated_at,
        window_start=window_start,
        window_end=window_end,
        probe_ready=probe_ready,
    )
    planned_targets: list[dict[str, object]] = []
    skipped_targets: list[dict[str, object]] = []
    planned_keys: set[tuple[object, ...]] = set()
    for target in targets:
        hypothesis_id = _safe_text(target.get("hypothesis_id"))
        candidate_id = _safe_text(target.get("candidate_id"))
        strategy_family = _safe_text(target.get("strategy_family"))
        strategy_name = _safe_text(target.get("strategy_name"))
        source_manifest_ref = _safe_text(target.get("source_manifest_ref"))
        missing = [
            field
            for field, value in (
                ("hypothesis_id", hypothesis_id),
                ("candidate_id", candidate_id),
                ("strategy_family", strategy_family),
                ("strategy_name", strategy_name),
                ("source_manifest_ref", source_manifest_ref),
            )
            if value is None
        ]
        if missing or not probe_ready:
            reasons = list(missing)
            if not probe_ready:
                if not bool(probe.get("configured_enabled")):
                    reasons.append("paper_route_probe_disabled")
                if _safe_decimal(next_notional) <= 0:
                    reasons.append("paper_route_probe_notional_missing")
                if not probe_symbols:
                    reasons.append("paper_route_probe_symbol_missing")
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "reason": "next_paper_route_runtime_window_target_not_ready",
                    "missing_or_blocking_fields": reasons,
                }
            )
            continue
        source_account_label = _safe_text(target.get("account_label"))
        planned_target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            "source_account_label": source_account_label or "",
            "source_dsn_env": "SIM_DB_DSN",
            "dataset_snapshot_ref": _safe_text(target.get("dataset_snapshot_ref"))
            or "",
            "source_manifest_ref": source_manifest_ref,
            "source_kind": "paper_route_probe_runtime_observed",
            "window_start": _isoformat(window_start),
            "window_end": _isoformat(window_end),
            "paper_route_probe_symbols": probe_symbols,
            "paper_route_probe_symbol_count": len(probe_symbols),
            "paper_route_probe_next_session_max_notional": next_notional,
            "paper_route_probe_window_start": _isoformat(window_start),
            "paper_route_probe_window_end": _isoformat(window_end),
            "paper_probation_authorized": True,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "evidence_collection_stage": "paper",
            "probation_allowed": True,
            "probation_reason": "paper_route_probe_next_session_runtime_window",
            "selection_reason": "paper_route_probe_next_session_evidence_collection",
            "selected_by": "paper_route_evidence_audit",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "final_promotion_blockers": [
                "paper_probation_evidence_collection_only",
                "paper_route_runtime_ledger_import_pending",
                "live_runtime_ledger_required",
            ],
            "candidate_blockers": [
                "paper_route_runtime_ledger_import_pending",
                *[
                    str(item).strip()
                    for item in _as_sequence(target.get("candidate_blockers"))
                    if str(item).strip()
                ],
            ],
            "runtime_ledger_target_metadata_blockers": [
                "paper_route_runtime_ledger_import_pending",
                "live_runtime_ledger_required",
            ],
            "handoff": "next_paper_route_runtime_window_import",
            "promotion_gate": "runtime_ledger_live_or_live_paper_required",
            "max_notional": "0",
        }
        planned_key = (
            hypothesis_id,
            candidate_id,
            strategy_family,
            strategy_name,
            planned_target["account_label"],
            planned_target["source_manifest_ref"],
            planned_target["window_start"],
            planned_target["window_end"],
            tuple(probe_symbols),
        )
        if planned_key in planned_keys:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "reason": "duplicate_next_paper_route_runtime_window_target",
                    "missing_or_blocking_fields": [
                        "duplicate_next_paper_route_runtime_window_target"
                    ],
                }
            )
            continue
        planned_keys.add(planned_key)
        planned_targets.append(planned_target)
    return {
        "schema_version": NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION,
        "source": "paper_route_evidence_audit",
        "purpose": "next_session_paper_route_runtime_window_evidence_collection",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "session_timezone": US_EQUITIES_TIMEZONE,
        "session_window": {
            "start": _isoformat(window_start),
            "end": _isoformat(window_end),
        },
        "session_readiness": session_readiness,
        "paper_route_probe": {
            "configured_enabled": bool(probe.get("configured_enabled")),
            "active": bool(probe.get("active")),
            "symbols": probe_symbols,
            "symbol_count": len(probe_symbols),
            "next_session_max_notional": next_notional,
            "blocking_reasons": [
                str(item).strip()
                for item in _as_sequence(probe.get("blocking_reasons"))
                if str(item).strip()
            ],
        },
        "target_count": len(planned_targets),
        "skipped_target_count": len(skipped_targets),
        "targets": planned_targets,
        "skipped_targets": skipped_targets,
    }


def _strategy_source_activity(
    session: Session,
    *,
    strategy_name: str | None,
    account_label: str | None,
    symbols: Sequence[str],
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    symbol_filters = [
        str(item).strip().upper() for item in symbols if str(item).strip()
    ]
    if strategy_name is None:
        return {
            "strategy_name": None,
            "account_label": account_label,
            "symbols": symbol_filters,
            "decision_count": 0,
            "execution_count": 0,
            "filled_execution_count": 0,
            "tca_sample_count": 0,
            "last_decision_at": None,
            "last_execution_at": None,
            "last_tca_at": None,
            "missing": True,
            "missing_reasons": ["strategy_name_missing"],
        }

    decision_stmt = (
        select(TradeDecision)
        .join(Strategy, TradeDecision.strategy_id == Strategy.id)
        .where(Strategy.name == strategy_name)
        .where(TradeDecision.created_at >= window_start)
        .where(TradeDecision.created_at <= window_end)
    )
    if account_label:
        decision_stmt = decision_stmt.where(
            TradeDecision.alpaca_account_label == account_label
        )
    if symbol_filters:
        decision_stmt = decision_stmt.where(
            func.upper(TradeDecision.symbol).in_(symbol_filters)
        )
    decision_rows = list(
        session.execute(
            decision_stmt.order_by(TradeDecision.created_at.desc()).limit(500)
        ).scalars()
    )
    decision_ids = [row.id for row in decision_rows]
    execution_rows: list[Execution] = []
    if decision_ids:
        execution_stmt = (
            select(Execution)
            .where(Execution.trade_decision_id.in_(decision_ids))
            .where(Execution.created_at >= window_start)
            .where(Execution.created_at <= window_end)
        )
        if account_label:
            execution_stmt = execution_stmt.where(
                Execution.alpaca_account_label == account_label
            )
        if symbol_filters:
            execution_stmt = execution_stmt.where(
                func.upper(Execution.symbol).in_(symbol_filters)
            )
        execution_rows = list(
            session.execute(
                execution_stmt.order_by(Execution.created_at.desc()).limit(500)
            ).scalars()
        )
    tca_rows: list[ExecutionTCAMetric] = []
    if decision_ids:
        tca_stmt = (
            select(ExecutionTCAMetric)
            .join(Strategy, ExecutionTCAMetric.strategy_id == Strategy.id)
            .where(Strategy.name == strategy_name)
            .where(ExecutionTCAMetric.computed_at >= window_start)
            .where(ExecutionTCAMetric.computed_at <= window_end)
        )
        tca_stmt = tca_stmt.where(
            ExecutionTCAMetric.trade_decision_id.in_(decision_ids)
        )
        if account_label:
            tca_stmt = tca_stmt.where(
                ExecutionTCAMetric.alpaca_account_label == account_label
            )
        if symbol_filters:
            tca_stmt = tca_stmt.where(
                func.upper(ExecutionTCAMetric.symbol).in_(symbol_filters)
            )
        tca_rows = list(
            session.execute(
                tca_stmt.order_by(ExecutionTCAMetric.computed_at.desc()).limit(500)
            ).scalars()
        )
    decision_count = len(decision_rows)
    execution_count = len(execution_rows)
    tca_sample_count = len(tca_rows)
    filled_execution_count = sum(
        int(_safe_decimal(row.filled_qty) > 0) for row in execution_rows
    )
    missing_reasons: list[str] = []
    if decision_count <= 0:
        missing_reasons.append("source_decisions_missing")
    if execution_count <= 0:
        missing_reasons.append("source_executions_missing")
    if tca_sample_count <= 0:
        missing_reasons.append("source_tca_missing")
    return {
        "strategy_name": strategy_name,
        "account_label": account_label,
        "symbols": symbol_filters,
        "decision_count": decision_count,
        "execution_count": execution_count,
        "filled_execution_count": filled_execution_count,
        "tca_sample_count": tca_sample_count,
        "last_decision_at": _isoformat(
            decision_rows[0].created_at if decision_rows else None
        ),
        "last_execution_at": _isoformat(
            execution_rows[0].created_at if execution_rows else None
        ),
        "last_tca_at": _isoformat(tca_rows[0].computed_at if tca_rows else None),
        "missing": bool(missing_reasons),
        "missing_reasons": missing_reasons,
    }


def _target_filters(
    stmt: Any,
    model: Any,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
) -> Any:
    if hypothesis_id is None:
        return stmt.where(model.hypothesis_id == "__missing_paper_route_hypothesis__")
    stmt = stmt.where(model.hypothesis_id == hypothesis_id)
    if candidate_id is not None:
        stmt = stmt.where(model.candidate_id == candidate_id)
    return stmt


def _positive_hash_count(value: object) -> bool:
    counts = _as_mapping(value)
    return bool(counts) and any(_safe_int(count) > 0 for count in counts.values())


def _runtime_ledger_bucket_evidence_grade(row: StrategyRuntimeLedgerBucket) -> bool:
    blockers = [
        str(item).strip()
        for item in _as_sequence(row.blockers_json)
        if str(item).strip()
    ]
    return (
        row.pnl_basis == POST_COST_PNL_BASIS
        and _safe_int(row.fill_count) > 0
        and _safe_int(row.submitted_order_count) > 0
        and _safe_int(row.closed_trade_count) > 0
        and _safe_int(row.open_position_count) == 0
        and _safe_decimal(row.filled_notional) > 0
        and _positive_hash_count(row.execution_policy_hash_counts)
        and _positive_hash_count(row.cost_model_hash_counts)
        and _positive_hash_count(row.lineage_hash_counts)
        and not blockers
    )


def _runtime_ledger_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    stmt = select(StrategyRuntimeLedgerBucket).order_by(
        StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
        StrategyRuntimeLedgerBucket.created_at.desc(),
    )
    stmt = _target_filters(
        stmt,
        StrategyRuntimeLedgerBucket,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    stmt = stmt.where(StrategyRuntimeLedgerBucket.bucket_started_at <= window_end)
    stmt = stmt.where(StrategyRuntimeLedgerBucket.bucket_ended_at >= window_start)
    rows = list(session.execute(stmt.limit(50)).scalars())
    filled_notional = sum((row.filled_notional for row in rows), Decimal("0"))
    net_pnl = sum((row.net_strategy_pnl_after_costs for row in rows), Decimal("0"))
    return {
        "bucket_count": len(rows),
        "evidence_grade_bucket_count": sum(
            int(_runtime_ledger_bucket_evidence_grade(row)) for row in rows
        ),
        "fill_count": sum(max(0, _safe_int(row.fill_count)) for row in rows),
        "decision_count": sum(max(0, _safe_int(row.decision_count)) for row in rows),
        "submitted_order_count": sum(
            max(0, _safe_int(row.submitted_order_count)) for row in rows
        ),
        "closed_trade_count": sum(
            max(0, _safe_int(row.closed_trade_count)) for row in rows
        ),
        "open_position_count": sum(
            max(0, _safe_int(row.open_position_count)) for row in rows
        ),
        "filled_notional": _decimal_text(filled_notional),
        "net_strategy_pnl_after_costs": _decimal_text(net_pnl),
        "post_cost_expectancy_bps": _decimal_text(
            (net_pnl / filled_notional * Decimal("10000"))
            if filled_notional > 0
            else Decimal("0")
        ),
        "latest_bucket_ended_at": _isoformat(rows[0].bucket_ended_at if rows else None),
        "db_row_refs": [str(row.id) for row in rows],
        "blockers": sorted(
            {
                str(item).strip()
                for row in rows
                for item in _as_sequence(row.blockers_json)
                if str(item).strip()
            }
        ),
    }


def _hypothesis_window_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    stmt = select(StrategyHypothesisMetricWindow).order_by(
        StrategyHypothesisMetricWindow.window_ended_at.desc().nullslast(),
        StrategyHypothesisMetricWindow.created_at.desc(),
    )
    stmt = _target_filters(
        stmt,
        StrategyHypothesisMetricWindow,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    stmt = stmt.where(StrategyHypothesisMetricWindow.window_started_at <= window_end)
    stmt = stmt.where(StrategyHypothesisMetricWindow.window_ended_at >= window_start)
    rows = list(session.execute(stmt.limit(50)).scalars())
    provenance_counts: dict[str, int] = {}
    maturity_counts: dict[str, int] = {}
    for row in rows:
        provenance = row.evidence_provenance or "missing"
        maturity = row.evidence_maturity or "missing"
        provenance_counts[provenance] = provenance_counts.get(provenance, 0) + 1
        maturity_counts[maturity] = maturity_counts.get(maturity, 0) + 1
    return {
        "window_count": len(rows),
        "decision_count": sum(max(0, _safe_int(row.decision_count)) for row in rows),
        "trade_count": sum(max(0, _safe_int(row.trade_count)) for row in rows),
        "order_count": sum(max(0, _safe_int(row.order_count)) for row in rows),
        "market_session_count": sum(
            max(0, _safe_int(row.market_session_count)) for row in rows
        ),
        "latest_window_ended_at": _isoformat(rows[0].window_ended_at if rows else None),
        "evidence_provenance_counts": provenance_counts,
        "evidence_maturity_counts": maturity_counts,
        "db_row_refs": [str(row.id) for row in rows],
    }


def _promotion_decision_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
) -> dict[str, object]:
    stmt = select(StrategyPromotionDecision).order_by(
        StrategyPromotionDecision.created_at.desc()
    )
    stmt = _target_filters(
        stmt,
        StrategyPromotionDecision,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    rows = list(session.execute(stmt.limit(20)).scalars())
    latest = rows[0] if rows else None
    return {
        "decision_count": len(rows),
        "allowed_count": sum(int(bool(row.allowed)) for row in rows),
        "latest": None
        if latest is None
        else {
            "id": str(latest.id),
            "run_id": latest.run_id,
            "promotion_target": latest.promotion_target,
            "state": latest.state,
            "allowed": bool(latest.allowed),
            "reason_summary": latest.reason_summary,
            "created_at": _isoformat(latest.created_at),
        },
        "db_row_refs": [str(row.id) for row in rows],
    }


def _readiness_blockers(
    *,
    target: Mapping[str, object],
    probe: Mapping[str, object],
    source_activity: Mapping[str, object],
    runtime_ledger: Mapping[str, object],
    hypothesis_windows: Mapping[str, object],
    promotion_decisions: Mapping[str, object],
) -> list[str]:
    blockers = {
        str(item).strip()
        for key in (
            "final_promotion_blockers",
            "candidate_blockers",
            "runtime_ledger_target_metadata_blockers",
        )
        for item in _as_sequence(target.get(key))
        if str(item).strip()
    }
    if not bool(target.get("promotion_allowed")):
        blockers.add("paper_probation_evidence_collection_only")
    if bool(target.get("source_promotion_allowed")) or bool(
        target.get("source_final_promotion_allowed")
    ):
        blockers.add("paper_route_evidence_audit_stripped_promotion_authority")
    if not bool(probe.get("configured_enabled")):
        blockers.add("paper_route_probe_disabled")
    if _safe_int(probe.get("eligible_symbol_count")) <= 0:
        blockers.add("paper_route_probe_candidate_missing")
    probe_blockers = [
        str(item).strip()
        for item in _as_sequence(probe.get("blocking_reasons"))
        if str(item).strip() and str(item).strip() != "market_session_closed"
    ]
    blockers.update(probe_blockers)
    blockers.update(
        str(item).strip()
        for item in _as_sequence(source_activity.get("missing_reasons"))
        if str(item).strip()
    )
    if _safe_int(runtime_ledger.get("bucket_count")) <= 0:
        blockers.add("runtime_ledger_bucket_missing")
    if _safe_int(runtime_ledger.get("evidence_grade_bucket_count")) <= 0:
        blockers.add("runtime_ledger_evidence_grade_bucket_missing")
    if _safe_int(hypothesis_windows.get("window_count")) <= 0:
        blockers.add("hypothesis_window_missing")
    if _safe_int(promotion_decisions.get("decision_count")) <= 0:
        blockers.add("promotion_decision_missing")
    else:
        latest = _as_mapping(promotion_decisions.get("latest"))
        if not bool(latest.get("allowed")):
            blockers.add("promotion_decision_not_allowed")
    return sorted(blockers)


def _target_audit(
    session: Session,
    *,
    raw_target: Mapping[str, Any],
    probe: Mapping[str, object],
    generated_at: datetime,
    lookback_hours: int,
) -> dict[str, object]:
    target = _target_identity(raw_target)
    window_start, window_end = _target_window(
        target,
        generated_at=generated_at,
        lookback_hours=lookback_hours,
    )
    hypothesis_id = cast(str | None, target.get("hypothesis_id"))
    candidate_id = cast(str | None, target.get("candidate_id"))
    source_activity = _strategy_source_activity(
        session,
        strategy_name=cast(str | None, target.get("strategy_name")),
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_start=window_start,
        window_end=window_end,
    )
    runtime_ledger = _runtime_ledger_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
        window_start=window_start,
        window_end=window_end,
    )
    hypothesis_windows = _hypothesis_window_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
        window_start=window_start,
        window_end=window_end,
    )
    promotion_decisions = _promotion_decision_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
    )
    blockers = _readiness_blockers(
        target=target,
        probe=probe,
        source_activity=source_activity,
        runtime_ledger=runtime_ledger,
        hypothesis_windows=hypothesis_windows,
        promotion_decisions=promotion_decisions,
    )
    evidence_collection_blockers = [
        blocker
        for blocker in blockers
        if blocker not in PROMOTION_ONLY_READINESS_BLOCKERS
    ]
    return {
        "target": target,
        "window": {
            "start": _isoformat(window_start),
            "end": _isoformat(window_end),
        },
        "source_activity": source_activity,
        "runtime_ledger": runtime_ledger,
        "hypothesis_windows": hypothesis_windows,
        "promotion_decisions": promotion_decisions,
        "readiness": {
            "state": (
                "evidence_collection_blocked"
                if evidence_collection_blockers
                else "paper_evidence_collecting"
            ),
            "promotion_allowed": bool(target.get("promotion_allowed")),
            "final_promotion_allowed": bool(target.get("final_promotion_allowed")),
            "blockers": blockers,
            "evidence_collection_blockers": evidence_collection_blockers,
            "promotion_authority": {
                "allowed": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "source_promotion_allowed": bool(
                    target.get("source_promotion_allowed")
                ),
                "source_final_promotion_allowed": bool(
                    target.get("source_final_promotion_allowed")
                ),
                "blockers": blockers,
            },
        },
    }


def build_paper_route_evidence_audit(
    session: Session,
    *,
    live_submission_gate: Mapping[str, Any],
    route_reacquisition_book: Mapping[str, Any],
    generated_at: datetime | None = None,
    lookback_hours: int = DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    target_limit: int = DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
) -> dict[str, object]:
    """Build a target-by-target audit for paper-route evidence collection."""

    resolved_generated_at = generated_at or datetime.now(timezone.utc)
    plan = _as_mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    targets = _as_mapping_items(plan.get("targets"))[: max(0, target_limit)]
    probe = _paper_route_probe_summary(route_reacquisition_book)
    target_audits = [
        _target_audit(
            session,
            raw_target=target,
            probe=probe,
            generated_at=resolved_generated_at,
            lookback_hours=lookback_hours,
        )
        for target in targets
    ]
    summary_blockers = sorted(
        {
            str(blocker)
            for audit in target_audits
            for blocker in _as_sequence(
                _as_mapping(audit.get("readiness")).get("blockers")
            )
        }
    )
    if not targets:
        summary_blockers.append("paper_probation_import_plan_missing")
    return {
        "schema_version": PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION,
        "generated_at": _isoformat(resolved_generated_at),
        "window": {
            "lookback_hours": lookback_hours,
            "target_limit": target_limit,
        },
        "live_submission_gate": {
            "allowed": bool(live_submission_gate.get("allowed")),
            "reason": _safe_text(live_submission_gate.get("reason")),
            "blocked_reasons": [
                str(item).strip()
                for item in _as_sequence(live_submission_gate.get("blocked_reasons"))
                if str(item).strip()
            ],
            "promotion_eligible_total": _safe_int(
                live_submission_gate.get("promotion_eligible_total")
            ),
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": _safe_text(plan.get("schema_version")),
                "target_count": _safe_int(plan.get("target_count") or len(targets)),
                "skipped_target_count": _safe_int(plan.get("skipped_target_count")),
                "source_promotion_allowed": bool(plan.get("promotion_allowed")),
                "source_final_promotion_allowed": bool(
                    plan.get("final_promotion_allowed")
                    or plan.get("final_promotion_authorized")
                ),
                "promotion_allowed": False,
                "final_promotion_allowed": False,
            },
        },
        "paper_route_probe": probe,
        "next_paper_route_runtime_window_targets": (
            _next_paper_route_runtime_window_targets(
                targets=targets,
                probe=probe,
                generated_at=resolved_generated_at,
            )
        ),
        "summary": {
            "target_count": len(targets),
            "target_with_source_activity_count": sum(
                int(not bool(_as_mapping(audit.get("source_activity")).get("missing")))
                for audit in target_audits
            ),
            "target_with_runtime_ledger_count": sum(
                int(
                    _safe_int(
                        _as_mapping(audit.get("runtime_ledger")).get("bucket_count")
                    )
                    > 0
                )
                for audit in target_audits
            ),
            "target_with_promotion_decision_count": sum(
                int(
                    _safe_int(
                        _as_mapping(audit.get("promotion_decisions")).get(
                            "decision_count"
                        )
                    )
                    > 0
                )
                for audit in target_audits
            ),
            "promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "promotion_allowed"
                        )
                    )
                )
                for audit in target_audits
            ),
            "final_promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "final_promotion_allowed"
                        )
                    )
                )
                for audit in target_audits
            ),
            "source_promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "source_promotion_allowed"
                        )
                    )
                )
                for audit in target_audits
            ),
            "source_final_promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "source_final_promotion_allowed"
                        )
                    )
                )
                for audit in target_audits
            ),
            "promotion_authority": {
                "allowed": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "blockers": summary_blockers,
            },
            "blockers": summary_blockers,
        },
        "targets": target_audits,
    }


__all__ = [
    "DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION",
    "PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION",
    "build_paper_route_evidence_audit",
]
