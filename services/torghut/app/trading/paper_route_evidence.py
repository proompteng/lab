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
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from .runtime_cost_authority import cost_basis_counts_have_non_promotion_grade_costs
from .runtime_ledger import POST_COST_PNL_BASIS


PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION = "torghut.paper-route-evidence.v1"
NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION = (
    "torghut.next-paper-route-runtime-window-targets.v1"
)
PAPER_ROUTE_RUNTIME_WINDOW_IMPORT_AUDIT_SCHEMA_VERSION = (
    "torghut.paper-route-runtime-window-import-audit.v1"
)
RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION = (
    "torghut.runtime-ledger-proof-packet-handoff.v1"
)
DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS = 72
DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT = 20
PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL = "TORGHUT_SIM"
PAPER_ROUTE_RUNTIME_IMPORT_SETTLEMENT_SECONDS = 3600
DEFAULT_TORGHUT_LIVE_SERVICE_BASE_URL = "http://torghut.torghut.svc.cluster.local"
DEFAULT_TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL = (
    "http://torghut-sim.torghut.svc.cluster.local"
)
RUNTIME_LEDGER_PROOF_PACKET_OUTPUT_FILE = "artifacts/runtime-ledger-proof-packet.json"
RUNTIME_WINDOW_IMPORT_OUTPUT_FILE = "artifacts/runtime-window-import.json"
RUNTIME_LEDGER_PROOF_PACKET_ARTIFACT_PREFIX = "runtime-ledger-proof-packets/{run_id}"
RUNTIME_LEDGER_SUMMARY_ROW_LIMIT = 50
MIN_RUNTIME_LEDGER_PROOF_NET_PNL = "500"
MIN_RUNTIME_LEDGER_PROOF_DAILY_NET_PNL = "500"
MIN_RUNTIME_LEDGER_PROOF_TRADING_DAYS = 1
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
SOURCE_LINEAGE_CANDIDATE_KEYS = (
    "candidate_id",
    "candidate_ids",
    "strategy_candidate_id",
    "strategy_candidate_ids",
    "source_candidate_id",
    "source_candidate_ids",
)
SOURCE_LINEAGE_HYPOTHESIS_KEYS = (
    "hypothesis_id",
    "hypothesis_ids",
    "strategy_hypothesis_id",
    "strategy_hypothesis_ids",
    "source_hypothesis_id",
    "source_hypothesis_ids",
)


def _as_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[str, Any], value).items()}


def _as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _source_payloads(value: object) -> list[Mapping[str, Any]]:
    payloads: list[Mapping[str, Any]] = []

    def append_payload(candidate: object, *, depth: int) -> None:
        if not isinstance(candidate, Mapping):
            return
        payload = {
            str(key): item for key, item in cast(Mapping[str, Any], candidate).items()
        }
        payloads.append(payload)
        if depth <= 0:
            return
        for nested in payload.values():
            append_payload(nested, depth=depth - 1)

    append_payload(value, depth=4)
    return payloads


def _source_lineage_values(value: object, keys: Sequence[str]) -> set[str]:
    values: set[str] = set()
    for payload in _source_payloads(value):
        for key in keys:
            raw_value = payload.get(key)
            if isinstance(raw_value, Sequence) and not isinstance(
                raw_value, (str, bytes, bytearray)
            ):
                for item in cast(Sequence[object], raw_value):
                    if text := _safe_text(item):
                        values.add(text)
            elif text := _safe_text(raw_value):
                values.add(text)
    return values


def _source_decision_lineage_matches(
    row: TradeDecision,
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> bool:
    payload = row.decision_json
    if candidate_id is not None and candidate_id not in _source_lineage_values(
        payload, SOURCE_LINEAGE_CANDIDATE_KEYS
    ):
        return False
    if hypothesis_id is not None and hypothesis_id not in _source_lineage_values(
        payload, SOURCE_LINEAGE_HYPOTHESIS_KEYS
    ):
        return False
    return True


def _source_lineage_blockers(
    rows: Sequence[TradeDecision],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
) -> list[str]:
    if not rows:
        return []
    blockers: list[str] = []
    if candidate_id is not None:
        candidate_values: set[str] = set()
        for row in rows:
            candidate_values.update(
                _source_lineage_values(row.decision_json, SOURCE_LINEAGE_CANDIDATE_KEYS)
            )
        if not candidate_values:
            blockers.append("source_candidate_lineage_missing")
        elif candidate_id not in candidate_values:
            blockers.append("source_candidate_lineage_mismatch")
    if hypothesis_id is not None:
        hypothesis_values: set[str] = set()
        for row in rows:
            hypothesis_values.update(
                _source_lineage_values(
                    row.decision_json, SOURCE_LINEAGE_HYPOTHESIS_KEYS
                )
            )
        if not hypothesis_values:
            blockers.append("source_hypothesis_lineage_missing")
        elif hypothesis_id not in hypothesis_values:
            blockers.append("source_hypothesis_lineage_mismatch")
    return blockers


def _target_requires_source_lineage(target: Mapping[str, object]) -> bool:
    source_kind = str(target.get("source_kind") or "").strip().lower().replace("-", "_")
    return source_kind in {
        "paper_route_probe_runtime_observed",
        "paper_runtime_observed",
        "live_runtime_observed",
    }


def _unique_text_items(value: object) -> list[str]:
    items: list[str] = []
    for raw_item in _as_sequence(value):
        item = str(raw_item).strip()
        if item and item not in items:
            items.append(item)
    return items


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


def _strategy_name_from_strategy_id(strategy_id: object) -> str | None:
    text = _safe_text(strategy_id)
    if text is None:
        return None
    base = text.split("@", 1)[0].strip()
    return base.replace("_", "-") if base else None


def _strategy_lookup_names(*values: object) -> list[str]:
    names: list[str] = []
    for value in values:
        raw_items: Sequence[object]
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            raw_items = cast(Sequence[object], value)
        else:
            raw_items = (value,)
        for raw_item in raw_items:
            text = _safe_text(raw_item)
            if text is not None and text not in names:
                names.append(text)
    return names


def _health_gate_bool_text(value: object) -> str | None:
    if isinstance(value, bool):
        return "true" if value else "false"
    text = _safe_text(value)
    if text is None:
        return None
    normalized = text.lower()
    if normalized in {"true", "false"}:
        return normalized
    return None


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


def _optional_decimal_text(value: object) -> str | None:
    if value is None:
        return None
    return _decimal_text(value)


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _execution_activity_timestamp() -> Any:
    return func.coalesce(
        Execution.order_feed_last_event_ts,
        Execution.last_update_at,
        Execution.updated_at,
        Execution.created_at,
    )


def _execution_activity_at(row: Execution) -> datetime | None:
    return (
        row.order_feed_last_event_ts
        or row.last_update_at
        or row.updated_at
        or row.created_at
    )


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
    settlement_seconds: int,
) -> dict[str, object]:
    settlement_seconds = max(0, int(settlement_seconds))
    settlement_ready_at = window_end + timedelta(seconds=settlement_seconds)
    window_open = window_start <= generated_at <= window_end
    window_closed = generated_at > window_end
    settlement_ready = generated_at >= settlement_ready_at
    import_blockers: list[str] = []
    if generated_at < window_start:
        state = "waiting_for_session_open"
        import_blockers.append("paper_route_session_window_not_open")
    elif window_open:
        state = "collecting_session_evidence"
        import_blockers.append("paper_route_session_window_not_closed")
    elif not settlement_ready:
        state = "window_closed_settlement_pending"
        import_blockers.append("paper_route_session_settlement_pending")
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
        "settlement_seconds": settlement_seconds,
        "settlement_ready": settlement_ready,
        "settlement_ready_at": _isoformat(settlement_ready_at),
        "probe_ready": probe_ready,
        "import_ready": window_closed and settlement_ready and probe_ready,
        "seconds_until_window_start": _seconds_until(
            generated_at=generated_at,
            target=window_start,
        ),
        "seconds_until_window_end": _seconds_until(
            generated_at=generated_at,
            target=window_end,
        ),
        "seconds_until_import_ready": _seconds_until(
            generated_at=generated_at,
            target=settlement_ready_at,
        ),
        "import_blockers": import_blockers,
    }


def _paper_route_probe_summary(
    route_reacquisition_book: Mapping[str, Any],
    *,
    target_plan: Mapping[str, Any] | None = None,
    target_plan_source: str | None = None,
    target_plan_error: str | None = None,
) -> dict[str, object]:
    summary = _as_mapping(route_reacquisition_book.get("summary"))
    probe = _as_mapping(route_reacquisition_book.get("paper_route_probe"))
    raw_eligible_symbols = [
        str(item).strip()
        for item in _as_sequence(
            probe.get("eligible_symbols")
            or summary.get("paper_route_probe_eligible_symbols")
        )
        if str(item).strip()
    ]
    raw_active_symbols = [
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
    target_plan_scope_symbols = _target_plan_probe_scope_symbols(target_plan or {})
    target_plan_scope_applied = (
        target_plan_source == "external_target_plan_url"
        and bool(target_plan_scope_symbols)
    )
    eligible_symbols = raw_eligible_symbols
    active_symbols = raw_active_symbols
    out_of_scope_symbols: list[str] = []
    missing_scope_symbols: list[str] = []
    if target_plan_source == "external_target_plan_url":
        if target_plan_error:
            blocking_reasons.append(target_plan_error)
        if target_plan_scope_symbols:
            eligible_symbols, out_of_scope_symbols, missing_scope_symbols = (
                _scope_probe_symbols_to_target_plan(
                    raw_eligible_symbols,
                    scope_symbols=target_plan_scope_symbols,
                )
            )
            active_symbols, _out_of_scope_active_symbols, _missing_active_symbols = (
                _scope_probe_symbols_to_target_plan(
                    raw_active_symbols,
                    scope_symbols=target_plan_scope_symbols,
                )
            )
            if missing_scope_symbols:
                blocking_reasons.append("external_target_plan_symbols_missing")
        else:
            eligible_symbols = []
            active_symbols = []
            out_of_scope_symbols = raw_eligible_symbols
            blocking_reasons.append("external_target_plan_probe_symbols_missing")

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
        "eligible_symbol_count": len(eligible_symbols)
        if target_plan_source == "external_target_plan_url"
        else _safe_int(probe.get("eligible_symbol_count") or len(eligible_symbols)),
        "eligible_symbols": eligible_symbols,
        "active_symbols": active_symbols,
        "blocking_reasons": blocking_reasons,
        "target_plan_source": target_plan_source,
        "target_plan_scope_applied": target_plan_scope_applied,
        "target_plan_scope_symbols": target_plan_scope_symbols,
        "raw_eligible_symbols": raw_eligible_symbols,
        "raw_active_symbols": raw_active_symbols,
        "out_of_scope_symbols": out_of_scope_symbols,
        "missing_scope_symbols": missing_scope_symbols,
    }


def _target_plan_probe_scope_symbols(target_plan: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for target in _as_mapping_items(target_plan.get("targets")):
        raw_symbols = target.get("paper_route_probe_symbols")
        values: Sequence[object]
        if isinstance(raw_symbols, str):
            values = raw_symbols.split(",")
        else:
            values = _as_sequence(raw_symbols)
        for raw_symbol in values:
            symbol = str(raw_symbol).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _target_plan_source(target_plan: Mapping[str, Any]) -> str | None:
    for target in _as_mapping_items(target_plan.get("targets")):
        source = _safe_text(target.get("paper_route_target_plan_source"))
        if source:
            return source
    return None


def _scope_probe_symbols_to_target_plan(
    symbols: Sequence[str],
    *,
    scope_symbols: Sequence[str],
) -> tuple[list[str], list[str], list[str]]:
    symbol_by_upper = {
        str(symbol).strip().upper(): str(symbol).strip() for symbol in symbols
    }
    scoped_symbols = [
        str(scope_symbol).strip().upper()
        for scope_symbol in scope_symbols
        if str(scope_symbol).strip().upper() in symbol_by_upper
    ]
    scope_symbol_set = {
        str(scope_symbol).strip().upper() for scope_symbol in scope_symbols
    }
    out_of_scope_symbols = [
        str(symbol).strip()
        for symbol in symbols
        if str(symbol).strip() and str(symbol).strip().upper() not in scope_symbol_set
    ]
    missing_scope_symbols = [
        str(scope_symbol).strip().upper()
        for scope_symbol in scope_symbols
        if str(scope_symbol).strip().upper() not in symbol_by_upper
    ]
    return scoped_symbols, out_of_scope_symbols, missing_scope_symbols


def _paper_route_probe_symbols(probe: Mapping[str, object]) -> list[str]:
    symbols: list[str] = []
    for key in ("active_symbols", "eligible_symbols"):
        for item in _as_sequence(probe.get(key)):
            symbol = str(item).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def _declared_target_probe_symbols(target: Mapping[str, object]) -> list[str]:
    symbols: list[str] = []
    for item in _as_sequence(target.get("paper_route_probe_symbols")):
        symbol = str(item).strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def _target_uses_current_probe_scope(target: Mapping[str, object]) -> bool:
    if _safe_text(target.get("paper_route_probe_scope_authority")) in {
        "external_target_plan",
        "strategy_universe",
    }:
        return False
    source_kind = _safe_text(target.get("source_kind"))
    handoff = _safe_text(target.get("handoff"))
    return (
        source_kind == "paper_route_probe_runtime_observed"
        or handoff == "next_paper_route_runtime_window_import"
        or bool(_as_mapping(target.get("paper_route_runtime_import_handoff")))
    )


def _target_probe_symbols(
    target: Mapping[str, object],
    probe: Mapping[str, object],
) -> list[str]:
    symbols = _declared_target_probe_symbols(target)
    if _target_uses_current_probe_scope(target):
        for symbol in _paper_route_probe_symbols(probe):
            if symbol not in symbols:
                symbols.append(symbol)
    if symbols:
        return symbols
    return _paper_route_probe_symbols(probe)


def _strategy_universe_symbols(
    session: Session,
    *,
    strategy_lookup_names: Sequence[str],
) -> list[str]:
    if not strategy_lookup_names:
        return []
    rows = session.execute(
        select(Strategy.name, Strategy.universe_symbols).where(
            Strategy.name.in_(list(strategy_lookup_names))
        )
    ).all()
    universe_by_name = {
        str(name): universe_symbols for name, universe_symbols in rows if name
    }
    for strategy_name in strategy_lookup_names:
        raw_symbols = universe_by_name.get(strategy_name)
        symbols: list[str] = []
        for item in _as_sequence(raw_symbols):
            symbol = str(item).strip().upper()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
        if symbols:
            return symbols
    return []


def _next_session_probe_notional(probe: Mapping[str, object]) -> str:
    next_notional = _safe_decimal(probe.get("next_session_max_notional"))
    if next_notional > 0:
        return _decimal_text(next_notional)
    return _decimal_text(probe.get("effective_max_notional"))


def _target_identity(
    target: Mapping[str, Any],
    *,
    probe: Mapping[str, object],
) -> dict[str, object]:
    source_promotion_allowed = bool(target.get("promotion_allowed"))
    source_final_promotion_allowed = bool(
        target.get("final_promotion_allowed")
        or target.get("final_promotion_authorized")
    )
    strategy_name = _safe_text(target.get("strategy_name"))
    strategy_id = _safe_text(target.get("strategy_id"))
    runtime_strategy_name = (
        _safe_text(target.get("runtime_strategy_name")) or strategy_name
    )
    strategy_lookup_names = _strategy_lookup_names(
        target.get("strategy_lookup_names"),
        runtime_strategy_name,
        strategy_name,
        _strategy_name_from_strategy_id(strategy_id),
    )
    return {
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
        "strategy_family": _safe_text(target.get("strategy_family")),
        "strategy_name": strategy_name,
        "strategy_id": strategy_id,
        "runtime_strategy_name": runtime_strategy_name,
        "strategy_lookup_names": strategy_lookup_names,
        "account_label": _safe_text(target.get("account_label")),
        "source_kind": _safe_text(target.get("source_kind")),
        "source_dsn_env": _safe_text(target.get("source_dsn_env")),
        "source_manifest_ref": _safe_text(target.get("source_manifest_ref")),
        "dataset_snapshot_ref": _safe_text(target.get("dataset_snapshot_ref")),
        "window_start": _safe_text(target.get("window_start")),
        "window_end": _safe_text(target.get("window_end")),
        "paper_route_target_plan_source": _safe_text(
            target.get("paper_route_target_plan_source")
        ),
        "paper_route_probe_scope_authority": _safe_text(
            target.get("paper_route_probe_scope_authority")
        ),
        "paper_route_probe_symbols": _target_probe_symbols(target, probe),
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
        "final_promotion_blockers": _unique_text_items(
            target.get("final_promotion_blockers")
        ),
        "candidate_blockers": _unique_text_items(target.get("candidate_blockers")),
        "runtime_ledger_target_metadata_blockers": _unique_text_items(
            target.get("runtime_ledger_target_metadata_blockers")
        ),
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


def _runtime_window_import_health_gate(
    *,
    target: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    nested_gate = _as_mapping(target.get("runtime_window_import_health_gate"))

    def text_value(*items: tuple[str, object]) -> tuple[str, str]:
        for source, value in items:
            text = _safe_text(value)
            if text is not None:
                return text.lower(), source
        return "missing", "missing"

    def bool_value(*items: tuple[str, object]) -> tuple[str, str]:
        for source, value in items:
            text = _health_gate_bool_text(value)
            if text is not None:
                return text, source
        return "false", "missing"

    def reason_value(
        default: str,
        selected_source: str,
        *items: tuple[str, object],
    ) -> str:
        for source, value in items:
            if source != selected_source:
                continue
            text = _safe_text(value)
            if text is not None:
                return text
        for _, value in items:
            text = _safe_text(value)
            if text is not None:
                return text
        return default

    dependency_quorum_decision, dependency_quorum_source = text_value(
        ("target_plan", target.get("dependency_quorum_decision")),
        (
            "target_plan.runtime_window_import_health_gate",
            nested_gate.get("dependency_quorum_decision"),
        ),
        (
            "live_submission_gate",
            live_submission_gate.get("dependency_quorum_decision"),
        ),
    )
    continuity_ok, continuity_source = bool_value(
        ("target_plan", target.get("continuity_ok")),
        (
            "target_plan.runtime_window_import_health_gate",
            nested_gate.get("continuity_ok"),
        ),
        ("live_submission_gate", live_submission_gate.get("continuity_ok")),
    )
    drift_ok, drift_source = bool_value(
        ("target_plan", target.get("drift_ok")),
        ("target_plan.runtime_window_import_health_gate", nested_gate.get("drift_ok")),
        ("live_submission_gate", live_submission_gate.get("drift_ok")),
    )
    continuity_reason = reason_value(
        "continuity_ok" if continuity_ok == "true" else "continuity_not_ok",
        continuity_source,
        ("target_plan", target.get("continuity_reason")),
        (
            "target_plan.runtime_window_import_health_gate",
            nested_gate.get("continuity_reason"),
        ),
        ("live_submission_gate", live_submission_gate.get("continuity_reason")),
    )
    drift_reason = reason_value(
        "drift_ok" if drift_ok == "true" else "drift_not_ok",
        drift_source,
        ("target_plan", target.get("drift_reason")),
        (
            "target_plan.runtime_window_import_health_gate",
            nested_gate.get("drift_reason"),
        ),
        ("live_submission_gate", live_submission_gate.get("drift_reason")),
    )

    blockers: list[str] = []
    promotion_blockers: list[str] = []
    if dependency_quorum_source == "missing":
        blockers.append("runtime_window_import_dependency_quorum_missing")
    elif dependency_quorum_decision != "allow":
        blockers.append("dependency_quorum_not_allow")
    if continuity_source == "missing":
        blockers.append("runtime_window_import_continuity_missing")
    elif continuity_ok != "true":
        blockers.append("evidence_continuity_not_ok")
    if drift_source == "missing":
        promotion_blockers.append("runtime_window_import_drift_missing")
    elif drift_ok != "true":
        promotion_blockers.append("drift_checks_not_ok")

    return {
        "schema_version": "torghut.runtime-window-import-health-gate.v1",
        "source": "live_submission_gate_and_target_plan",
        "dependency_quorum_decision": dependency_quorum_decision,
        "dependency_quorum_source": dependency_quorum_source,
        "continuity_ok": continuity_ok,
        "continuity_source": continuity_source,
        "continuity_reason": continuity_reason,
        "drift_ok": drift_ok,
        "drift_source": drift_source,
        "drift_reason": drift_reason,
        "ready": not blockers,
        "blockers": blockers,
        "promotion_blockers": promotion_blockers,
    }


def _runtime_window_import_health_gate_summary(
    targets: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    blockers: list[str] = []
    promotion_blockers: list[str] = []
    continuity_reasons: list[str] = []
    drift_reasons: list[str] = []
    ready_count = 0
    for target in targets:
        gate = _as_mapping(target.get("runtime_window_import_health_gate"))
        if bool(gate.get("ready")):
            ready_count += 1
        blockers.extend(_unique_text_items(gate.get("blockers")))
        promotion_blockers.extend(_unique_text_items(gate.get("promotion_blockers")))
        continuity_reason = _safe_text(gate.get("continuity_reason"))
        if continuity_reason is not None:
            continuity_reasons.append(continuity_reason)
        drift_reason = _safe_text(gate.get("drift_reason"))
        if drift_reason is not None:
            drift_reasons.append(drift_reason)
    return {
        "schema_version": "torghut.runtime-window-import-health-gate-summary.v1",
        "source": "paper_route_runtime_window_targets",
        "required": True,
        "target_count": len(targets),
        "ready_target_count": ready_count,
        "blocked_target_count": max(0, len(targets) - ready_count),
        "blockers": _unique_text_items(blockers),
        "promotion_blockers": _unique_text_items(promotion_blockers),
        "continuity_reasons": _unique_text_items(continuity_reasons),
        "drift_reasons": _unique_text_items(drift_reasons),
    }


def _execution_source_strategy_key(
    *,
    strategy_id: str | None,
    strategy_lookup_names: Sequence[str],
    strategy_name: str | None,
    runtime_strategy_name: str | None,
) -> str:
    strategy_from_id = _strategy_name_from_strategy_id(strategy_id)
    if strategy_from_id is not None:
        return strategy_from_id
    for item in strategy_lookup_names:
        text = _safe_text(item)
        if text is not None and text != runtime_strategy_name:
            return text
    return _safe_text(strategy_name) or _safe_text(runtime_strategy_name) or ""


def _runtime_window_execution_source_key(
    *,
    strategy_family: str | None,
    strategy_id: str | None,
    strategy_lookup_names: Sequence[str],
    strategy_name: str | None,
    runtime_strategy_name: str | None,
    account_label: str,
    source_manifest_ref: str | None,
    window_start: datetime,
    window_end: datetime,
    probe_symbols: Sequence[str],
) -> tuple[object, ...]:
    return (
        strategy_family or "",
        _execution_source_strategy_key(
            strategy_id=strategy_id,
            strategy_lookup_names=strategy_lookup_names,
            strategy_name=strategy_name,
            runtime_strategy_name=runtime_strategy_name,
        ),
        account_label,
        source_manifest_ref or "",
        _isoformat(window_start),
        _isoformat(window_end),
        tuple(str(symbol).strip().upper() for symbol in probe_symbols),
    )


def _next_paper_route_runtime_window_targets(
    *,
    session: Session,
    targets: Sequence[Mapping[str, Any]],
    probe: Mapping[str, object],
    live_submission_gate: Mapping[str, Any],
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
        settlement_seconds=PAPER_ROUTE_RUNTIME_IMPORT_SETTLEMENT_SECONDS,
    )
    import_ready = bool(session_readiness.get("import_ready"))
    import_blockers = [
        str(item).strip()
        for item in _as_sequence(session_readiness.get("import_blockers"))
        if str(item).strip()
    ]
    import_handoff = {
        "runner": "scripts/renew_latest_empirical_promotion_jobs.py",
        "target_plan_endpoint": "/trading/paper-route-evidence",
        "required_flags": [
            "--runtime-window-import",
            "--runtime-window-target-plan-url",
            "--runtime-window-target-plan-exclusive",
            "--runtime-window-target-plan-required",
            "--runtime-window-target-plan-settlement-seconds",
        ],
        "target_plan_settlement_seconds": PAPER_ROUTE_RUNTIME_IMPORT_SETTLEMENT_SECONDS,
        "settlement_ready_at": session_readiness.get("settlement_ready_at"),
        "source_dsn_env": "SIM_DB_DSN",
        "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
        "observed_stage": "paper",
        "import_ready": import_ready,
        "import_blockers": import_blockers,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "promotion_gate": "runtime_ledger_live_or_live_paper_required",
    }
    planned_targets: list[dict[str, object]] = []
    skipped_targets: list[dict[str, object]] = []
    planned_keys: set[tuple[object, ...]] = set()
    planned_execution_source_keys: dict[tuple[object, ...], dict[str, object]] = {}
    for target in targets:
        hypothesis_id = _safe_text(target.get("hypothesis_id"))
        candidate_id = _safe_text(target.get("candidate_id"))
        strategy_family = _safe_text(target.get("strategy_family"))
        strategy_name = _safe_text(target.get("strategy_name"))
        strategy_id = _safe_text(target.get("strategy_id"))
        runtime_strategy_name = (
            _safe_text(target.get("runtime_strategy_name")) or strategy_name
        )
        strategy_lookup_names = _strategy_lookup_names(
            target.get("strategy_lookup_names"),
            runtime_strategy_name,
            strategy_name,
            _strategy_name_from_strategy_id(strategy_id),
        )
        raw_target_probe_symbols = _target_probe_symbols(target, probe)
        strategy_universe_symbols = _strategy_universe_symbols(
            session,
            strategy_lookup_names=strategy_lookup_names,
        )
        target_probe_symbols = raw_target_probe_symbols
        out_of_strategy_scope_symbols: list[str] = []
        missing_strategy_universe_symbols: list[str] = []
        if strategy_universe_symbols:
            (
                target_probe_symbols,
                out_of_strategy_scope_symbols,
                missing_strategy_universe_symbols,
            ) = _scope_probe_symbols_to_target_plan(
                raw_target_probe_symbols,
                scope_symbols=strategy_universe_symbols,
            )
        target_probe_ready = (
            bool(probe.get("configured_enabled"))
            and _safe_decimal(next_notional) > 0
            and bool(target_probe_symbols)
        )
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
        if missing or not target_probe_ready:
            reasons = list(missing)
            if not target_probe_ready:
                if not bool(probe.get("configured_enabled")):
                    reasons.append("paper_route_probe_disabled")
                if _safe_decimal(next_notional) <= 0:
                    reasons.append("paper_route_probe_notional_missing")
                if not target_probe_symbols:
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
        planned_key = (
            hypothesis_id,
            candidate_id,
            strategy_family,
            strategy_name,
            PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            source_manifest_ref,
            _isoformat(window_start),
            _isoformat(window_end),
            tuple(target_probe_symbols),
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
        execution_source_key = _runtime_window_execution_source_key(
            strategy_family=strategy_family,
            strategy_id=strategy_id,
            strategy_lookup_names=strategy_lookup_names,
            strategy_name=strategy_name,
            runtime_strategy_name=runtime_strategy_name,
            account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            source_manifest_ref=source_manifest_ref,
            window_start=window_start,
            window_end=window_end,
            probe_symbols=target_probe_symbols,
        )
        existing_execution_source = planned_execution_source_keys.get(
            execution_source_key
        )
        if existing_execution_source is not None:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "reason": (
                        "duplicate_next_paper_route_runtime_window_execution_source"
                    ),
                    "duplicate_of_hypothesis_id": existing_execution_source.get(
                        "hypothesis_id"
                    ),
                    "duplicate_of_candidate_id": existing_execution_source.get(
                        "candidate_id"
                    ),
                    "missing_or_blocking_fields": [
                        "duplicate_next_paper_route_runtime_window_execution_source"
                    ],
                }
            )
            continue
        source_account_label = _safe_text(target.get("account_label"))
        health_gate = _runtime_window_import_health_gate(
            target=target,
            live_submission_gate=live_submission_gate,
        )
        health_gate_blockers = _unique_text_items(health_gate.get("blockers"))
        health_gate_promotion_blockers = _unique_text_items(
            health_gate.get("promotion_blockers")
        )
        paper_route_target_plan_source = _safe_text(
            target.get("paper_route_target_plan_source")
        )
        paper_route_probe_scope_authority = _safe_text(
            target.get("paper_route_probe_scope_authority")
        )
        if strategy_universe_symbols:
            paper_route_probe_scope_authority = "strategy_universe"
        planned_target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "strategy_id": strategy_id or "",
            "runtime_strategy_name": runtime_strategy_name or "",
            "strategy_lookup_names": strategy_lookup_names,
            "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            "source_account_label": source_account_label or "",
            "source_dsn_env": "SIM_DB_DSN",
            "dataset_snapshot_ref": _safe_text(target.get("dataset_snapshot_ref"))
            or "",
            "source_manifest_ref": source_manifest_ref,
            "source_kind": "paper_route_probe_runtime_observed",
            "dependency_quorum_decision": health_gate["dependency_quorum_decision"],
            "continuity_ok": health_gate["continuity_ok"],
            "continuity_reason": health_gate["continuity_reason"],
            "drift_ok": health_gate["drift_ok"],
            "drift_reason": health_gate["drift_reason"],
            "runtime_window_import_health_gate": health_gate,
            "runtime_window_import_health_gate_blockers": health_gate_blockers,
            "runtime_window_import_promotion_blockers": (
                health_gate_promotion_blockers
            ),
            "window_start": _isoformat(window_start),
            "window_end": _isoformat(window_end),
            "paper_route_probe_symbols": target_probe_symbols,
            "paper_route_probe_symbol_count": len(target_probe_symbols),
            "paper_route_probe_raw_target_symbols": raw_target_probe_symbols,
            "paper_route_probe_strategy_scope_applied": bool(strategy_universe_symbols),
            "paper_route_probe_strategy_universe_symbols": (strategy_universe_symbols),
            "paper_route_probe_out_of_strategy_scope_symbols": (
                out_of_strategy_scope_symbols
            ),
            "paper_route_probe_missing_strategy_universe_symbols": (
                missing_strategy_universe_symbols
            ),
            "paper_route_probe_next_session_max_notional": next_notional,
            "paper_route_probe_window_start": _isoformat(window_start),
            "paper_route_probe_window_end": _isoformat(window_end),
            "paper_route_target_plan_source": paper_route_target_plan_source or "",
            "paper_route_probe_scope_authority": paper_route_probe_scope_authority
            or "",
            "paper_route_execution_source_key": {
                "strategy_family": strategy_family or "",
                "strategy": execution_source_key[1],
                "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                "source_manifest_ref": source_manifest_ref,
                "window_start": _isoformat(window_start),
                "window_end": _isoformat(window_end),
                "paper_route_probe_symbols": target_probe_symbols,
            },
            "paper_route_session_readiness_state": _safe_text(
                session_readiness.get("state")
            )
            or "unknown",
            "paper_route_session_import_ready": import_ready,
            "paper_route_session_import_blockers": import_blockers,
            "paper_route_runtime_window_import_not_before": _safe_text(
                session_readiness.get("settlement_ready_at")
            )
            or _isoformat(window_end),
            "paper_route_runtime_import_handoff": import_handoff,
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
            "candidate_blockers": _unique_text_items(
                [
                    "paper_route_runtime_ledger_import_pending",
                    *_unique_text_items(target.get("candidate_blockers")),
                    *health_gate_blockers,
                    *health_gate_promotion_blockers,
                ]
            ),
            "runtime_ledger_target_metadata_blockers": _unique_text_items(
                [
                    "paper_route_runtime_ledger_import_pending",
                    "live_runtime_ledger_required",
                    *health_gate_blockers,
                    *health_gate_promotion_blockers,
                ]
            ),
            "handoff": "next_paper_route_runtime_window_import",
            "promotion_gate": "runtime_ledger_live_or_live_paper_required",
            "max_notional": "0",
        }
        planned_keys.add(planned_key)
        planned_execution_source_keys[execution_source_key] = planned_target
        planned_targets.append(planned_target)
    health_gate_summary = _runtime_window_import_health_gate_summary(planned_targets)
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
        "runtime_window_import_handoff": {
            **import_handoff,
            "target_count": len(planned_targets),
            "skipped_target_count": len(skipped_targets),
            "window_start": _isoformat(window_start),
            "window_end": _isoformat(window_end),
            "runtime_window_import_health_gate": health_gate_summary,
        },
        "runtime_window_import_health_gate": health_gate_summary,
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
            "target_plan_source": _safe_text(probe.get("target_plan_source")),
            "target_plan_scope_applied": bool(probe.get("target_plan_scope_applied")),
            "target_plan_scope_symbols": [
                str(item).strip()
                for item in _as_sequence(probe.get("target_plan_scope_symbols"))
                if str(item).strip()
            ],
            "raw_symbols": [
                str(item).strip()
                for item in _as_sequence(probe.get("raw_eligible_symbols"))
                if str(item).strip()
            ],
            "out_of_scope_symbols": [
                str(item).strip()
                for item in _as_sequence(probe.get("out_of_scope_symbols"))
                if str(item).strip()
            ],
            "missing_scope_symbols": [
                str(item).strip()
                for item in _as_sequence(probe.get("missing_scope_symbols"))
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
    strategy_lookup_names: Sequence[str] | None = None,
    account_label: str | None,
    symbols: Sequence[str],
    window_start: datetime,
    window_end: datetime,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
    require_source_lineage: bool = False,
) -> dict[str, object]:
    symbol_filters = [
        str(item).strip().upper() for item in symbols if str(item).strip()
    ]
    strategy_filters = _strategy_lookup_names(strategy_name, strategy_lookup_names)
    if not strategy_filters:
        return {
            "strategy_name": None,
            "strategy_lookup_names": [],
            "account_label": account_label,
            "symbols": symbol_filters,
            "lineage_required": require_source_lineage,
            "expected_candidate_id": candidate_id,
            "expected_hypothesis_id": hypothesis_id,
            "raw_decision_count": 0,
            "lineage_matched_decision_count": 0,
            "lineage_blockers": [],
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
        .where(Strategy.name.in_(strategy_filters))
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
    raw_decision_count = len(decision_rows)
    lineage_blockers = (
        _source_lineage_blockers(
            decision_rows,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
        )
        if require_source_lineage
        else []
    )
    if require_source_lineage:
        decision_rows = [
            row
            for row in decision_rows
            if _source_decision_lineage_matches(
                row,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
        ]
    decision_ids = [row.id for row in decision_rows]
    execution_rows: list[Execution] = []
    if decision_ids:
        execution_activity_ts = _execution_activity_timestamp()
        execution_stmt = (
            select(Execution)
            .where(Execution.trade_decision_id.in_(decision_ids))
            .where(execution_activity_ts >= window_start)
            .where(execution_activity_ts < window_end)
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
                execution_stmt.order_by(execution_activity_ts.desc()).limit(500)
            ).scalars()
        )
    tca_rows: list[ExecutionTCAMetric] = []
    if decision_ids:
        tca_stmt = (
            select(ExecutionTCAMetric)
            .join(Strategy, ExecutionTCAMetric.strategy_id == Strategy.id)
            .where(Strategy.name.in_(strategy_filters))
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
    missing_reasons.extend(lineage_blockers)
    return {
        "strategy_name": strategy_name,
        "strategy_lookup_names": strategy_filters,
        "account_label": account_label,
        "symbols": symbol_filters,
        "lineage_required": require_source_lineage,
        "expected_candidate_id": candidate_id,
        "expected_hypothesis_id": hypothesis_id,
        "raw_decision_count": raw_decision_count,
        "lineage_matched_decision_count": decision_count,
        "lineage_blockers": lineage_blockers,
        "decision_count": decision_count,
        "execution_count": execution_count,
        "filled_execution_count": filled_execution_count,
        "tca_sample_count": tca_sample_count,
        "last_decision_at": _isoformat(
            decision_rows[0].created_at if decision_rows else None
        ),
        "last_execution_at": _isoformat(
            _execution_activity_at(execution_rows[0]) if execution_rows else None
        ),
        "last_tca_at": _isoformat(tca_rows[0].computed_at if tca_rows else None),
        "missing": bool(missing_reasons),
        "missing_reasons": missing_reasons,
    }


def _rejected_signal_activity(
    session: Session,
    *,
    account_label: str | None,
    symbols: Sequence[str],
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    symbol_filters = [
        str(item).strip().upper() for item in symbols if str(item).strip()
    ]
    stmt = (
        select(RejectedSignalOutcomeEvent)
        .where(RejectedSignalOutcomeEvent.event_ts >= window_start)
        .where(RejectedSignalOutcomeEvent.event_ts <= window_end)
    )
    if account_label:
        stmt = stmt.where(RejectedSignalOutcomeEvent.account_label == account_label)
    if symbol_filters:
        stmt = stmt.where(
            func.upper(RejectedSignalOutcomeEvent.symbol).in_(symbol_filters)
        )
    rows = list(
        session.execute(
            stmt.order_by(
                RejectedSignalOutcomeEvent.event_ts.desc(),
                RejectedSignalOutcomeEvent.created_at.desc(),
            ).limit(500)
        ).scalars()
    )
    reason_counts: dict[str, int] = {}
    symbol_reason_counts: dict[tuple[str, str], int] = {}
    max_spread_bps: Decimal | None = None
    for row in rows:
        reason = str(row.reject_reason or "unknown").strip() or "unknown"
        symbol = str(row.symbol or "").strip().upper()
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
        symbol_reason_counts[(symbol, reason)] = (
            symbol_reason_counts.get((symbol, reason), 0) + 1
        )
        spread = _safe_decimal(row.spread_bps)
        if spread > 0 and (max_spread_bps is None or spread > max_spread_bps):
            max_spread_bps = spread
    blocking_reasons: list[str] = []
    if rows:
        blocking_reasons.append("source_signal_rejected_by_quote_quality")
        blocking_reasons.extend(
            f"source_reject_{reason}" for reason in sorted(reason_counts) if reason
        )
    latest_events = [
        {
            "event_id": row.event_id,
            "symbol": str(row.symbol or "").strip().upper(),
            "event_ts": _isoformat(row.event_ts),
            "timeframe": row.timeframe,
            "reject_reason": row.reject_reason,
            "spread_bps": _optional_decimal_text(row.spread_bps),
            "jump_bps": _optional_decimal_text(row.jump_bps),
            "outcome_label_status": row.outcome_label_status,
            "counterfactual_required": bool(row.counterfactual_required),
        }
        for row in rows[:10]
    ]
    return {
        "account_label": account_label,
        "symbols": symbol_filters,
        "event_count": len(rows),
        "reason_counts": [
            {"reason": reason, "count": count}
            for reason, count in sorted(reason_counts.items())
        ],
        "symbol_reason_counts": [
            {"symbol": symbol, "reason": reason, "count": count}
            for (symbol, reason), count in sorted(symbol_reason_counts.items())
        ],
        "latest_events": latest_events,
        "last_rejected_at": _isoformat(rows[0].event_ts if rows else None),
        "max_spread_bps": _optional_decimal_text(max_spread_bps),
        "blocking_reasons": blocking_reasons,
        "missing": not bool(rows),
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
        and not cost_basis_counts_have_non_promotion_grade_costs(
            _as_mapping(row.payload_json).get("cost_basis_counts")
        )
        and not blockers
    )


def _runtime_ledger_summary(
    session: Session,
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
    observed_stage: str | None,
    account_label: str | None,
    strategy_name: str | None,
    strategy_lookup_names: Sequence[str] | None = None,
    strategy_family: str | None,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    strategy_filters = _strategy_lookup_names(strategy_name, strategy_lookup_names)
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
    if observed_stage:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.observed_stage == observed_stage)
    if account_label:
        stmt = stmt.where(StrategyRuntimeLedgerBucket.account_label == account_label)
    if strategy_filters:
        stmt = stmt.where(
            StrategyRuntimeLedgerBucket.runtime_strategy_name.in_(strategy_filters)
        )
    if strategy_family:
        stmt = stmt.where(
            StrategyRuntimeLedgerBucket.strategy_family == strategy_family
        )
    queried_rows = list(
        session.execute(stmt.limit(RUNTIME_LEDGER_SUMMARY_ROW_LIMIT + 1)).scalars()
    )
    truncated = len(queried_rows) > RUNTIME_LEDGER_SUMMARY_ROW_LIMIT
    rows = queried_rows[:RUNTIME_LEDGER_SUMMARY_ROW_LIMIT]
    evidence_grade_rows = [
        row for row in rows if _runtime_ledger_bucket_evidence_grade(row)
    ]
    filled_notional = sum(
        (row.filled_notional for row in evidence_grade_rows), Decimal("0")
    )
    net_pnl = sum(
        (row.net_strategy_pnl_after_costs for row in evidence_grade_rows),
        Decimal("0"),
    )
    return {
        "bucket_count": len(rows),
        "evidence_grade_bucket_count": len(evidence_grade_rows),
        "non_evidence_grade_bucket_count": len(rows) - len(evidence_grade_rows),
        "returned_bucket_count": len(rows),
        "query_limit": RUNTIME_LEDGER_SUMMARY_ROW_LIMIT,
        "truncated": truncated,
        "proof_scope": "evidence_grade_runtime_ledger_buckets_only",
        "fill_count": sum(
            max(0, _safe_int(row.fill_count)) for row in evidence_grade_rows
        ),
        "decision_count": sum(
            max(0, _safe_int(row.decision_count)) for row in evidence_grade_rows
        ),
        "submitted_order_count": sum(
            max(0, _safe_int(row.submitted_order_count)) for row in evidence_grade_rows
        ),
        "closed_trade_count": sum(
            max(0, _safe_int(row.closed_trade_count)) for row in evidence_grade_rows
        ),
        "open_position_count": sum(
            max(0, _safe_int(row.open_position_count)) for row in evidence_grade_rows
        ),
        "filled_notional": _decimal_text(filled_notional),
        "net_strategy_pnl_after_costs": _decimal_text(net_pnl),
        "post_cost_expectancy_bps": _decimal_text(
            (net_pnl / filled_notional * Decimal("10000"))
            if filled_notional > 0
            else Decimal("0")
        ),
        "filters": {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": observed_stage,
            "account_label": account_label,
            "strategy_name": strategy_name,
            "strategy_lookup_names": strategy_filters,
            "strategy_family": strategy_family,
        },
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


def _source_runtime_ledger_materialization_blockers(
    audits: Sequence[Mapping[str, object]],
) -> list[str]:
    blockers: set[str] = set()
    for audit in audits:
        source_activity = _as_mapping(audit.get("source_activity"))
        runtime_ledger = _as_mapping(audit.get("runtime_ledger"))
        if bool(source_activity.get("missing")):
            continue
        if _safe_int(runtime_ledger.get("bucket_count")) > 0:
            continue
        blockers.add("source_activity_present_runtime_ledger_not_materialized")
        blockers.add("runtime_ledger_source_bucket_missing")
        if _safe_int(source_activity.get("decision_count")) <= 0:
            blockers.add("source_decisions_missing")
        if _safe_int(source_activity.get("execution_count")) <= 0:
            blockers.add("source_executions_missing")
        if _safe_int(source_activity.get("filled_execution_count")) <= 0:
            blockers.add("source_filled_executions_missing")
        if _safe_int(source_activity.get("tca_sample_count")) <= 0:
            blockers.add("source_tca_missing")
        blockers.update(
            str(item).strip()
            for item in _as_sequence(source_activity.get("lineage_blockers"))
            if str(item).strip()
        )
    return sorted(blockers)


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
    rejected_signal_activity: Mapping[str, object],
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
    if bool(source_activity.get("missing")):
        blockers.update(
            str(item).strip()
            for item in _as_sequence(rejected_signal_activity.get("blocking_reasons"))
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
    target = _target_identity(raw_target, probe=probe)
    window_start, window_end = _target_window(
        target,
        generated_at=generated_at,
        lookback_hours=lookback_hours,
    )
    hypothesis_id = cast(str | None, target.get("hypothesis_id"))
    candidate_id = cast(str | None, target.get("candidate_id"))
    strategy_lookup_names = [
        str(item)
        for item in _as_sequence(target.get("strategy_lookup_names"))
        if str(item).strip()
    ]
    source_activity = _strategy_source_activity(
        session,
        strategy_name=cast(str | None, target.get("strategy_name")),
        strategy_lookup_names=strategy_lookup_names,
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_start=window_start,
        window_end=window_end,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        require_source_lineage=_target_requires_source_lineage(target),
    )
    rejected_signal_activity = _rejected_signal_activity(
        session,
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_start=window_start,
        window_end=window_end,
    )
    runtime_ledger = _runtime_ledger_summary(
        session,
        hypothesis_id=hypothesis_id,
        candidate_id=candidate_id,
        observed_stage=cast(str | None, target.get("observed_stage")),
        account_label=cast(str | None, target.get("account_label")),
        strategy_name=cast(str | None, target.get("strategy_name")),
        strategy_lookup_names=strategy_lookup_names,
        strategy_family=cast(str | None, target.get("strategy_family")),
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
        rejected_signal_activity=rejected_signal_activity,
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
        "rejected_signal_activity": rejected_signal_activity,
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


def _runtime_window_import_audit(
    *,
    next_targets: Mapping[str, object],
    target_audits: Sequence[Mapping[str, object]],
    next_target_audits: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    session_readiness = _as_mapping(next_targets.get("session_readiness"))
    import_blockers = _unique_text_items(session_readiness.get("import_blockers"))
    source_missing_reasons = sorted(
        {
            str(reason).strip()
            for audit in next_target_audits
            for reason in (
                *_as_sequence(
                    _as_mapping(audit.get("source_activity")).get("missing_reasons")
                ),
                *_as_sequence(
                    _as_mapping(audit.get("rejected_signal_activity")).get(
                        "blocking_reasons"
                    )
                ),
            )
            if str(reason).strip()
        }
    )
    runtime_ledger_blockers = sorted(
        {
            str(blocker).strip()
            for audit in next_target_audits
            for blocker in _as_sequence(
                _as_mapping(audit.get("runtime_ledger")).get("blockers")
            )
            if str(blocker).strip()
        }
    )
    source_runtime_ledger_blockers = _source_runtime_ledger_materialization_blockers(
        next_target_audits
    )
    source_plan_target_count = len(target_audits)
    current_target_count = len(next_target_audits)
    raw_source_counts = _runtime_window_target_counts(target_audits)
    selected_target_counts = _runtime_window_target_counts(next_target_audits)
    targets_with_source_activity = selected_target_counts["source_activity"]
    targets_with_rejected_signal_activity = selected_target_counts[
        "rejected_signal_activity"
    ]
    targets_with_runtime_ledger = selected_target_counts["runtime_ledger"]
    targets_with_evidence_grade_runtime_ledger = selected_target_counts[
        "evidence_grade_runtime_ledger"
    ]
    targets_with_promotion_decision = selected_target_counts["promotion_decision"]
    import_ready = bool(session_readiness.get("import_ready"))
    session_state = _safe_text(session_readiness.get("state")) or "unknown"
    blockers: list[str]
    if source_plan_target_count <= 0:
        state = "paper_probation_import_plan_missing"
        next_action = "repair_runtime_ledger_paper_probation_import_plan"
        blockers = ["paper_probation_import_plan_missing"]
    elif not import_ready:
        state = session_state
        next_action = {
            "waiting_for_session_open": "wait_for_regular_session_open",
            "collecting_session_evidence": "collect_paper_route_activity_until_close",
            "window_closed_settlement_pending": "wait_for_settlement_before_import",
            "window_closed_import_blocked": "repair_paper_route_probe_before_import",
        }.get(session_state, "wait_for_runtime_window_import_readiness")
        blockers = import_blockers
    elif current_target_count <= 0:
        state = "next_runtime_window_target_missing"
        next_action = "repair_next_paper_route_runtime_window_target_plan"
        blockers = ["next_runtime_window_target_missing"]
    elif targets_with_source_activity < current_target_count:
        state = "import_due_source_activity_missing"
        next_action = "inspect_paper_route_source_activity_before_import"
        blockers = ["paper_route_source_activity_missing", *source_missing_reasons]
    elif targets_with_runtime_ledger < current_target_count:
        state = "import_due_runtime_ledger_missing"
        next_action = "run_runtime_window_import_or_repair_source_materialization"
        blockers = [
            "runtime_ledger_bucket_missing",
            *source_runtime_ledger_blockers,
        ]
    elif targets_with_evidence_grade_runtime_ledger < current_target_count:
        state = "runtime_ledger_imported_but_not_evidence_grade"
        next_action = "repair_runtime_ledger_bucket_authority_or_candidate"
        blockers = [
            "runtime_ledger_evidence_grade_bucket_missing",
            *runtime_ledger_blockers,
        ]
    else:
        state = "runtime_ledger_ready_for_gate_review"
        next_action = "review_runtime_ledger_profit_gates"
        blockers = []
    target_blockers = _runtime_window_target_blockers(next_target_audits)
    return {
        "schema_version": PAPER_ROUTE_RUNTIME_WINDOW_IMPORT_AUDIT_SCHEMA_VERSION,
        "state": state,
        "next_action": next_action,
        "session_state": session_state,
        "session_window": _as_mapping(next_targets.get("session_window")),
        "settlement_ready_at": session_readiness.get("settlement_ready_at"),
        "import_ready": import_ready,
        "blockers": sorted(dict.fromkeys(blockers)),
        "diagnostics": {
            "source_activity_missing_reasons": source_missing_reasons,
            "source_activity_to_runtime_ledger_blockers": (
                source_runtime_ledger_blockers
            ),
            "runtime_ledger_blockers": runtime_ledger_blockers,
            "target_blockers_effective_when": "runtime_window_import_ready",
        },
        "target_blockers": target_blockers,
        "counts": {
            "source_plan_target_count": source_plan_target_count,
            "selected_target_count": current_target_count,
            "next_runtime_window_target_count": _safe_int(
                next_targets.get("target_count")
            ),
            "targets_with_source_activity": targets_with_source_activity,
            "targets_with_rejected_signal_activity": (
                targets_with_rejected_signal_activity
            ),
            "targets_with_runtime_ledger": targets_with_runtime_ledger,
            "targets_with_evidence_grade_runtime_ledger": (
                targets_with_evidence_grade_runtime_ledger
            ),
            "targets_with_promotion_decision": targets_with_promotion_decision,
            "raw_source_plan_targets_with_source_activity": raw_source_counts[
                "source_activity"
            ],
            "raw_source_plan_targets_with_rejected_signal_activity": raw_source_counts[
                "rejected_signal_activity"
            ],
            "raw_source_plan_targets_with_runtime_ledger": raw_source_counts[
                "runtime_ledger"
            ],
            "raw_source_plan_targets_with_evidence_grade_runtime_ledger": (
                raw_source_counts["evidence_grade_runtime_ledger"]
            ),
            "raw_source_plan_targets_with_promotion_decision": raw_source_counts[
                "promotion_decision"
            ],
        },
        "promotion_authority": {
            "allowed": False,
            "reason": "runtime_window_import_audit_observability_only",
            "requires": [
                "runtime_ledger_live_or_live_paper_required",
                "post_cost_pnl_basis_required",
                "filled_notional_required",
                "closed_round_trips_required",
                "lineage_hashes_required",
            ],
        },
    }


def _runtime_window_target_blockers(
    target_audits: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    target_blockers: list[dict[str, object]] = []
    for audit in target_audits:
        target = _as_mapping(audit.get("target"))
        source_activity = _as_mapping(audit.get("source_activity"))
        rejected_signal_activity = _as_mapping(audit.get("rejected_signal_activity"))
        runtime_ledger = _as_mapping(audit.get("runtime_ledger"))
        promotion_decisions = _as_mapping(audit.get("promotion_decisions"))

        blockers = _unique_text_items(
            [
                *(
                    _unique_text_items(source_activity.get("missing_reasons"))
                    if bool(source_activity.get("missing"))
                    else []
                ),
                *_unique_text_items(rejected_signal_activity.get("blocking_reasons")),
                *(
                    ["runtime_ledger_bucket_missing"]
                    if _safe_int(runtime_ledger.get("bucket_count")) <= 0
                    else []
                ),
                *(
                    ["runtime_ledger_evidence_grade_bucket_missing"]
                    if _safe_int(runtime_ledger.get("evidence_grade_bucket_count")) <= 0
                    else []
                ),
                *_unique_text_items(runtime_ledger.get("blockers")),
                *(
                    ["promotion_decision_missing"]
                    if _safe_int(promotion_decisions.get("decision_count")) <= 0
                    else []
                ),
            ]
        )
        if not blockers:
            continue
        target_blockers.append(
            {
                "hypothesis_id": _safe_text(target.get("hypothesis_id")),
                "candidate_id": _safe_text(target.get("candidate_id")),
                "strategy_name": _safe_text(target.get("strategy_name")),
                "runtime_strategy_name": _safe_text(
                    target.get("runtime_strategy_name")
                ),
                "account_label": _safe_text(target.get("account_label")),
                "source_kind": _safe_text(target.get("source_kind")),
                "window_start": _safe_text(target.get("window_start")),
                "window_end": _safe_text(target.get("window_end")),
                "paper_route_probe_symbols": [
                    str(item).strip()
                    for item in _as_sequence(target.get("paper_route_probe_symbols"))
                    if str(item).strip()
                ],
                "source_activity": {
                    "decision_count": _safe_int(source_activity.get("decision_count")),
                    "execution_count": _safe_int(
                        source_activity.get("execution_count")
                    ),
                    "filled_execution_count": _safe_int(
                        source_activity.get("filled_execution_count")
                    ),
                    "tca_sample_count": _safe_int(
                        source_activity.get("tca_sample_count")
                    ),
                    "last_decision_at": _safe_text(
                        source_activity.get("last_decision_at")
                    ),
                    "last_execution_at": _safe_text(
                        source_activity.get("last_execution_at")
                    ),
                    "last_tca_at": _safe_text(source_activity.get("last_tca_at")),
                },
                "runtime_ledger": {
                    "bucket_count": _safe_int(runtime_ledger.get("bucket_count")),
                    "evidence_grade_bucket_count": _safe_int(
                        runtime_ledger.get("evidence_grade_bucket_count")
                    ),
                    "filled_notional": _safe_text(
                        runtime_ledger.get("filled_notional")
                    ),
                    "closed_trade_count": _safe_int(
                        runtime_ledger.get("closed_trade_count")
                    ),
                    "net_strategy_pnl_after_costs": _safe_text(
                        runtime_ledger.get("net_strategy_pnl_after_costs")
                    ),
                },
                "promotion_decision_count": _safe_int(
                    promotion_decisions.get("decision_count")
                ),
                "blockers": blockers,
            }
        )
    return target_blockers


def _runtime_window_target_counts(
    target_audits: Sequence[Mapping[str, object]],
) -> dict[str, int]:
    targets_with_source_activity = sum(
        int(not bool(_as_mapping(audit.get("source_activity")).get("missing")))
        for audit in target_audits
    )
    targets_with_runtime_ledger = sum(
        int(_safe_int(_as_mapping(audit.get("runtime_ledger")).get("bucket_count")) > 0)
        for audit in target_audits
    )
    targets_with_rejected_signal_activity = sum(
        int(
            _safe_int(
                _as_mapping(audit.get("rejected_signal_activity")).get("event_count")
            )
            > 0
        )
        for audit in target_audits
    )
    targets_with_evidence_grade_runtime_ledger = sum(
        int(
            _safe_int(
                _as_mapping(audit.get("runtime_ledger")).get(
                    "evidence_grade_bucket_count"
                )
            )
            > 0
        )
        for audit in target_audits
    )
    targets_with_promotion_decision = sum(
        int(
            _safe_int(
                _as_mapping(audit.get("promotion_decisions")).get("decision_count")
            )
            > 0
        )
        for audit in target_audits
    )
    return {
        "source_activity": targets_with_source_activity,
        "rejected_signal_activity": targets_with_rejected_signal_activity,
        "runtime_ledger": targets_with_runtime_ledger,
        "evidence_grade_runtime_ledger": targets_with_evidence_grade_runtime_ledger,
        "promotion_decision": targets_with_promotion_decision,
    }


def _runtime_ledger_proof_packet_handoff(
    *,
    next_targets: Mapping[str, object],
    runtime_window_import_audit: Mapping[str, object],
) -> dict[str, object]:
    runtime_import_handoff = _as_mapping(
        next_targets.get("runtime_window_import_handoff")
    )
    session_readiness = _as_mapping(next_targets.get("session_readiness"))
    import_ready = bool(
        session_readiness.get("import_ready")
        or runtime_import_handoff.get("import_ready")
        or runtime_window_import_audit.get("import_ready")
    )
    import_blockers = _unique_text_items(session_readiness.get("import_blockers")) + [
        blocker
        for blocker in _unique_text_items(runtime_import_handoff.get("import_blockers"))
        if blocker not in _unique_text_items(session_readiness.get("import_blockers"))
    ]
    base_args = [
        "uv",
        "run",
        "--frozen",
        "python",
        "scripts/assemble_runtime_ledger_proof_packet.py",
        "--status-service-base-url",
        "$TORGHUT_LIVE_SERVICE_BASE_URL",
        "--paper-route-service-base-url",
        "$TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL",
        "--completion-service-base-url",
        "$TORGHUT_LIVE_SERVICE_BASE_URL",
        "--min-runtime-ledger-net-pnl",
        MIN_RUNTIME_LEDGER_PROOF_NET_PNL,
        "--min-runtime-ledger-daily-net-pnl",
        MIN_RUNTIME_LEDGER_PROOF_DAILY_NET_PNL,
        "--min-runtime-ledger-trading-days",
        str(MIN_RUNTIME_LEDGER_PROOF_TRADING_DAYS),
        "--output-file",
        RUNTIME_LEDGER_PROOF_PACKET_OUTPUT_FILE,
    ]
    authority_args = [
        *base_args[:-2],
        "--runtime-window-import-file",
        RUNTIME_WINDOW_IMPORT_OUTPUT_FILE,
        "--output-file",
        RUNTIME_LEDGER_PROOF_PACKET_OUTPUT_FILE,
        "--artifact-prefix",
        RUNTIME_LEDGER_PROOF_PACKET_ARTIFACT_PREFIX,
        "--require-artifact-upload",
    ]
    return {
        "schema_version": RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION,
        "source": "paper_route_evidence_audit",
        "purpose": "assemble_runtime_ledger_live_paper_proof_packet",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "promotion_gate": "runtime_ledger_live_or_live_paper_required",
        "service_base_url_env": "TORGHUT_LIVE_SERVICE_BASE_URL",
        "paper_route_service_base_url_env": "TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL",
        "default_service_base_url": DEFAULT_TORGHUT_LIVE_SERVICE_BASE_URL,
        "default_live_service_base_url": DEFAULT_TORGHUT_LIVE_SERVICE_BASE_URL,
        "default_paper_route_service_base_url": (
            DEFAULT_TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL
        ),
        "source_service_authority": {
            "status": "live_torghut_service",
            "paper_route_evidence": "torghut_sim_service",
            "completion_doc29": "live_torghut_service",
        },
        "source_endpoints": {
            "status": "/trading/status",
            "paper_route_evidence": "/trading/paper-route-evidence",
            "completion_doc29": "/trading/completion/doc29",
        },
        "targets": {
            "min_runtime_ledger_net_pnl_after_costs": (
                MIN_RUNTIME_LEDGER_PROOF_NET_PNL
            ),
            "min_runtime_ledger_daily_net_pnl_after_costs": (
                MIN_RUNTIME_LEDGER_PROOF_DAILY_NET_PNL
            ),
            "min_runtime_ledger_trading_days": MIN_RUNTIME_LEDGER_PROOF_TRADING_DAYS,
        },
        "runtime_window": {
            "import_ready": import_ready,
            "import_blockers": sorted(dict.fromkeys(import_blockers)),
            "health_gate": _as_mapping(
                next_targets.get("runtime_window_import_health_gate")
            ),
            "session_window": _as_mapping(next_targets.get("session_window")),
            "settlement_ready_at": session_readiness.get("settlement_ready_at"),
            "target_count": _safe_int(next_targets.get("target_count")),
            "import_audit_state": _safe_text(runtime_window_import_audit.get("state"))
            or "unknown",
            "import_audit_next_action": _safe_text(
                runtime_window_import_audit.get("next_action")
            )
            or "inspect_packet_checks_and_repair_failed_proof_dimension",
        },
        "required_inputs": {
            "status": {
                "endpoint": "/trading/status",
                "required": True,
            },
            "paper_route_evidence": {
                "endpoint": "/trading/paper-route-evidence",
                "required": True,
            },
            "runtime_window_import": {
                "output_file": RUNTIME_WINDOW_IMPORT_OUTPUT_FILE,
                "required_when": "runtime_window.import_ready",
                "producer": "scripts/renew_latest_empirical_promotion_jobs.py",
            },
            "completion_doc29": {
                "endpoint": "/trading/completion/doc29",
                "required_when": "runtime_window.import_ready",
            },
            "durable_artifact_upload": {
                "artifact_prefix": RUNTIME_LEDGER_PROOF_PACKET_ARTIFACT_PREFIX,
                "artifact_name": "runtime-ledger-proof-packet.json",
                "bucket_env": "TORGHUT_EMPIRICAL_CEPH_BUCKET",
                "required_when": "runtime_window_import file is provided",
            },
        },
        "commands": {
            "waiting_packet": {
                "argv": base_args,
                "expected_verdict": "waiting_for_runtime_window",
            },
            "authority_packet_after_import": {
                "argv": authority_args,
                "expected_verdict": "promotion_authority_allowed",
                "allowed_only_if_packet_ok": True,
                "requires_durable_artifact_upload": True,
            },
        },
        "runtime_window_import_handoff": runtime_import_handoff,
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
    probe = _paper_route_probe_summary(
        route_reacquisition_book,
        target_plan=plan,
        target_plan_source=_safe_text(
            live_submission_gate.get("paper_route_target_plan_source")
        )
        or _target_plan_source(plan),
        target_plan_error=_safe_text(
            live_submission_gate.get("paper_route_target_plan_error")
        ),
    )
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
    next_targets = _next_paper_route_runtime_window_targets(
        session=session,
        targets=targets,
        probe=probe,
        live_submission_gate=live_submission_gate,
        generated_at=resolved_generated_at,
    )
    next_target_audits = [
        _target_audit(
            session,
            raw_target=target,
            probe=probe,
            generated_at=resolved_generated_at,
            lookback_hours=lookback_hours,
        )
        for target in _as_mapping_items(next_targets.get("targets"))
    ]
    runtime_window_import_audit = _runtime_window_import_audit(
        next_targets=next_targets,
        target_audits=target_audits,
        next_target_audits=next_target_audits,
    )
    proof_packet_handoff = _runtime_ledger_proof_packet_handoff(
        next_targets=next_targets,
        runtime_window_import_audit=runtime_window_import_audit,
    )
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
            "paper_route_target_plan_source": _safe_text(
                live_submission_gate.get("paper_route_target_plan_source")
            ),
            "paper_route_target_plan_error": _safe_text(
                live_submission_gate.get("paper_route_target_plan_error")
            ),
        },
        "paper_route_probe": probe,
        "next_paper_route_runtime_window_targets": next_targets,
        "next_runtime_window_target_audits": next_target_audits,
        "runtime_window_import_audit": runtime_window_import_audit,
        "runtime_ledger_proof_packet_handoff": proof_packet_handoff,
        "summary": {
            "target_count": len(targets),
            "target_with_source_activity_count": sum(
                int(not bool(_as_mapping(audit.get("source_activity")).get("missing")))
                for audit in target_audits
            ),
            "target_with_rejected_signal_activity_count": sum(
                int(
                    _safe_int(
                        _as_mapping(audit.get("rejected_signal_activity")).get(
                            "event_count"
                        )
                    )
                    > 0
                )
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
            "target_with_evidence_grade_runtime_ledger_count": sum(
                int(
                    _safe_int(
                        _as_mapping(audit.get("runtime_ledger")).get(
                            "evidence_grade_bucket_count"
                        )
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
            "runtime_window_import_audit_state": runtime_window_import_audit["state"],
            "blockers": summary_blockers,
        },
        "targets": target_audits,
    }


__all__ = [
    "DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION",
    "PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION",
    "PAPER_ROUTE_RUNTIME_WINDOW_IMPORT_AUDIT_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION",
    "build_paper_route_evidence_audit",
]
