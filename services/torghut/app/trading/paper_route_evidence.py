"""Paper-route evidence audit helpers.

This module keeps paper-probation observability separate from promotion
authority. It explains why a target is still evidence collection only instead
of mutating any live submission gate.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from .runtime_cost_authority import cost_basis_counts_have_non_promotion_grade_costs
from .runtime_decision_authority import (
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
    source_decision_mode_is_profit_proof_eligible,
)
from .runtime_ledger import POST_COST_PNL_BASIS
from .runtime_ledger_proof_policy import runtime_ledger_proof_policy_from_env
from .runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers,
)
from .runtime_strategy_resolution import (
    derived_strategy_name_from_strategy_id,
    explicit_runtime_strategy_name_or_family_harness,
    runtime_strategy_name_from_strategy_id,
    strategy_names_from_strategy_id,
)
from .session_context import is_regular_equities_session_date


logger = logging.getLogger(__name__)


PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION = "torghut.paper-route-evidence.v1"
PAPER_ROUTE_TARGET_PLAN_PAYLOAD_SCHEMA_VERSION = "torghut.paper-route-target-plan.v1"
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
PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_STALE_SECONDS = 900
PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS = 300
PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS = 900
PAPER_ROUTE_ACCOUNT_PRE_SESSION_SNAPSHOT_STALE_SECONDS = 900
PAPER_ROUTE_ACCOUNT_CLOSE_SNAPSHOT_STALE_SECONDS = 3600
HPAIRS_REQUIRED_PAPER_ROUTE_SYMBOLS = ("AAPL", "AMZN")
PAPER_ROUTE_TARGET_PLAN_ENDPOINT = "/trading/paper-route-target-plan"
DEFAULT_TORGHUT_LIVE_SERVICE_BASE_URL = "http://torghut.torghut.svc.cluster.local"
DEFAULT_TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL = (
    "http://torghut-sim.torghut.svc.cluster.local"
)
RUNTIME_LEDGER_PROOF_PACKET_OUTPUT_FILE = "artifacts/runtime-ledger-proof-packet.json"
RUNTIME_WINDOW_IMPORT_OUTPUT_FILE = "artifacts/runtime-window-import.json"
RUNTIME_LEDGER_PROOF_PACKET_ARTIFACT_PREFIX = "runtime-ledger-proof-packets/{run_id}"
RUNTIME_LEDGER_SUMMARY_ROW_LIMIT = 50
US_EQUITIES_TIMEZONE = "America/New_York"
US_EQUITIES_OPEN = time(hour=9, minute=30)
US_EQUITIES_CLOSE = time(hour=16, minute=0)
logger = logging.getLogger(__name__)
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
PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER = "paper_route_evidence_db_unavailable"


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
    return runtime_strategy_name_from_strategy_id(strategy_id)


def _looks_like_uuid_text(value: object) -> bool:
    text = _safe_text(value)
    if text is None:
        return False
    parts = text.split("-")
    if [len(part) for part in parts] != [8, 4, 4, 4, 12]:
        return False
    return all(
        part and all(char in "0123456789abcdefABCDEF" for char in part)
        for part in parts
    )


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


def _canonical_runtime_strategy_name(
    *,
    strategy_name: object,
    runtime_strategy_name: object,
    strategy_id: object,
    strategy_lookup_names: object,
    matched_strategy: Mapping[str, object] | None = None,
) -> str | None:
    matched_name = _safe_text((matched_strategy or {}).get("strategy_name"))
    explicit_or_family_name = explicit_runtime_strategy_name_or_family_harness(
        runtime_strategy_name=runtime_strategy_name,
        strategy_name=strategy_name,
        strategy_id=strategy_id,
    )
    preferred = _strategy_lookup_names(
        matched_name,
        explicit_or_family_name,
        strategy_names_from_strategy_id(strategy_id),
        _strategy_lookup_names(strategy_lookup_names),
        runtime_strategy_name,
        strategy_name,
    )
    for name in preferred:
        if not _looks_like_uuid_text(name):
            return name
    return preferred[0] if preferred else None


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


def _paper_route_audit_error_source_blocker(error_source: str) -> str:
    normalized = error_source.strip().lower().replace("-", "_") or "target_audit"
    return f"{normalized}_db_unavailable"


def _paper_route_audit_error_payload(
    *,
    error_source: str,
    error: BaseException,
) -> dict[str, object]:
    return {
        "source": error_source,
        "blocker": _paper_route_audit_error_source_blocker(error_source),
        "error_type": type(error).__name__,
        "error": str(error),
    }


def _rollback_paper_route_audit_session(session: Session) -> None:
    try:
        session.rollback()
    except SQLAlchemyError:
        logger.warning("Failed to roll back paper-route evidence session")


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


def _order_event_activity_timestamp() -> Any:
    return func.coalesce(ExecutionOrderEvent.event_ts, ExecutionOrderEvent.created_at)


def _order_event_activity_at(row: ExecutionOrderEvent) -> datetime | None:
    return row.event_ts or row.created_at


def _order_event_is_fill(row: ExecutionOrderEvent) -> bool:
    event_type = str(row.event_type or "").strip().lower()
    status = str(row.status or "").strip().lower()
    return event_type in {"fill", "partial_fill"} or status in {
        "filled",
        "partially_filled",
    }


def _order_event_has_complete_fill_lifecycle(row: ExecutionOrderEvent) -> bool:
    if not _order_event_is_fill(row):
        return False
    order_id = _safe_text(row.alpaca_order_id) or _safe_text(row.client_order_id)
    return (
        order_id is not None
        and _safe_decimal(row.filled_qty) > 0
        and _safe_decimal(row.avg_fill_price) > 0
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


def _regular_equities_session_date(value: date) -> bool:
    return is_regular_equities_session_date(value)


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


def _latest_closed_regular_equities_session_window(
    generated_at: datetime,
) -> tuple[datetime, datetime]:
    """Return the latest regular session that is closed at ``generated_at``."""

    zone = ZoneInfo(US_EQUITIES_TIMEZONE)
    local_generated_at = generated_at.astimezone(zone)
    candidate_date = local_generated_at.date()
    while True:
        if _regular_equities_session_date(candidate_date):
            end = datetime.combine(candidate_date, US_EQUITIES_CLOSE, tzinfo=zone)
            if local_generated_at > end:
                start = datetime.combine(candidate_date, US_EQUITIES_OPEN, tzinfo=zone)
                return start.astimezone(timezone.utc), end.astimezone(timezone.utc)
        candidate_date -= timedelta(days=1)


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


def _target_is_hpairs(target: Mapping[str, object]) -> bool:
    for key in ("hypothesis_id", "source_manifest_ref"):
        value = (_safe_text(target.get(key)) or "").lower()
        if "h-pairs" in value or "h_pairs" in value:
            return True
    return False


def _target_requires_balanced_pair_probe(target: Mapping[str, object]) -> bool:
    explicit = _safe_text(target.get("paper_route_probe_pair_balance_required"))
    if explicit is not None:
        return explicit.lower() in {"1", "true", "yes", "on"}
    if _target_is_hpairs(target):
        return True
    for key in (
        "strategy_family",
        "strategy_name",
        "runtime_strategy_name",
        "strategy_id",
        "universe_type",
    ):
        value = _safe_text(target.get(key))
        if value and "microbar_cross_sectional_pairs" in value.lower().replace(
            "-", "_"
        ):
            return True
    return False


def _balanced_pair_probe_symbol_actions(
    target: Mapping[str, object],
    symbols: Sequence[str],
) -> dict[str, str]:
    normalized_symbols = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    raw_actions = _as_mapping(target.get("paper_route_probe_symbol_actions"))
    actions: dict[str, str] = {}
    for symbol in normalized_symbols:
        raw_action = _safe_text(raw_actions.get(symbol))
        if raw_action is not None and raw_action.lower() in {"buy", "long"}:
            actions[symbol] = "buy"
        elif raw_action is not None and raw_action.lower() in {"sell", "short"}:
            actions[symbol] = "sell"
    missing_symbols = [symbol for symbol in normalized_symbols if symbol not in actions]
    if missing_symbols and _target_requires_balanced_pair_probe(target):
        selection_mode = (
            _safe_text(target.get("selection_mode")) or "continuation"
        ).lower()
        first_action = "sell" if selection_mode == "reversal" else "buy"
        second_action = "buy" if first_action == "sell" else "sell"
        buy_count = sum(1 for action in actions.values() if action == "buy")
        sell_count = sum(1 for action in actions.values() if action == "sell")
        balanced_seed_index = 0
        for symbol in missing_symbols:
            if buy_count < sell_count:
                action = "buy"
            elif sell_count < buy_count:
                action = "sell"
            else:
                action = first_action if balanced_seed_index % 2 == 0 else second_action
                balanced_seed_index += 1
            actions[symbol] = action
            if action == "buy":
                buy_count += 1
            else:
                sell_count += 1
    return actions


def _pair_probe_balance_state(actions: Mapping[str, str]) -> str:
    buy_count = sum(1 for action in actions.values() if action == "buy")
    sell_count = sum(1 for action in actions.values() if action == "sell")
    if buy_count > 0 and buy_count == sell_count:
        return "balanced"
    return "imbalanced"


def _hpairs_probe_symbol_blockers(
    target: Mapping[str, object],
    symbols: Sequence[str],
) -> list[str]:
    if not _target_is_hpairs(target):
        return []
    symbol_set = {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
    missing = [symbol for symbol in HPAIRS_REQUIRED_PAPER_ROUTE_SYMBOLS if symbol not in symbol_set]
    blockers: list[str] = []
    if missing:
        blockers.append("paper_route_hpairs_aapl_amzn_legs_missing")
        blockers.extend(f"paper_route_hpairs_{symbol.lower()}_leg_missing" for symbol in missing)
    return blockers


def _target_allows_strategy_universe_probe_fallback(
    target: Mapping[str, object],
) -> bool:
    source_kind = _safe_text(target.get("source_kind"))
    return (
        bool(target.get("paper_probation_authorized"))
        or bool(target.get("source_collection_authorized"))
        or source_kind
        in {
            "durable_runtime_ledger_bucket",
            "runtime_ledger_paper_probation_candidates",
        }
    )


def _strategy_lookup_names_for_target(target: Mapping[str, Any]) -> list[str]:
    strategy_name = _safe_text(target.get("strategy_name"))
    strategy_id = _safe_text(target.get("strategy_id"))
    runtime_strategy_name = (
        explicit_runtime_strategy_name_or_family_harness(
            runtime_strategy_name=target.get("runtime_strategy_name"),
            strategy_name=strategy_name,
            strategy_id=strategy_id,
        )
        or strategy_name
    )
    return _strategy_lookup_names(
        target.get("strategy_lookup_names"),
        runtime_strategy_name,
        strategy_name,
        strategy_names_from_strategy_id(strategy_id),
        derived_strategy_name_from_strategy_id(strategy_id),
    )


def _strategy_rows_by_name_for_targets(
    session: Session,
    targets: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, object]]:
    lookup_names: list[str] = []
    for target in targets:
        for name in _strategy_lookup_names_for_target(target):
            if name and name not in lookup_names:
                lookup_names.append(name)
    if not lookup_names:
        return {}
    rows = session.execute(
        select(
            Strategy.id.label("id"),
            Strategy.name.label("name"),
            Strategy.enabled.label("enabled"),
            Strategy.base_timeframe.label("base_timeframe"),
            Strategy.universe_symbols.label("universe_symbols"),
            Strategy.max_notional_per_trade.label("max_notional_per_trade"),
        ).where(Strategy.name.in_(lookup_names))
    ).mappings()
    return {str(row.get("name")): dict(row) for row in rows if row.get("name")}


def _strategy_universe_symbols_from_row(row: Mapping[str, object]) -> list[str]:
    symbols: list[str] = []
    for item in _as_sequence(row.get("universe_symbols")):
        symbol = str(item).strip().upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def _strategy_universe_symbols(
    session: Session,
    *,
    strategy_lookup_names: Sequence[str],
    strategy_rows_by_name: Mapping[str, Mapping[str, object]] | None = None,
) -> list[str]:
    if not strategy_lookup_names:
        return []
    if strategy_rows_by_name is not None:
        for strategy_name in strategy_lookup_names:
            row = strategy_rows_by_name.get(strategy_name)
            if row is None:
                continue
            symbols = _strategy_universe_symbols_from_row(row)
            if symbols:
                return symbols
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


def _strategy_source_decision_readiness(
    session: Session,
    *,
    strategy_lookup_names: Sequence[str],
    raw_probe_symbols: Sequence[str],
    scoped_probe_symbols: Sequence[str],
    strategy_rows_by_name: Mapping[str, Mapping[str, object]] | None = None,
) -> dict[str, object]:
    lookup_names = [name for name in strategy_lookup_names if name]
    blockers: list[str] = []
    matched: dict[str, object] | None = None
    if lookup_names:
        if strategy_rows_by_name is None:
            rows = [
                dict(row)
                for row in session.execute(
                    select(
                        Strategy.id.label("id"),
                        Strategy.name.label("name"),
                        Strategy.enabled.label("enabled"),
                        Strategy.base_timeframe.label("base_timeframe"),
                        Strategy.universe_symbols.label("universe_symbols"),
                        Strategy.max_notional_per_trade.label("max_notional_per_trade"),
                    ).where(Strategy.name.in_(lookup_names))
                )
                .mappings()
                .all()
            ]
        else:
            rows = [
                dict(row)
                for name in lookup_names
                if (row := strategy_rows_by_name.get(name)) is not None
            ]
        rows_by_name = {str(row.get("name")): row for row in rows if row.get("name")}
        for lookup_name in lookup_names:
            row = rows_by_name.get(lookup_name)
            if row is None:
                continue
            universe_symbols = [
                symbol
                for raw_symbol in _as_sequence(row.get("universe_symbols"))
                if (symbol := str(raw_symbol).strip().upper())
            ]
            matched = {
                "strategy_id": str(row.get("id") or ""),
                "strategy_name": str(row.get("name") or ""),
                "enabled": bool(row.get("enabled")),
                "base_timeframe": str(row.get("base_timeframe") or ""),
                "universe_symbols": universe_symbols,
                "max_notional_per_trade": _decimal_text(
                    row.get("max_notional_per_trade")
                ),
            }
            break
    else:
        blockers.append("source_strategy_lookup_missing")
    if matched is None:
        blockers.append("source_strategy_missing")
    elif not bool(matched.get("enabled")):
        blockers.append("source_strategy_disabled")
    if not raw_probe_symbols:
        blockers.append("paper_route_probe_symbol_missing")
    elif not scoped_probe_symbols:
        blockers.append("source_strategy_universe_excludes_probe_symbols")
    return {
        "schema_version": "torghut.paper-route-source-decision-readiness.v1",
        "ready": not blockers,
        "blockers": blockers,
        "strategy_lookup_names": lookup_names,
        "matched_strategy": matched,
        "raw_probe_symbols": list(raw_probe_symbols),
        "scoped_probe_symbols": list(scoped_probe_symbols),
    }


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
        explicit_runtime_strategy_name_or_family_harness(
            runtime_strategy_name=target.get("runtime_strategy_name"),
            strategy_name=strategy_name,
            strategy_id=strategy_id,
        )
        or strategy_name
    )
    strategy_lookup_names = _strategy_lookup_names(
        target.get("strategy_lookup_names"),
        runtime_strategy_name,
        strategy_name,
        strategy_names_from_strategy_id(strategy_id),
        derived_strategy_name_from_strategy_id(strategy_id),
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
        "target_dsn_env": _safe_text(target.get("target_dsn_env")),
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
        "proof_mode": _safe_text(target.get("proof_mode")) or "probation",
        "evidence_collection_ok": bool(
            target.get("evidence_collection_ok")
            or target.get("paper_probation_authorized")
            or target.get("source_collection_authorized")
            or target.get("bounded_evidence_collection_authorized")
        ),
        "canary_collection_authorized": bool(
            target.get("canary_collection_authorized")
            or target.get("bounded_evidence_collection_authorized")
        ),
        "capital_promotion_allowed": False,
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
    require_clean_pre_session: bool = True,
    window_start: datetime | None = None,
    window_end: datetime | None = None,
    purpose: str = "next_session_paper_route_runtime_window_evidence_collection",
) -> dict[str, object]:
    if window_start is None or window_end is None:
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
        "target_plan_endpoint": PAPER_ROUTE_TARGET_PLAN_ENDPOINT,
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
        "target_dsn_env": "SIM_DB_DSN",
        "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
        "observed_stage": "paper",
        "import_ready": import_ready,
        "import_blockers": import_blockers,
        "proof_mode": "probation",
        "evidence_collection_ok": probe_ready,
        "canary_collection_authorized": probe_ready,
        "capital_promotion_allowed": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "promotion_gate": "runtime_ledger_live_or_live_paper_required",
        "flatten_handoff": {
            "runner": "scripts/flatten_paper_account_positions.py",
            "required_after": "paper_route_session_window_closed",
            "required_for": "zero_open_position_evidence",
            "persist_snapshot_flag": "--persist-snapshot",
            "apply_flag_required_for_mutation": "--apply",
        },
        "zero_open_position_evidence_required": True,
    }
    strategy_rows_by_name = _strategy_rows_by_name_for_targets(session, targets)
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
        source_runtime_strategy_name = (
            _safe_text(target.get("runtime_strategy_name")) or strategy_name
        )
        runtime_strategy_name = (
            explicit_runtime_strategy_name_or_family_harness(
                runtime_strategy_name=target.get("runtime_strategy_name"),
                strategy_name=strategy_name,
                strategy_id=strategy_id,
            )
            or strategy_name
        )
        strategy_lookup_names = _strategy_lookup_names(
            target.get("strategy_lookup_names"),
            runtime_strategy_name,
            strategy_name,
            strategy_names_from_strategy_id(strategy_id),
            derived_strategy_name_from_strategy_id(strategy_id),
        )
        raw_target_probe_symbols = _target_probe_symbols(target, probe)
        strategy_universe_symbols = _strategy_universe_symbols(
            session,
            strategy_lookup_names=strategy_lookup_names,
            strategy_rows_by_name=strategy_rows_by_name,
        )
        target_probe_symbols = raw_target_probe_symbols
        source_readiness_raw_probe_symbols = raw_target_probe_symbols
        out_of_strategy_scope_symbols: list[str] = []
        missing_strategy_universe_symbols: list[str] = []
        strategy_universe_probe_fallback = (
            not target_probe_symbols
            and bool(strategy_universe_symbols)
            and _target_allows_strategy_universe_probe_fallback(target)
        )
        if strategy_universe_probe_fallback:
            target_probe_symbols = list(strategy_universe_symbols)
            source_readiness_raw_probe_symbols = list(strategy_universe_symbols)
        elif strategy_universe_symbols:
            (
                target_probe_symbols,
                out_of_strategy_scope_symbols,
                missing_strategy_universe_symbols,
            ) = _scope_probe_symbols_to_target_plan(
                raw_target_probe_symbols,
                scope_symbols=strategy_universe_symbols,
            )
        source_decision_readiness = _strategy_source_decision_readiness(
            session,
            strategy_lookup_names=strategy_lookup_names,
            raw_probe_symbols=source_readiness_raw_probe_symbols,
            scoped_probe_symbols=target_probe_symbols,
            strategy_rows_by_name=strategy_rows_by_name,
        )
        matched_strategy = _as_mapping(
            source_decision_readiness.get("matched_strategy")
        )
        canonical_strategy_name = _canonical_runtime_strategy_name(
            strategy_name=strategy_name,
            runtime_strategy_name=runtime_strategy_name,
            strategy_id=strategy_id,
            strategy_lookup_names=strategy_lookup_names,
            matched_strategy=matched_strategy,
        )
        strategy_lookup_names = _strategy_lookup_names(
            canonical_strategy_name,
            strategy_lookup_names,
            runtime_strategy_name,
            strategy_name,
            strategy_names_from_strategy_id(strategy_id),
            derived_strategy_name_from_strategy_id(strategy_id),
        )
        pair_balance_target = {
            **dict(target),
            "strategy_name": canonical_strategy_name or strategy_name or "",
            "runtime_strategy_name": canonical_strategy_name
            or runtime_strategy_name
            or strategy_name
            or "",
        }
        pair_balance_required = _target_requires_balanced_pair_probe(
            pair_balance_target
        )
        pair_symbol_actions = _balanced_pair_probe_symbol_actions(
            pair_balance_target,
            target_probe_symbols,
        )
        pair_balance_state = (
            _pair_probe_balance_state(pair_symbol_actions)
            if pair_balance_required
            else "not_required"
        )
        hpairs_symbol_blockers = _hpairs_probe_symbol_blockers(
            pair_balance_target,
            target_probe_symbols,
        )
        target_probe_ready = (
            bool(probe.get("configured_enabled"))
            and _safe_decimal(next_notional) > 0
            and bool(target_probe_symbols)
            and pair_balance_state != "imbalanced"
            and not hpairs_symbol_blockers
        )
        source_manifest_ref = _safe_text(target.get("source_manifest_ref"))
        missing = [
            field
            for field, value in (
                ("hypothesis_id", hypothesis_id),
                ("candidate_id", candidate_id),
                ("strategy_family", strategy_family),
                ("strategy_name", canonical_strategy_name),
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
                if pair_balance_state == "imbalanced":
                    reasons.append("paper_route_probe_pair_imbalanced")
                reasons.extend(hpairs_symbol_blockers)
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "reason": "next_paper_route_runtime_window_target_not_ready",
                    "missing_or_blocking_fields": reasons,
                }
            )
            continue
        account_pre_session_state = _account_pre_session_snapshot_audit(
            session,
            account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            symbols=target_probe_symbols,
            generated_at=generated_at,
            window_start=window_start,
            window_end=window_end,
        )
        account_pre_session_blockers = _unique_text_items(
            account_pre_session_state.get("blockers")
        )
        if account_pre_session_blockers and require_clean_pre_session:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "reason": "paper_route_account_pre_session_not_clean",
                    "missing_or_blocking_fields": account_pre_session_blockers,
                    "paper_route_account_pre_session_state": (
                        account_pre_session_state
                    ),
                    "paper_route_account_pre_session_blockers": (
                        account_pre_session_blockers
                    ),
                }
            )
            continue
        planned_key = (
            hypothesis_id,
            candidate_id,
            strategy_family,
            canonical_strategy_name,
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
            strategy_name=canonical_strategy_name,
            runtime_strategy_name=canonical_strategy_name,
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
        source_collection_authorized = bool(target.get("source_collection_authorized"))
        source_collection_reason_codes = _unique_text_items(
            target.get("source_collection_reason_codes")
        )
        evidence_collection_blockers = _unique_text_items(
            [
                *health_gate_blockers,
                *_unique_text_items(source_decision_readiness.get("blockers")),
                *account_pre_session_blockers,
                *(
                    ["paper_route_probe_pair_imbalanced"]
                    if pair_balance_state == "imbalanced"
                    else []
                ),
                *hpairs_symbol_blockers,
            ]
        )
        evidence_collection_ok = not evidence_collection_blockers
        canary_collection_authorized = (
            evidence_collection_ok
            and target_probe_ready
            and _safe_decimal(next_notional) > 0
            and bool(target_probe_symbols)
        )
        planned_target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": canonical_strategy_name,
            "strategy_id": strategy_id or "",
            "runtime_strategy_name": canonical_strategy_name or "",
            "source_strategy_name": strategy_name or "",
            "source_runtime_strategy_name": source_runtime_strategy_name or "",
            "strategy_lookup_names": strategy_lookup_names,
            "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            "source_account_label": source_account_label or "",
            "source_dsn_env": "SIM_DB_DSN",
            "target_dsn_env": "SIM_DB_DSN",
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
            "paper_route_probe_symbol_actions": pair_symbol_actions,
            "paper_route_probe_pair_balance_required": pair_balance_required,
            "paper_route_probe_pair_balance_state": pair_balance_state,
            "paper_route_hpairs_required_symbols": (
                list(HPAIRS_REQUIRED_PAPER_ROUTE_SYMBOLS)
                if _target_is_hpairs(pair_balance_target)
                else []
            ),
            "paper_route_hpairs_symbol_blockers": hpairs_symbol_blockers,
            "paper_route_probe_strategy_scope_applied": bool(strategy_universe_symbols),
            "paper_route_probe_strategy_universe_fallback": (
                strategy_universe_probe_fallback
            ),
            "paper_route_probe_strategy_universe_symbols": (strategy_universe_symbols),
            "paper_route_probe_out_of_strategy_scope_symbols": (
                out_of_strategy_scope_symbols
            ),
            "paper_route_probe_missing_strategy_universe_symbols": (
                missing_strategy_universe_symbols
            ),
            "paper_route_probe_next_session_max_notional": next_notional,
            "paper_route_probe_effective_max_notional": next_notional,
            "paper_route_probe_window_start": _isoformat(window_start),
            "paper_route_probe_window_end": _isoformat(window_end),
            "paper_route_target_plan_source": paper_route_target_plan_source or "",
            "paper_route_probe_scope_authority": paper_route_probe_scope_authority
            or "",
            "paper_route_account_pre_session_state": account_pre_session_state,
            "paper_route_account_pre_session_blockers": (account_pre_session_blockers),
            "paper_route_execution_source_key": {
                "strategy_family": strategy_family or "",
                "strategy": execution_source_key[1],
                "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                "source_manifest_ref": source_manifest_ref,
                "window_start": _isoformat(window_start),
                "window_end": _isoformat(window_end),
                "paper_route_probe_symbols": target_probe_symbols,
            },
            "source_decision_readiness": source_decision_readiness,
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
            "source_collection_authorized": source_collection_authorized,
            "source_collection_authorization_scope": (
                "source_window_evidence_collection_only"
                if source_collection_authorized
                else ""
            ),
            "source_collection_reason_codes": source_collection_reason_codes,
            "proof_mode": "probation",
            "evidence_collection_ok": evidence_collection_ok,
            "canary_collection_authorized": canary_collection_authorized,
            "capital_promotion_allowed": False,
            "bounded_evidence_collection_authorized": canary_collection_authorized,
            "bounded_evidence_collection_scope": (
                "paper_route_probe_next_session_only"
            ),
            "bounded_evidence_collection_max_notional": next_notional,
            "bounded_evidence_collection_blockers": evidence_collection_blockers,
            "evidence_collection_stage": "paper",
            "probation_allowed": True,
            "probation_reason": "paper_route_probe_next_session_runtime_window",
            "selection_reason": "paper_route_probe_next_session_evidence_collection",
            "selected_by": "paper_route_evidence_audit",
            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": False,
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
                    *evidence_collection_blockers,
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
    source_decision_readiness_items = [
        _as_mapping(target.get("source_decision_readiness"))
        for target in planned_targets
    ]
    source_decision_ready_count = sum(
        1 for item in source_decision_readiness_items if bool(item.get("ready"))
    )
    source_decision_blockers = sorted(
        {
            blocker
            for item in source_decision_readiness_items
            for blocker in _unique_text_items(item.get("blockers"))
        }
    )
    account_pre_session_items = [
        item
        for target in planned_targets
        if (item := _as_mapping(target.get("paper_route_account_pre_session_state")))
    ]
    account_pre_session_items.extend(
        item
        for skipped_target in skipped_targets
        if (
            item := _as_mapping(
                skipped_target.get("paper_route_account_pre_session_state")
            )
        )
    )
    account_pre_session_required_count = sum(
        1 for item in account_pre_session_items if bool(item.get("required"))
    )
    account_pre_session_blockers = sorted(
        {
            blocker
            for item in account_pre_session_items
            for blocker in _unique_text_items(item.get("blockers"))
        }
    )
    account_pre_session_not_yet_required_count = sum(
        1
        for item in account_pre_session_items
        if item.get("state") == "not_required_until_pre_session"
    )
    account_pre_session_clean_count = sum(
        1
        for item in account_pre_session_items
        if item.get("state") == "clean" and not _unique_text_items(item.get("blockers"))
    )
    account_pre_session_blocked_count = sum(
        1
        for item in account_pre_session_items
        if item.get("state") == "blocked"
        or bool(_unique_text_items(item.get("blockers")))
    )
    account_pre_session_pending_count = sum(
        1
        for item in account_pre_session_items
        if item.get("state") == "not_required_until_pre_session"
        and not _unique_text_items(item.get("blockers"))
    )
    account_pre_session_required_after_values = sorted(
        str(item.get("required_after"))
        for item in account_pre_session_items
        if item.get("required_after") is not None
    )
    if not account_pre_session_items:
        account_pre_session_summary_state = "no_targets"
    elif account_pre_session_blocked_count:
        account_pre_session_summary_state = "blocked"
    elif account_pre_session_pending_count:
        account_pre_session_summary_state = "pending_until_pre_session"
    elif account_pre_session_clean_count == len(account_pre_session_items):
        account_pre_session_summary_state = "clean"
    else:
        account_pre_session_summary_state = "unknown"
    return {
        "schema_version": NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION,
        "source": "paper_route_evidence_audit",
        "purpose": purpose,
        "proof_mode": "probation",
        "evidence_collection_ok": any(
            bool(target.get("evidence_collection_ok")) for target in planned_targets
        ),
        "canary_collection_authorized": any(
            bool(target.get("canary_collection_authorized"))
            for target in planned_targets
        ),
        "capital_promotion_allowed": False,
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
        "source_decision_readiness": {
            "schema_version": "torghut.paper-route-source-decision-readiness-summary.v1",
            "target_count": len(source_decision_readiness_items),
            "ready_target_count": source_decision_ready_count,
            "blocked_target_count": (
                len(source_decision_readiness_items) - source_decision_ready_count
            ),
            "blockers": source_decision_blockers,
        },
        "account_pre_session_readiness": {
            "schema_version": "torghut.paper-route-account-pre-session-readiness-summary.v1",
            "state": account_pre_session_summary_state,
            "target_count": len(account_pre_session_items),
            "required_target_count": account_pre_session_required_count,
            "not_yet_required_target_count": (
                account_pre_session_not_yet_required_count
            ),
            "pending_target_count": account_pre_session_pending_count,
            "clean_target_count": account_pre_session_clean_count,
            "blocked_target_count": account_pre_session_blocked_count,
            "next_required_after": (
                account_pre_session_required_after_values[0]
                if account_pre_session_required_after_values
                else None
            ),
            "blockers": account_pre_session_blockers,
        },
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


def _rollback_after_source_activity_error(
    session: Session,
    *,
    source: str,
    exc: SQLAlchemyError,
) -> None:
    logger.warning(
        "Paper route source activity query unavailable source=%s error=%s",
        source,
        exc,
    )
    try:
        session.rollback()
    except SQLAlchemyError as rollback_exc:
        logger.warning(
            "Failed to rollback paper route source activity session source=%s error=%s",
            source,
            rollback_exc,
        )


def _unavailable_source_activity(
    *,
    strategy_name: str | None,
    strategy_lookup_names: Sequence[str],
    account_label: str | None,
    symbols: Sequence[str],
    candidate_id: str | None,
    hypothesis_id: str | None,
    require_source_lineage: bool,
    source: str,
    missing_reason: str,
    raw_decision_count: int = 0,
    lineage_matched_decision_count: int = 0,
) -> dict[str, object]:
    return {
        "strategy_name": strategy_name,
        "strategy_lookup_names": list(strategy_lookup_names),
        "account_label": account_label,
        "symbols": list(symbols),
        "lineage_required": require_source_lineage,
        "expected_candidate_id": candidate_id,
        "expected_hypothesis_id": hypothesis_id,
        "raw_decision_count": raw_decision_count,
        "lineage_matched_decision_count": lineage_matched_decision_count,
        "lineage_blockers": [],
        "decision_count": lineage_matched_decision_count,
        "execution_count": 0,
        "filled_execution_count": 0,
        "order_event_count": 0,
        "fill_order_event_count": 0,
        "complete_fill_order_event_count": 0,
        "tca_sample_count": 0,
        "last_decision_at": None,
        "last_execution_at": None,
        "last_order_event_at": None,
        "last_tca_at": None,
        "missing": True,
        "missing_reasons": [missing_reason],
        "query_unavailable": True,
        "unavailable_source": source,
    }


def _order_event_signed_filled_qty(row: ExecutionOrderEvent) -> Decimal:
    qty = _safe_decimal(row.filled_qty_delta)
    if qty == 0:
        qty = _safe_decimal(row.filled_qty)
    if qty == 0:
        qty = _safe_decimal(row.qty)
    side = ""
    raw_event = _as_mapping(row.raw_event)
    for key in ("side", "order_side"):
        if text := _safe_text(raw_event.get(key)):
            side = text.lower()
            break
    if not side:
        client_order_id = (_safe_text(row.client_order_id) or "").lower()
        if "sell" in client_order_id or "short" in client_order_id:
            side = "sell"
        elif "buy" in client_order_id or "cover" in client_order_id:
            side = "buy"
    if side in {"sell", "short"}:
        return -qty.copy_abs()
    return qty.copy_abs()


def _source_activity_lifecycle_summary(
    *,
    execution_rows: Sequence[Execution],
    order_event_rows: Sequence[ExecutionOrderEvent],
    tca_rows: Sequence[ExecutionTCAMetric],
) -> dict[str, object]:
    submitted_order_count = len(execution_rows)
    execution_status_counts: Counter[str] = Counter(
        (_safe_text(row.status) or "missing") for row in execution_rows
    )
    order_event_status_counts: Counter[str] = Counter(
        (_safe_text(row.status) or "missing") for row in order_event_rows
    )
    order_event_type_counts: Counter[str] = Counter(
        (_safe_text(row.event_type) or "missing") for row in order_event_rows
    )
    filled_notional = sum(
        (
            _safe_decimal(row.filled_notional_delta)
            for row in order_event_rows
            if _order_event_is_fill(row)
        ),
        Decimal("0"),
    )
    if filled_notional <= 0:
        filled_notional = sum(
            (
                _safe_decimal(row.filled_qty) * _safe_decimal(row.avg_fill_price)
                for row in execution_rows
                if _safe_decimal(row.filled_qty) > 0
                and _safe_decimal(row.avg_fill_price) > 0
            ),
            Decimal("0"),
        )
    net_filled_qty_by_symbol: dict[str, Decimal] = {}
    fill_event_rows = [row for row in order_event_rows if _order_event_is_fill(row)]
    if fill_event_rows:
        for row in fill_event_rows:
            symbol = (_safe_text(row.symbol) or "missing").upper()
            signed_qty = _order_event_signed_filled_qty(row)
            if signed_qty != 0:
                net_filled_qty_by_symbol[symbol] = (
                    net_filled_qty_by_symbol.get(symbol, Decimal("0")) + signed_qty
                )
    else:
        for row in execution_rows:
            qty = _safe_decimal(row.filled_qty)
            if qty <= 0:
                continue
            symbol = (_safe_text(row.symbol) or "missing").upper()
            side = (_safe_text(row.side) or "").lower()
            signed_qty = -qty if side in {"sell", "short"} else qty
            net_filled_qty_by_symbol[symbol] = (
                net_filled_qty_by_symbol.get(symbol, Decimal("0")) + signed_qty
            )
    open_symbols = sorted(
        symbol for symbol, qty in net_filled_qty_by_symbol.items() if _safe_decimal(qty) != 0
    )
    lifecycle_blockers: list[str] = []
    fill_count = sum(int(_safe_decimal(row.filled_qty) > 0) for row in execution_rows)
    fill_event_count = len(fill_event_rows)
    complete_fill_event_count = sum(
        int(_order_event_has_complete_fill_lifecycle(row)) for row in order_event_rows
    )
    if submitted_order_count <= 0:
        lifecycle_blockers.append("source_submitted_orders_missing")
    if fill_count <= 0 and fill_event_count <= 0:
        lifecycle_blockers.append("source_fills_missing")
    if fill_event_count > 0 and complete_fill_event_count <= 0:
        lifecycle_blockers.append("source_fill_lifecycle_incomplete")
    if (fill_count > 0 or fill_event_count > 0) and open_symbols:
        lifecycle_blockers.extend(["source_close_missing", "source_closed_round_trip_missing"])
    if len(tca_rows) <= 0 and complete_fill_event_count <= 0:
        lifecycle_blockers.append("source_execution_economics_missing")
    return {
        "schema_version": "torghut.paper-route-source-lifecycle-summary.v1",
        "submitted_order_count": submitted_order_count,
        "execution_status_counts": dict(sorted(execution_status_counts.items())),
        "order_event_status_counts": dict(sorted(order_event_status_counts.items())),
        "order_event_type_counts": dict(sorted(order_event_type_counts.items())),
        "fill_count": fill_count,
        "fill_order_event_count": fill_event_count,
        "complete_fill_order_event_count": complete_fill_event_count,
        "filled_notional": _decimal_text(filled_notional),
        "tca_sample_count": len(tca_rows),
        "net_filled_qty_by_symbol": {
            symbol: _decimal_text(qty)
            for symbol, qty in sorted(net_filled_qty_by_symbol.items())
        },
        "open_symbols_after_source_fills": open_symbols,
        "closed_round_trip_evidence": bool(fill_count > 0 or fill_event_count > 0) and not open_symbols,
        "execution_economics_present": len(tca_rows) > 0 or complete_fill_event_count > 0,
        "blockers": sorted(dict.fromkeys(lifecycle_blockers)),
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
            "order_event_count": 0,
            "fill_order_event_count": 0,
            "complete_fill_order_event_count": 0,
            "tca_sample_count": 0,
            "last_decision_at": None,
            "last_execution_at": None,
            "last_order_event_at": None,
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
    try:
        decision_rows = list(
            session.execute(
                decision_stmt.order_by(TradeDecision.created_at.desc()).limit(500)
            ).scalars()
        )
    except SQLAlchemyError as exc:
        _rollback_after_source_activity_error(
            session,
            source="trade_decisions",
            exc=exc,
        )
        return _unavailable_source_activity(
            strategy_name=strategy_name,
            strategy_lookup_names=strategy_filters,
            account_label=account_label,
            symbols=symbol_filters,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=require_source_lineage,
            source="trade_decisions",
            missing_reason="source_decisions_unavailable",
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
        try:
            execution_rows = list(
                session.execute(
                    execution_stmt.order_by(execution_activity_ts.desc()).limit(500)
                ).scalars()
            )
        except SQLAlchemyError as exc:
            _rollback_after_source_activity_error(
                session,
                source="executions",
                exc=exc,
            )
            return _unavailable_source_activity(
                strategy_name=strategy_name,
                strategy_lookup_names=strategy_filters,
                account_label=account_label,
                symbols=symbol_filters,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                require_source_lineage=require_source_lineage,
                source="executions",
                missing_reason="source_executions_unavailable",
                raw_decision_count=raw_decision_count,
                lineage_matched_decision_count=len(decision_rows),
            )
    order_event_rows: list[ExecutionOrderEvent] = []
    if decision_ids:
        order_event_activity_ts = _order_event_activity_timestamp()
        order_event_stmt = (
            select(ExecutionOrderEvent)
            .where(ExecutionOrderEvent.trade_decision_id.in_(decision_ids))
            .where(order_event_activity_ts >= window_start)
            .where(order_event_activity_ts < window_end)
        )
        if account_label:
            order_event_stmt = order_event_stmt.where(
                ExecutionOrderEvent.alpaca_account_label == account_label
            )
        if symbol_filters:
            order_event_stmt = order_event_stmt.where(
                func.upper(ExecutionOrderEvent.symbol).in_(symbol_filters)
            )
        try:
            order_event_rows = list(
                session.execute(
                    order_event_stmt.order_by(order_event_activity_ts.desc()).limit(500)
                ).scalars()
            )
        except SQLAlchemyError as exc:
            _rollback_after_source_activity_error(
                session,
                source="execution_order_events",
                exc=exc,
            )
            return _unavailable_source_activity(
                strategy_name=strategy_name,
                strategy_lookup_names=strategy_filters,
                account_label=account_label,
                symbols=symbol_filters,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                require_source_lineage=require_source_lineage,
                source="execution_order_events",
                missing_reason="source_order_events_unavailable",
                raw_decision_count=raw_decision_count,
                lineage_matched_decision_count=len(decision_rows),
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
        try:
            tca_rows = list(
                session.execute(
                    tca_stmt.order_by(ExecutionTCAMetric.computed_at.desc()).limit(500)
                ).scalars()
            )
        except SQLAlchemyError as exc:
            _rollback_after_source_activity_error(
                session,
                source="execution_tca_metrics",
                exc=exc,
            )
            return _unavailable_source_activity(
                strategy_name=strategy_name,
                strategy_lookup_names=strategy_filters,
                account_label=account_label,
                symbols=symbol_filters,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                require_source_lineage=require_source_lineage,
                source="execution_tca_metrics",
                missing_reason="source_tca_unavailable",
                raw_decision_count=raw_decision_count,
                lineage_matched_decision_count=len(decision_rows),
            )
    decision_count = len(decision_rows)
    execution_count = len(execution_rows)
    tca_sample_count = len(tca_rows)
    filled_execution_count = sum(
        int(_safe_decimal(row.filled_qty) > 0) for row in execution_rows
    )
    order_event_count = len(order_event_rows)
    fill_order_event_count = sum(
        int(_order_event_is_fill(row)) for row in order_event_rows
    )
    complete_fill_order_event_count = sum(
        int(_order_event_has_complete_fill_lifecycle(row)) for row in order_event_rows
    )
    missing_reasons: list[str] = []
    if decision_count <= 0:
        missing_reasons.append("source_decisions_missing")
    if execution_count <= 0:
        missing_reasons.append("source_executions_missing")
    if tca_sample_count <= 0 and complete_fill_order_event_count <= 0:
        missing_reasons.append("source_tca_missing")
    missing_reasons.extend(lineage_blockers)
    lifecycle_summary = _source_activity_lifecycle_summary(
        execution_rows=execution_rows,
        order_event_rows=order_event_rows,
        tca_rows=tca_rows,
    )
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
        "order_event_count": order_event_count,
        "fill_order_event_count": fill_order_event_count,
        "complete_fill_order_event_count": complete_fill_order_event_count,
        "tca_sample_count": tca_sample_count,
        "submitted_order_count": execution_count,
        "source_lifecycle": lifecycle_summary,
        "source_lifecycle_blockers": _unique_text_items(lifecycle_summary.get("blockers")),
        "last_decision_at": _isoformat(
            decision_rows[0].created_at if decision_rows else None
        ),
        "last_execution_at": _isoformat(
            _execution_activity_at(execution_rows[0]) if execution_rows else None
        ),
        "last_order_event_at": _isoformat(
            _order_event_activity_at(order_event_rows[0]) if order_event_rows else None
        ),
        "last_tca_at": _isoformat(tca_rows[0].computed_at if tca_rows else None),
        "missing": bool(missing_reasons),
        "missing_reasons": missing_reasons,
    }


def _database_unavailable_source_activity(
    *,
    target: Mapping[str, Any],
    probe: Mapping[str, object],
    error_source: str,
    error: BaseException,
) -> dict[str, object]:
    source_blocker = _paper_route_audit_error_source_blocker(error_source)
    return {
        "strategy_name": _safe_text(target.get("strategy_name")),
        "strategy_lookup_names": [
            str(item)
            for item in _as_sequence(target.get("strategy_lookup_names"))
            if str(item).strip()
        ],
        "account_label": _safe_text(target.get("account_label")),
        "symbols": _target_probe_symbols(target, probe),
        "lineage_required": _target_requires_source_lineage(target),
        "expected_candidate_id": _safe_text(target.get("candidate_id")),
        "expected_hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "raw_decision_count": 0,
        "lineage_matched_decision_count": 0,
        "lineage_blockers": [source_blocker],
        "decision_count": 0,
        "execution_count": 0,
        "filled_execution_count": 0,
        "order_event_count": 0,
        "fill_order_event_count": 0,
        "complete_fill_order_event_count": 0,
        "tca_sample_count": 0,
        "last_decision_at": None,
        "last_execution_at": None,
        "last_order_event_at": None,
        "last_tca_at": None,
        "missing": True,
        "missing_reasons": [
            PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER,
            source_blocker,
            "source_decisions_missing",
            "source_executions_missing",
            "source_tca_missing",
        ],
        "db_load_error": _paper_route_audit_error_payload(
            error_source=error_source,
            error=error,
        ),
    }


def _account_contamination_audit(
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
    blockers: list[str] = []
    if account_label is None:
        return {
            "schema_version": "torghut.paper-route-account-contamination-audit.v1",
            "scope": "target_window_account_symbol_order_events",
            "account_label": None,
            "symbols": symbol_filters,
            "window_start": _isoformat(window_start),
            "window_end": _isoformat(window_end),
            "contaminated": False,
            "unlinked_order_event_count": 0,
            "client_order_id_count": 0,
            "sample_client_order_ids": [],
            "symbol_counts": {},
            "event_type_counts": {},
            "status_counts": {},
            "last_event_at": None,
            "blockers": [],
        }
    order_event_activity_ts = _order_event_activity_timestamp()
    stmt = (
        select(ExecutionOrderEvent)
        .where(ExecutionOrderEvent.alpaca_account_label == account_label)
        .where(order_event_activity_ts >= window_start)
        .where(order_event_activity_ts < window_end)
        .where(ExecutionOrderEvent.trade_decision_id.is_(None))
    )
    if symbol_filters:
        stmt = stmt.where(func.upper(ExecutionOrderEvent.symbol).in_(symbol_filters))
    rows = list(
        session.execute(
            stmt.order_by(order_event_activity_ts.desc()).limit(500)
        ).scalars()
    )
    if rows:
        blockers.extend(
            [
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
            ]
        )
    client_order_ids: list[str] = []
    symbol_counts: Counter[str] = Counter()
    event_type_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    for row in rows:
        if client_order_id := _safe_text(row.client_order_id):
            if client_order_id not in client_order_ids:
                client_order_ids.append(client_order_id)
        symbol_counts[_safe_text(row.symbol) or "missing"] += 1
        event_type_counts[_safe_text(row.event_type) or "missing"] += 1
        status_counts[_safe_text(row.status) or "missing"] += 1
    return {
        "schema_version": "torghut.paper-route-account-contamination-audit.v1",
        "scope": "target_window_account_symbol_order_events",
        "account_label": account_label,
        "symbols": symbol_filters,
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "contaminated": bool(rows),
        "unlinked_order_event_count": len(rows),
        "client_order_id_count": len(client_order_ids),
        "sample_client_order_ids": client_order_ids[:10],
        "symbol_counts": dict(sorted(symbol_counts.items())),
        "event_type_counts": dict(sorted(event_type_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "last_event_at": _isoformat(
            _order_event_activity_at(rows[0]) if rows else None
        ),
        "blockers": blockers,
    }


def _position_quantity(position: Mapping[str, object]) -> Decimal:
    qty = _safe_decimal(
        position.get("qty")
        or position.get("quantity")
        or position.get("position_qty")
        or position.get("shares")
    )
    if qty == 0:
        return Decimal("0")
    side = (_safe_text(position.get("side")) or "").lower()
    if side == "short" and qty > 0:
        return -qty
    return qty


def _position_market_value(position: Mapping[str, object]) -> Decimal:
    for key in ("market_value", "marketValue", "notional", "position_value"):
        if key in position:
            return _safe_decimal(position.get(key)).copy_abs()
    qty = _position_quantity(position).copy_abs()
    price = _safe_decimal(
        position.get("current_price")
        or position.get("currentPrice")
        or position.get("avg_entry_price")
        or position.get("avgEntryPrice")
    ).copy_abs()
    return qty * price


def _normalized_open_positions(
    positions: object,
    *,
    target_symbols: set[str],
) -> list[dict[str, object]]:
    normalized: list[dict[str, object]] = []
    for raw_position in _as_sequence(positions):
        position = _as_mapping(raw_position)
        symbol = (_safe_text(position.get("symbol")) or "").upper()
        qty = _position_quantity(position)
        if not symbol or qty == 0:
            continue
        normalized.append(
            {
                "symbol": symbol,
                "qty": _decimal_text(qty),
                "side": _safe_text(position.get("side")),
                "market_value": _decimal_text(_position_market_value(position)),
                "target_symbol": symbol in target_symbols,
            }
        )
    return sorted(
        normalized,
        key=lambda item: (
            not bool(item.get("target_symbol")),
            str(item.get("symbol") or ""),
        ),
    )


def _account_window_start_snapshot_audit(
    session: Session,
    *,
    account_label: str | None,
    symbols: Sequence[str],
    window_start: datetime,
    generated_at: datetime | None = None,
) -> dict[str, object]:
    symbol_filters = {
        str(item).strip().upper() for item in symbols if str(item).strip()
    }
    required = generated_at is None or generated_at >= window_start
    base_payload: dict[str, object] = {
        "schema_version": "torghut.paper-route-account-window-start-snapshot-audit.v1",
        "scope": "account_position_snapshot_at_runtime_window_start",
        "account_label": account_label,
        "symbols": sorted(symbol_filters),
        "generated_at": _isoformat(generated_at) if generated_at is not None else None,
        "window_start": _isoformat(window_start),
        "required": required,
        "state": "required" if required else "pending_until_window_start",
        "snapshot_id": None,
        "snapshot_as_of": None,
        "snapshot_source": None,
        "snapshot_offset_seconds": None,
        "flat": False if required else None,
        "position_count": 0,
        "target_symbol_position_count": 0,
        "non_target_symbol_position_count": 0,
        "gross_position_market_value": "0",
        "sample_positions": [],
        "blockers": [],
    }
    if account_label is None:
        return {
            **base_payload,
            "required": False,
            "state": "not_applicable",
            "flat": True,
        }
    if not required:
        return base_payload

    before_snapshot = session.execute(
        select(PositionSnapshot)
        .where(PositionSnapshot.alpaca_account_label == account_label)
        .where(PositionSnapshot.as_of <= window_start)
        .order_by(PositionSnapshot.as_of.desc())
        .limit(1)
    ).scalar_one_or_none()
    after_snapshot = None
    if before_snapshot is None:
        after_snapshot = session.execute(
            select(PositionSnapshot)
            .where(PositionSnapshot.alpaca_account_label == account_label)
            .where(PositionSnapshot.as_of > window_start)
            .where(
                PositionSnapshot.as_of
                <= window_start
                + timedelta(
                    seconds=PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS
                )
            )
            .order_by(PositionSnapshot.as_of.asc())
            .limit(1)
        ).scalar_one_or_none()

    snapshot = before_snapshot or after_snapshot
    if snapshot is None:
        return {
            **base_payload,
            "blockers": ["paper_route_account_window_start_snapshot_missing"],
        }

    snapshot_as_of = snapshot.as_of
    if snapshot_as_of.tzinfo is None:
        snapshot_as_of = snapshot_as_of.replace(tzinfo=timezone.utc)
    snapshot_as_of = snapshot_as_of.astimezone(timezone.utc)
    offset_seconds = int((snapshot_as_of - window_start).total_seconds())
    blockers: list[str] = []
    if offset_seconds < -PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_STALE_SECONDS:
        blockers.append("paper_route_account_window_start_snapshot_stale")

    positions = _normalized_open_positions(
        snapshot.positions,
        target_symbols=symbol_filters,
    )
    target_position_count = sum(
        int(bool(position.get("target_symbol"))) for position in positions
    )
    non_target_position_count = len(positions) - target_position_count
    if positions:
        blockers.extend(
            [
                "paper_route_account_window_start_not_flat",
                "paper_route_account_window_start_positions_present",
            ]
        )
    if target_position_count:
        blockers.append("paper_route_account_window_start_target_positions_present")
    if non_target_position_count:
        blockers.append("paper_route_account_window_start_non_target_positions_present")
    gross_market_value = sum(
        (_safe_decimal(position.get("market_value")) for position in positions),
        Decimal("0"),
    )
    return {
        **base_payload,
        "snapshot_id": str(snapshot.id),
        "snapshot_as_of": _isoformat(snapshot_as_of),
        "snapshot_source": (
            "latest_before_window_start"
            if before_snapshot is not None
            else "first_after_window_start"
        ),
        "snapshot_offset_seconds": offset_seconds,
        "state": "blocked" if blockers else "clean",
        "flat": not positions and not blockers,
        "position_count": len(positions),
        "target_symbol_position_count": target_position_count,
        "non_target_symbol_position_count": non_target_position_count,
        "gross_position_market_value": _decimal_text(gross_market_value),
        "sample_positions": positions[:10],
        "blockers": sorted(dict.fromkeys(blockers)),
    }


def _account_pre_session_snapshot_audit(
    session: Session,
    *,
    account_label: str | None,
    symbols: Sequence[str],
    generated_at: datetime,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    symbol_filters = {
        str(item).strip().upper() for item in symbols if str(item).strip()
    }
    required_after = window_start - timedelta(
        seconds=PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS
    )
    required = required_after <= generated_at < window_end
    base_payload: dict[str, object] = {
        "schema_version": "torghut.paper-route-account-pre-session-snapshot-audit.v1",
        "scope": "account_position_snapshot_before_runtime_window_start",
        "account_label": account_label,
        "symbols": sorted(symbol_filters),
        "generated_at": _isoformat(generated_at),
        "window_start": _isoformat(window_start),
        "required": required,
        "required_after": _isoformat(required_after),
        "snapshot_id": None,
        "snapshot_as_of": None,
        "snapshot_age_seconds": None,
        "flat": None,
        "position_count": 0,
        "target_symbol_position_count": 0,
        "non_target_symbol_position_count": 0,
        "gross_position_market_value": "0",
        "sample_positions": [],
        "blockers": [],
    }
    if not required:
        return {
            **base_payload,
            "state": "not_required_until_pre_session",
        }
    if account_label is None:
        return {
            **base_payload,
            "state": "clean",
            "flat": True,
        }

    snapshot = session.execute(
        select(PositionSnapshot)
        .where(PositionSnapshot.alpaca_account_label == account_label)
        .where(PositionSnapshot.as_of <= generated_at)
        .order_by(PositionSnapshot.as_of.desc())
        .limit(1)
    ).scalar_one_or_none()
    if snapshot is None:
        return {
            **base_payload,
            "state": "blocked",
            "flat": False,
            "blockers": ["paper_route_account_pre_session_snapshot_missing"],
        }

    snapshot_as_of = snapshot.as_of
    if snapshot_as_of.tzinfo is None:
        snapshot_as_of = snapshot_as_of.replace(tzinfo=timezone.utc)
    snapshot_as_of = snapshot_as_of.astimezone(timezone.utc)
    snapshot_age_seconds = int((generated_at - snapshot_as_of).total_seconds())
    blockers: list[str] = []
    if snapshot_age_seconds > PAPER_ROUTE_ACCOUNT_PRE_SESSION_SNAPSHOT_STALE_SECONDS:
        blockers.append("paper_route_account_pre_session_snapshot_stale")

    positions = _normalized_open_positions(
        snapshot.positions,
        target_symbols=symbol_filters,
    )
    target_position_count = sum(
        int(bool(position.get("target_symbol"))) for position in positions
    )
    non_target_position_count = len(positions) - target_position_count
    if positions:
        blockers.extend(
            [
                "paper_route_account_pre_session_not_flat",
                "paper_route_account_pre_session_positions_present",
            ]
        )
    if target_position_count:
        blockers.append("paper_route_account_pre_session_target_positions_present")
    if non_target_position_count:
        blockers.append("paper_route_account_pre_session_non_target_positions_present")
    gross_market_value = sum(
        (_safe_decimal(position.get("market_value")) for position in positions),
        Decimal("0"),
    )
    blockers = sorted(dict.fromkeys(blockers))
    return {
        **base_payload,
        "state": "blocked" if blockers else "clean",
        "snapshot_id": str(snapshot.id),
        "snapshot_as_of": _isoformat(snapshot_as_of),
        "snapshot_age_seconds": snapshot_age_seconds,
        "flat": not positions and not blockers,
        "position_count": len(positions),
        "target_symbol_position_count": target_position_count,
        "non_target_symbol_position_count": non_target_position_count,
        "gross_position_market_value": _decimal_text(gross_market_value),
        "sample_positions": positions[:10],
        "blockers": blockers,
    }


def _account_window_close_snapshot_audit(
    session: Session,
    *,
    account_label: str | None,
    symbols: Sequence[str],
    window_end: datetime,
    generated_at: datetime,
) -> dict[str, object]:
    symbol_filters = {
        str(item).strip().upper() for item in symbols if str(item).strip()
    }
    required = generated_at >= window_end
    base_payload: dict[str, object] = {
        "schema_version": "torghut.paper-route-account-window-close-snapshot-audit.v1",
        "scope": "account_position_snapshot_after_runtime_window_close",
        "account_label": account_label,
        "symbols": sorted(symbol_filters),
        "generated_at": _isoformat(generated_at),
        "window_end": _isoformat(window_end),
        "required": required,
        "snapshot_id": None,
        "snapshot_as_of": None,
        "snapshot_age_seconds": None,
        "flat": None,
        "zero_open_position_evidence": False,
        "position_count": 0,
        "target_symbol_position_count": 0,
        "non_target_symbol_position_count": 0,
        "gross_position_market_value": "0",
        "sample_positions": [],
        "flatten_handoff": {
            "runner": "scripts/flatten_paper_account_positions.py",
            "argv": [
                "uv",
                "run",
                "--frozen",
                "python",
                "scripts/flatten_paper_account_positions.py",
                "--account-label",
                PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                "--expected-account-label",
                PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                "--trading-mode",
                "paper",
                "--persist-snapshot",
                "--json",
            ],
            "apply_flag_required_for_mutation": "--apply",
            "snapshot_required": True,
        },
        "blockers": [],
    }
    if not required:
        return {
            **base_payload,
            "state": "pending_until_window_close",
        }
    if account_label is None:
        return {
            **base_payload,
            "state": "clean",
            "flat": True,
            "zero_open_position_evidence": True,
        }

    snapshot = session.execute(
        select(PositionSnapshot)
        .where(PositionSnapshot.alpaca_account_label == account_label)
        .where(PositionSnapshot.as_of >= window_end)
        .where(PositionSnapshot.as_of <= generated_at)
        .order_by(PositionSnapshot.as_of.desc())
        .limit(1)
    ).scalar_one_or_none()
    if snapshot is None:
        return {
            **base_payload,
            "state": "blocked",
            "flat": False,
            "blockers": [
                "paper_route_account_window_close_snapshot_missing",
                "paper_route_flatten_handoff_missing",
            ],
        }

    snapshot_as_of = snapshot.as_of
    if snapshot_as_of.tzinfo is None:
        snapshot_as_of = snapshot_as_of.replace(tzinfo=timezone.utc)
    snapshot_as_of = snapshot_as_of.astimezone(timezone.utc)
    snapshot_age_seconds = int((generated_at - snapshot_as_of).total_seconds())
    blockers: list[str] = []
    if snapshot_age_seconds > PAPER_ROUTE_ACCOUNT_CLOSE_SNAPSHOT_STALE_SECONDS:
        blockers.append("paper_route_account_window_close_snapshot_stale")

    positions = _normalized_open_positions(
        snapshot.positions,
        target_symbols=symbol_filters,
    )
    target_position_count = sum(
        int(bool(position.get("target_symbol"))) for position in positions
    )
    non_target_position_count = len(positions) - target_position_count
    if positions:
        blockers.extend(
            [
                "paper_route_account_window_close_not_flat",
                "paper_route_account_window_close_positions_present",
                "paper_route_missing_close",
            ]
        )
    if target_position_count:
        blockers.append("paper_route_account_window_close_target_positions_present")
    if non_target_position_count:
        blockers.append("paper_route_account_window_close_non_target_positions_present")
    gross_market_value = sum(
        (_safe_decimal(position.get("market_value")) for position in positions),
        Decimal("0"),
    )
    blockers = sorted(dict.fromkeys(blockers))
    return {
        **base_payload,
        "state": "blocked" if blockers else "clean",
        "snapshot_id": str(snapshot.id),
        "snapshot_as_of": _isoformat(snapshot_as_of),
        "snapshot_age_seconds": snapshot_age_seconds,
        "flat": not positions and not blockers,
        "zero_open_position_evidence": not positions and not blockers,
        "position_count": len(positions),
        "target_symbol_position_count": target_position_count,
        "non_target_symbol_position_count": non_target_position_count,
        "gross_position_market_value": _decimal_text(gross_market_value),
        "sample_positions": positions[:10],
        "blockers": blockers,
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
        blocking_reasons.append("paper_route_submit_blocked")
        if any("stale" in reason.lower() for reason in reason_counts):
            blocking_reasons.append("paper_route_stale_quote")
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
    source_authority_blockers = runtime_ledger_promotion_source_authority_blockers(
        _as_mapping(row.payload_json)
    )
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
        and not source_authority_blockers
    )


def _runtime_ledger_bucket_diagnostic_blockers(
    row: StrategyRuntimeLedgerBucket,
) -> list[str]:
    blockers = [
        str(item).strip()
        for item in _as_sequence(row.blockers_json)
        if str(item).strip()
    ]
    blockers.extend(
        runtime_ledger_promotion_source_authority_blockers(
            _as_mapping(row.payload_json)
        )
    )
    return list(dict.fromkeys(blockers))


def _runtime_ledger_row_diagnostic_expectancy_bps(
    row: StrategyRuntimeLedgerBucket,
) -> Decimal | None:
    payload = _as_mapping(row.payload_json)
    if diagnostic := payload.get("diagnostic_closed_trade_expectancy_bps"):
        return _safe_decimal(diagnostic)
    if row.post_cost_expectancy_bps is not None:
        return _safe_decimal(row.post_cost_expectancy_bps)
    filled_notional = _safe_decimal(row.filled_notional)
    if _safe_int(row.closed_trade_count) <= 0 or filled_notional <= 0:
        return None
    return (
        _safe_decimal(row.net_strategy_pnl_after_costs)
        / filled_notional
        * Decimal("10000")
    )


def _runtime_ledger_row_source_decision_mode_counts(
    row: StrategyRuntimeLedgerBucket,
) -> Counter[str]:
    payload = _as_mapping(row.payload_json)
    counts: Counter[str] = Counter()
    raw_counts = _as_mapping(payload.get("source_decision_mode_counts"))
    for raw_mode, raw_count in raw_counts.items():
        mode = normalize_source_decision_mode(raw_mode) or "missing"
        count = _safe_int(raw_count)
        if count > 0:
            counts[mode] += count
    if counts:
        return counts

    mode = normalize_source_decision_mode(payload.get("source_decision_mode"))
    if mode is not None:
        counts[mode] += max(
            1,
            _safe_int(row.decision_count),
            _safe_int(row.fill_count),
        )
    else:
        counts["missing"] += max(1, _safe_int(row.decision_count))
    return counts


def _runtime_ledger_row_source_decision_modes_are_profit_proof_eligible(
    row: StrategyRuntimeLedgerBucket,
) -> bool:
    counts = _runtime_ledger_row_source_decision_mode_counts(row)
    return bool(counts) and all(
        source_decision_mode_is_profit_proof_eligible(mode) for mode in counts
    )


def _runtime_ledger_diagnostic_totals(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, object]:
    filled_notional = sum(
        (_safe_decimal(row.filled_notional) for row in rows), Decimal("0")
    )
    net_pnl = sum(
        (_safe_decimal(row.net_strategy_pnl_after_costs) for row in rows),
        Decimal("0"),
    )
    return {
        "bucket_count": len(rows),
        "fill_count": sum(max(0, _safe_int(row.fill_count)) for row in rows),
        "decision_count": sum(max(0, _safe_int(row.decision_count)) for row in rows),
        "closed_trade_count": sum(
            max(0, _safe_int(row.closed_trade_count)) for row in rows
        ),
        "open_position_count": sum(
            max(0, _safe_int(row.open_position_count)) for row in rows
        ),
        "filled_notional": _decimal_text(filled_notional),
        "net_strategy_pnl_after_costs": _decimal_text(net_pnl),
        "diagnostic_closed_trade_expectancy_bps": _decimal_text(
            (net_pnl / filled_notional * Decimal("10000"))
            if filled_notional > 0
            else Decimal("0")
        ),
    }


def _runtime_ledger_non_evidence_diagnostic_summary(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, object]:
    diagnostic_rows = [
        row
        for row in rows
        if _runtime_ledger_row_diagnostic_expectancy_bps(row) is not None
    ]
    filled_notional = sum(
        (_safe_decimal(row.filled_notional) for row in diagnostic_rows), Decimal("0")
    )
    net_pnl = sum(
        (_safe_decimal(row.net_strategy_pnl_after_costs) for row in diagnostic_rows),
        Decimal("0"),
    )
    blocker_counts: Counter[str] = Counter(
        blocker
        for row in rows
        for blocker in _runtime_ledger_bucket_diagnostic_blockers(row)
    )
    source_decision_mode_counts: Counter[str] = Counter()
    source_decision_mode_bucket_counts: Counter[str] = Counter()
    for row in rows:
        row_mode_counts = _runtime_ledger_row_source_decision_mode_counts(row)
        source_decision_mode_counts.update(row_mode_counts)
        source_decision_mode_bucket_counts.update(row_mode_counts.keys())
    profit_proof_diagnostic_rows = [
        row
        for row in diagnostic_rows
        if _runtime_ledger_row_source_decision_modes_are_profit_proof_eligible(row)
    ]
    profit_proof_diagnostic_row_ids = {id(row) for row in profit_proof_diagnostic_rows}
    non_profit_proof_diagnostic_rows = [
        row for row in diagnostic_rows if id(row) not in profit_proof_diagnostic_row_ids
    ]
    non_profit_proof_source_decision_modes = sorted(
        mode
        for mode in source_decision_mode_counts
        if not source_decision_mode_is_profit_proof_eligible(mode)
    )
    return {
        "scope": (
            "non_evidence_grade_runtime_ledger_buckets_diagnostic_only_not_promotion_proof"
        ),
        "bucket_count": len(rows),
        "diagnostic_bucket_count": len(diagnostic_rows),
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
        "diagnostic_closed_trade_expectancy_bps": _decimal_text(
            (net_pnl / filled_notional * Decimal("10000"))
            if filled_notional > 0
            else Decimal("0")
        ),
        "blocker_counts": dict(sorted(blocker_counts.items())),
        "source_decision_mode_counts": dict(
            sorted(source_decision_mode_counts.items())
        ),
        "source_decision_mode_bucket_counts": dict(
            sorted(source_decision_mode_bucket_counts.items())
        ),
        "profit_proof_eligible_diagnostic": _runtime_ledger_diagnostic_totals(
            profit_proof_diagnostic_rows
        ),
        "non_profit_proof_diagnostic": {
            **_runtime_ledger_diagnostic_totals(non_profit_proof_diagnostic_rows),
            "source_decision_modes": non_profit_proof_source_decision_modes,
            "reason": "source_decision_mode_not_profit_proof_eligible",
        },
        "latest_bucket_ended_at": _isoformat(rows[0].bucket_ended_at if rows else None),
        "db_row_refs": [str(row.id) for row in rows],
    }


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
    evidence_grade_row_ids = {id(row) for row in evidence_grade_rows}
    non_evidence_grade_rows = [
        row for row in rows if id(row) not in evidence_grade_row_ids
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
        "non_evidence_grade_bucket_count": len(non_evidence_grade_rows),
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
                blocker
                for row in rows
                for blocker in _runtime_ledger_bucket_diagnostic_blockers(row)
            }
        ),
        "non_evidence_grade_diagnostic": (
            _runtime_ledger_non_evidence_diagnostic_summary(non_evidence_grade_rows)
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
        if (
            _safe_int(source_activity.get("tca_sample_count")) <= 0
            and _safe_int(source_activity.get("complete_fill_order_event_count")) <= 0
        ):
            blockers.add("source_tca_missing")
        blockers.update(
            str(item).strip()
            for item in _as_sequence(source_activity.get("lineage_blockers"))
            if str(item).strip()
        )
    return sorted(blockers)


def _rejected_signal_reasons_actionable(
    source_activity: Mapping[str, object],
) -> bool:
    if bool(source_activity.get("missing")):
        return True
    return (
        _safe_int(source_activity.get("filled_execution_count")) <= 0
        and _safe_int(source_activity.get("tca_sample_count")) <= 0
        and _safe_int(source_activity.get("complete_fill_order_event_count")) <= 0
    )


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
    account_contamination: Mapping[str, object],
    account_state: Mapping[str, object],
    rejected_signal_activity: Mapping[str, object],
    account_close_state: Mapping[str, object],
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
    blockers.update(
        str(item).strip()
        for item in _as_sequence(account_contamination.get("blockers"))
        if str(item).strip()
    )
    blockers.update(
        str(item).strip()
        for item in _as_sequence(account_state.get("blockers"))
        if str(item).strip()
    )
    if _target_is_hpairs(target) and not bool(source_activity.get("missing")):
        blockers.update(
            str(item).strip()
            for item in _as_sequence(source_activity.get("source_lifecycle_blockers"))
            if str(item).strip()
        )
        blockers.update(
            str(item).strip()
            for item in _as_sequence(account_close_state.get("blockers"))
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


def _source_backed_import_ready_metadata(
    *,
    target: Mapping[str, object],
    source_activity: Mapping[str, object],
    account_close_state: Mapping[str, object],
    runtime_ledger: Mapping[str, object],
) -> dict[str, object]:
    source_lifecycle = _as_mapping(source_activity.get("source_lifecycle"))
    ready = (
        not bool(source_activity.get("missing"))
        and not _unique_text_items(source_activity.get("source_lifecycle_blockers"))
        and bool(account_close_state.get("zero_open_position_evidence"))
        and _safe_int(runtime_ledger.get("evidence_grade_bucket_count")) > 0
    )
    return {
        "schema_version": "torghut.paper-route-source-backed-import-ready.v1",
        "ready": ready,
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "account_label": _safe_text(target.get("account_label")),
        "window_start": _safe_text(target.get("window_start")),
        "window_end": _safe_text(target.get("window_end")),
        "source_backed": True,
        "synthetic_pnl_used": False,
        "decision_count": _safe_int(source_activity.get("decision_count")),
        "submitted_order_count": _safe_int(
            source_lifecycle.get("submitted_order_count")
            or source_activity.get("submitted_order_count")
        ),
        "fill_count": _safe_int(source_lifecycle.get("fill_count")),
        "fill_order_event_count": _safe_int(
            source_lifecycle.get("fill_order_event_count")
        ),
        "filled_notional": _safe_text(source_lifecycle.get("filled_notional")) or "0",
        "closed_round_trip_evidence": bool(
            source_lifecycle.get("closed_round_trip_evidence")
        ),
        "zero_open_position_evidence": bool(
            account_close_state.get("zero_open_position_evidence")
        ),
        "runtime_ledger_evidence_grade_bucket_count": _safe_int(
            runtime_ledger.get("evidence_grade_bucket_count")
        ),
        "runtime_ledger_db_row_refs": _unique_text_items(runtime_ledger.get("db_row_refs")),
        "blockers": _unique_text_items(
            [
                *(
                    _unique_text_items(source_activity.get("missing_reasons"))
                    if bool(source_activity.get("missing"))
                    else []
                ),
                *_unique_text_items(source_activity.get("source_lifecycle_blockers")),
                *_unique_text_items(account_close_state.get("blockers")),
                *(
                    ["runtime_ledger_evidence_grade_bucket_missing"]
                    if _safe_int(runtime_ledger.get("evidence_grade_bucket_count")) <= 0
                    else []
                ),
            ]
        ),
    }


def _target_audit(
    session: Session,
    *,
    raw_target: Mapping[str, Any],
    probe: Mapping[str, object],
    generated_at: datetime,
    lookback_hours: int,
    error_source: str = "target_audit",
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
    try:
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
    except SQLAlchemyError as exc:
        logger.warning(
            "Paper-route source activity audit degraded source=%s error=%s",
            error_source,
            exc,
        )
        _rollback_paper_route_audit_session(session)
        source_activity = _database_unavailable_source_activity(
            target=target,
            probe=probe,
            error_source=error_source,
            error=exc,
        )
    account_contamination = _account_contamination_audit(
        session,
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_start=window_start,
        window_end=window_end,
    )
    account_state = _account_window_start_snapshot_audit(
        session,
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_start=window_start,
        generated_at=generated_at,
    )
    account_close_state = _account_window_close_snapshot_audit(
        session,
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_end=window_end,
        generated_at=generated_at,
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
        account_contamination=account_contamination,
        account_state=account_state,
        account_close_state=account_close_state,
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
        "account_contamination": account_contamination,
        "account_state": account_state,
        "account_close_state": account_close_state,
        "source_backed_import_ready_metadata": _source_backed_import_ready_metadata(
            target=target,
            source_activity=source_activity,
            account_close_state=account_close_state,
            runtime_ledger=runtime_ledger,
        ),
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
            "evidence_collection_ok": not evidence_collection_blockers,
            "canary_collection_authorized": bool(
                target.get("canary_collection_authorized")
            )
            and not evidence_collection_blockers,
            "capital_promotion_allowed": False,
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


def _database_unavailable_target_audit(
    *,
    raw_target: Mapping[str, Any],
    probe: Mapping[str, object],
    generated_at: datetime,
    lookback_hours: int,
    error_source: str,
    error: BaseException,
) -> dict[str, object]:
    target = _target_identity(raw_target, probe=probe)
    window_start, window_end = _target_window(
        target,
        generated_at=generated_at,
        lookback_hours=lookback_hours,
    )
    source_blocker = _paper_route_audit_error_source_blocker(error_source)
    blockers = _unique_text_items(
        [
            PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER,
            source_blocker,
            "source_decisions_missing",
            "source_executions_missing",
            "source_tca_missing",
            "runtime_ledger_bucket_missing",
            "runtime_ledger_evidence_grade_bucket_missing",
            "hypothesis_window_missing",
            "promotion_decision_missing",
        ]
    )
    error_payload = _paper_route_audit_error_payload(
        error_source=error_source,
        error=error,
    )
    source_activity = {
        "strategy_name": _safe_text(target.get("strategy_name")),
        "strategy_lookup_names": [
            str(item)
            for item in _as_sequence(target.get("strategy_lookup_names"))
            if str(item).strip()
        ],
        "account_label": _safe_text(target.get("account_label")),
        "symbols": _target_probe_symbols(target, probe),
        "lineage_required": _target_requires_source_lineage(target),
        "expected_candidate_id": _safe_text(target.get("candidate_id")),
        "expected_hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "raw_decision_count": 0,
        "lineage_matched_decision_count": 0,
        "lineage_blockers": [source_blocker],
        "decision_count": 0,
        "execution_count": 0,
        "filled_execution_count": 0,
        "order_event_count": 0,
        "fill_order_event_count": 0,
        "complete_fill_order_event_count": 0,
        "tca_sample_count": 0,
        "last_decision_at": None,
        "last_execution_at": None,
        "last_order_event_at": None,
        "last_tca_at": None,
        "missing": True,
        "missing_reasons": [
            PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER,
            source_blocker,
            "source_decisions_missing",
            "source_executions_missing",
            "source_tca_missing",
        ],
        "db_load_error": error_payload,
    }
    account_contamination = {
        "schema_version": "torghut.paper-route-account-contamination-audit.v1",
        "scope": "target_window_account_symbol_order_events",
        "account_label": _safe_text(target.get("account_label")),
        "symbols": _target_probe_symbols(target, probe),
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "contaminated": False,
        "unlinked_order_event_count": 0,
        "client_order_id_count": 0,
        "sample_client_order_ids": [],
        "symbol_counts": {},
        "event_type_counts": {},
        "status_counts": {},
        "last_event_at": None,
        "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
        "db_load_error": error_payload,
    }
    account_state = {
        "schema_version": "torghut.paper-route-account-window-start-snapshot-audit.v1",
        "scope": "account_position_snapshot_at_runtime_window_start",
        "account_label": _safe_text(target.get("account_label")),
        "symbols": _target_probe_symbols(target, probe),
        "generated_at": _isoformat(generated_at),
        "window_start": _isoformat(window_start),
        "required": False,
        "snapshot_id": None,
        "snapshot_as_of": None,
        "snapshot_offset_seconds": None,
        "snapshot_source": None,
        "flat": None,
        "position_count": 0,
        "target_symbol_position_count": 0,
        "non_target_symbol_position_count": 0,
        "gross_position_market_value": "0",
        "sample_positions": [],
        "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
        "state": "database_unavailable",
        "db_load_error": error_payload,
    }
    return {
        "target": target,
        "window": {
            "start": _isoformat(window_start),
            "end": _isoformat(window_end),
        },
        "source_activity": source_activity,
        "account_contamination": account_contamination,
        "account_state": account_state,
        "account_close_state": {
            "schema_version": "torghut.paper-route-account-window-close-snapshot-audit.v1",
            "scope": "account_position_snapshot_after_runtime_window_close",
            "account_label": _safe_text(target.get("account_label")),
            "symbols": _target_probe_symbols(target, probe),
            "generated_at": _isoformat(generated_at),
            "window_end": _isoformat(window_end),
            "required": generated_at >= window_end,
            "state": "database_unavailable",
            "flat": None,
            "zero_open_position_evidence": False,
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
            "db_load_error": error_payload,
        },
        "source_backed_import_ready_metadata": {
            "schema_version": "torghut.paper-route-source-backed-import-ready.v1",
            "ready": False,
            "synthetic_pnl_used": False,
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
        },
        "rejected_signal_activity": {
            "event_count": 0,
            "blocking_reasons": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER],
            "db_load_error": error_payload,
        },
        "runtime_ledger": {
            "bucket_count": 0,
            "evidence_grade_bucket_count": 0,
            "non_evidence_grade_bucket_count": 0,
            "returned_bucket_count": 0,
            "query_limit": RUNTIME_LEDGER_SUMMARY_ROW_LIMIT,
            "filled_notional": "0",
            "net_strategy_pnl_after_costs": "0",
            "closed_trade_count": 0,
            "open_position_count": 0,
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
            "db_load_error": error_payload,
        },
        "hypothesis_windows": {
            "window_count": 0,
            "decision_count": 0,
            "trade_count": 0,
            "order_count": 0,
            "market_session_count": 0,
            "latest_window_ended_at": None,
            "evidence_provenance_counts": {},
            "evidence_maturity_counts": {},
            "db_row_refs": [],
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
            "db_load_error": error_payload,
        },
        "promotion_decisions": {
            "decision_count": 0,
            "allowed_count": 0,
            "latest": None,
            "db_row_refs": [],
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
            "db_load_error": error_payload,
        },
        "readiness": {
            "state": "evidence_collection_blocked",
            "promotion_allowed": bool(target.get("promotion_allowed")),
            "final_promotion_allowed": bool(target.get("final_promotion_allowed")),
            "blockers": blockers,
            "evidence_collection_blockers": blockers,
            "promotion_authority": {
                "allowed": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "source_promotion_allowed": bool(
                    target.get("source_promotion_allowed")
                ),
                "source_final_promotion_allowed": bool(
                    target.get("source_final_promotion_allowed")
                ),
            },
        },
        "db_load_error": error_payload,
    }


def _target_audit_fail_closed(
    session: Session,
    *,
    raw_target: Mapping[str, Any],
    probe: Mapping[str, object],
    generated_at: datetime,
    lookback_hours: int,
    error_source: str,
) -> dict[str, object]:
    try:
        return _target_audit(
            session,
            raw_target=raw_target,
            probe=probe,
            generated_at=generated_at,
            lookback_hours=lookback_hours,
            error_source=error_source,
        )
    except SQLAlchemyError as exc:
        logger.warning(
            "Paper-route evidence audit degraded source=%s error=%s",
            error_source,
            exc,
        )
        _rollback_paper_route_audit_session(session)
        return _database_unavailable_target_audit(
            raw_target=raw_target,
            probe=probe,
            generated_at=generated_at,
            lookback_hours=lookback_hours,
            error_source=error_source,
            error=exc,
        )


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
            for reason in _as_sequence(
                _as_mapping(audit.get("source_activity")).get("missing_reasons")
            )
            if str(reason).strip()
        }
    )
    rejected_signal_reasons = sorted(
        {
            str(reason).strip()
            for audit in next_target_audits
            for reason in _as_sequence(
                _as_mapping(audit.get("rejected_signal_activity")).get(
                    "blocking_reasons"
                )
            )
            if str(reason).strip()
            and _rejected_signal_reasons_actionable(
                _as_mapping(audit.get("source_activity"))
            )
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
    account_contamination_blockers = sorted(
        {
            str(blocker).strip()
            for audit in next_target_audits
            for blocker in _as_sequence(
                _as_mapping(audit.get("account_contamination")).get("blockers")
            )
            if str(blocker).strip()
        }
    )
    account_state_blockers = sorted(
        {
            str(blocker).strip()
            for audit in next_target_audits
            for blocker in _as_sequence(
                _as_mapping(audit.get("account_state")).get("blockers")
            )
            if str(blocker).strip()
        }
    )
    account_close_blockers = sorted(
        {
            str(blocker).strip()
            for audit in next_target_audits
            if _target_is_hpairs(_as_mapping(audit.get("target")))
            and not bool(_as_mapping(audit.get("source_activity")).get("missing"))
            for blocker in _as_sequence(
                _as_mapping(audit.get("account_close_state")).get("blockers")
            )
            if str(blocker).strip()
        }
    )
    source_lifecycle_blockers = sorted(
        {
            str(blocker).strip()
            for audit in next_target_audits
            if _target_is_hpairs(_as_mapping(audit.get("target")))
            and not bool(_as_mapping(audit.get("source_activity")).get("missing"))
            for blocker in _as_sequence(
                _as_mapping(audit.get("source_activity")).get("source_lifecycle_blockers")
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
    targets_with_zero_open_position_evidence = sum(
        int(bool(_as_mapping(audit.get("account_close_state")).get("zero_open_position_evidence")))
        for audit in next_target_audits
    )
    targets_with_source_backed_import_ready = sum(
        int(bool(_as_mapping(audit.get("source_backed_import_ready_metadata")).get("ready")))
        for audit in next_target_audits
    )
    import_ready = bool(session_readiness.get("import_ready"))
    session_state = _safe_text(session_readiness.get("state")) or "unknown"
    blockers: list[str]
    if source_plan_target_count <= 0:
        state = "paper_probation_import_plan_missing"
        next_action = "repair_runtime_ledger_paper_probation_import_plan"
        blockers = ["paper_probation_import_plan_missing", "paper_route_target_missing"]
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
    elif account_contamination_blockers:
        state = "import_due_account_contamination_detected"
        next_action = "isolate_paper_account_or_discard_contaminated_window"
        blockers = account_contamination_blockers
    elif account_state_blockers:
        state = "import_due_account_state_not_clean"
        next_action = "reset_paper_account_or_discard_contaminated_window"
        blockers = account_state_blockers
    elif targets_with_source_activity < current_target_count:
        state = "import_due_source_activity_missing"
        next_action = "inspect_paper_route_source_activity_before_import"
        blockers = [
            "paper_route_source_activity_missing",
            *source_missing_reasons,
            *rejected_signal_reasons,
        ]
    elif source_lifecycle_blockers:
        state = "import_due_source_lifecycle_incomplete"
        next_action = "repair_paper_route_order_fill_close_lifecycle"
        blockers = source_lifecycle_blockers
    elif account_close_blockers:
        state = "import_due_flatten_handoff_missing"
        next_action = "run_paper_account_flatten_and_persist_position_snapshot"
        blockers = account_close_blockers
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
            "rejected_signal_diagnostic_reasons": rejected_signal_reasons,
            "source_activity_to_runtime_ledger_blockers": (
                source_runtime_ledger_blockers
            ),
            "account_contamination_blockers": account_contamination_blockers,
            "account_state_blockers": account_state_blockers,
            "account_close_blockers": account_close_blockers,
            "source_lifecycle_blockers": source_lifecycle_blockers,
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
            "targets_with_zero_open_position_evidence": targets_with_zero_open_position_evidence,
            "targets_with_source_backed_import_ready": targets_with_source_backed_import_ready,
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
        account_contamination = _as_mapping(audit.get("account_contamination"))
        account_state = _as_mapping(audit.get("account_state"))
        rejected_signal_activity = _as_mapping(audit.get("rejected_signal_activity"))
        account_close_state = _as_mapping(audit.get("account_close_state"))
        runtime_ledger = _as_mapping(audit.get("runtime_ledger"))
        promotion_decisions = _as_mapping(audit.get("promotion_decisions"))

        blockers = _unique_text_items(
            [
                *(
                    _unique_text_items(source_activity.get("missing_reasons"))
                    if bool(source_activity.get("missing"))
                    else []
                ),
                *(
                    _unique_text_items(rejected_signal_activity.get("blocking_reasons"))
                    if _rejected_signal_reasons_actionable(source_activity)
                    else []
                ),
                *_unique_text_items(account_contamination.get("blockers")),
                *_unique_text_items(account_state.get("blockers")),
                *(
                    _unique_text_items(source_activity.get("source_lifecycle_blockers"))
                    if _target_is_hpairs(target) and not bool(source_activity.get("missing"))
                    else []
                ),
                *(
                    _unique_text_items(account_close_state.get("blockers"))
                    if _target_is_hpairs(target) and not bool(source_activity.get("missing"))
                    else []
                ),
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
                "account_contamination": {
                    "contaminated": bool(account_contamination.get("contaminated")),
                    "unlinked_order_event_count": _safe_int(
                        account_contamination.get("unlinked_order_event_count")
                    ),
                    "client_order_id_count": _safe_int(
                        account_contamination.get("client_order_id_count")
                    ),
                    "sample_client_order_ids": _unique_text_items(
                        account_contamination.get("sample_client_order_ids")
                    ),
                    "last_event_at": _safe_text(
                        account_contamination.get("last_event_at")
                    ),
                },
                "account_state": {
                    "state": _safe_text(account_state.get("state")),
                    "required": bool(account_state.get("required")),
                    "flat": (
                        account_state.get("flat")
                        if isinstance(account_state.get("flat"), bool)
                        else None
                    ),
                    "generated_at": _safe_text(account_state.get("generated_at")),
                    "snapshot_id": _safe_text(account_state.get("snapshot_id")),
                    "snapshot_as_of": _safe_text(account_state.get("snapshot_as_of")),
                    "snapshot_source": _safe_text(account_state.get("snapshot_source")),
                    "position_count": _safe_int(account_state.get("position_count")),
                    "target_symbol_position_count": _safe_int(
                        account_state.get("target_symbol_position_count")
                    ),
                    "non_target_symbol_position_count": _safe_int(
                        account_state.get("non_target_symbol_position_count")
                    ),
                    "gross_position_market_value": _safe_text(
                        account_state.get("gross_position_market_value")
                    ),
                    "sample_positions": [
                        _as_mapping(item)
                        for item in _as_sequence(account_state.get("sample_positions"))
                    ],
                },
                "account_close_state": {
                    "state": _safe_text(account_close_state.get("state")),
                    "required": bool(account_close_state.get("required")),
                    "flat": (
                        account_close_state.get("flat")
                        if isinstance(account_close_state.get("flat"), bool)
                        else None
                    ),
                    "zero_open_position_evidence": bool(
                        account_close_state.get("zero_open_position_evidence")
                    ),
                    "snapshot_id": _safe_text(account_close_state.get("snapshot_id")),
                    "snapshot_as_of": _safe_text(account_close_state.get("snapshot_as_of")),
                    "position_count": _safe_int(account_close_state.get("position_count")),
                    "target_symbol_position_count": _safe_int(
                        account_close_state.get("target_symbol_position_count")
                    ),
                    "sample_positions": [
                        _as_mapping(item)
                        for item in _as_sequence(account_close_state.get("sample_positions"))
                    ],
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


def _target_audits_have_material_runtime_window_evidence(
    target_audits: Sequence[Mapping[str, object]],
) -> bool:
    counts = _runtime_window_target_counts(target_audits)
    return any(
        counts[key] > 0
        for key in (
            "source_activity",
            "rejected_signal_activity",
            "runtime_ledger",
            "evidence_grade_runtime_ledger",
            "promotion_decision",
        )
    )


def _next_paper_route_target_summaries(
    targets: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for target in targets:
        strategy_name = _safe_text(target.get("strategy_name"))
        runtime_strategy_name = _safe_text(target.get("runtime_strategy_name"))
        source_decision_readiness = _as_mapping(target.get("source_decision_readiness"))
        summaries.append(
            {
                "hypothesis_id": _safe_text(target.get("hypothesis_id")),
                "candidate_id": _safe_text(target.get("candidate_id")),
                "strategy_family": _safe_text(target.get("strategy_family")),
                "strategy_name": strategy_name,
                "runtime_strategy_name": runtime_strategy_name,
                "runtime_strategy_id": runtime_strategy_name or strategy_name,
                "account_label": _safe_text(target.get("account_label")),
                "source_kind": _safe_text(target.get("source_kind")),
                "symbols": _unique_text_items(target.get("paper_route_probe_symbols")),
                "symbol_actions": dict(
                    _as_mapping(target.get("paper_route_probe_symbol_actions"))
                ),
                "pair_balance_required": bool(
                    target.get("paper_route_probe_pair_balance_required")
                ),
                "pair_balance_state": _safe_text(
                    target.get("paper_route_probe_pair_balance_state")
                )
                or "not_required",
                "session_start": _safe_text(target.get("window_start")),
                "session_end": _safe_text(target.get("window_end")),
                "next_session_max_notional": _safe_text(
                    target.get("paper_route_probe_next_session_max_notional")
                )
                or "0",
                "bounded_evidence_collection_authorized": bool(
                    target.get("bounded_evidence_collection_authorized")
                ),
                "evidence_collection_ok": bool(target.get("evidence_collection_ok")),
                "canary_collection_authorized": bool(
                    target.get("canary_collection_authorized")
                ),
                "bounded_evidence_collection_max_notional": _safe_text(
                    target.get("bounded_evidence_collection_max_notional")
                )
                or "0",
                "bounded_evidence_collection_blockers": _unique_text_items(
                    target.get("bounded_evidence_collection_blockers")
                ),
                "proof_mode": _safe_text(target.get("proof_mode")) or "probation",
                "capital_promotion_allowed": bool(
                    target.get("capital_promotion_allowed")
                ),
                "source_collection_authorized": bool(
                    target.get("source_collection_authorized")
                ),
                "source_decision_mode": _safe_text(target.get("source_decision_mode")),
                "profit_proof_eligible": bool(target.get("profit_proof_eligible")),
                "import_ready": bool(target.get("paper_route_session_import_ready")),
                "import_blockers": _unique_text_items(
                    target.get("paper_route_session_import_blockers")
                ),
                "promotion_allowed": bool(target.get("promotion_allowed")),
                "final_promotion_allowed": bool(target.get("final_promotion_allowed")),
                "promotion_blocked": not bool(target.get("final_promotion_allowed")),
                "promotion_gate": _safe_text(target.get("promotion_gate")),
                "source_decision_ready": bool(source_decision_readiness.get("ready")),
                "source_decision_blockers": _unique_text_items(
                    source_decision_readiness.get("blockers")
                ),
            }
        )
    return summaries


def _runtime_ledger_proof_packet_handoff(
    *,
    next_targets: Mapping[str, object],
    runtime_window_import_audit: Mapping[str, object],
) -> dict[str, object]:
    proof_policy = runtime_ledger_proof_policy_from_env()
    runtime_import_handoff = _as_mapping(
        next_targets.get("runtime_window_import_handoff")
    )
    session_readiness = _as_mapping(next_targets.get("session_readiness"))
    import_ready = bool(
        session_readiness.get("import_ready")
        or runtime_import_handoff.get("import_ready")
        or runtime_window_import_audit.get("import_ready")
    )
    session_import_blockers = _unique_text_items(
        session_readiness.get("import_blockers")
    )
    import_blockers = session_import_blockers + [
        blocker
        for blocker in _unique_text_items(runtime_import_handoff.get("import_blockers"))
        if blocker not in session_import_blockers
    ]
    import_blockers.extend(
        blocker
        for blocker in _unique_text_items(runtime_window_import_audit.get("blockers"))
        if blocker not in import_blockers
    )
    smoke_targets = proof_policy.target_payload("smoke")
    authority_targets = proof_policy.target_payload("authority")
    smoke_threshold_args = [
        "--proof-mode",
        "smoke",
        "--min-runtime-ledger-net-pnl",
        str(smoke_targets["min_runtime_ledger_net_pnl_after_costs"]),
        "--min-runtime-ledger-daily-net-pnl",
        str(smoke_targets["min_runtime_ledger_daily_net_pnl_after_costs"]),
        "--min-runtime-ledger-trading-days",
        str(smoke_targets["min_runtime_ledger_trading_days"]),
    ]
    authority_threshold_args = [
        "--proof-mode",
        "authority",
        "--min-runtime-ledger-net-pnl",
        str(authority_targets["min_runtime_ledger_net_pnl_after_costs"]),
        "--min-runtime-ledger-daily-net-pnl",
        str(authority_targets["min_runtime_ledger_daily_net_pnl_after_costs"]),
        "--min-runtime-ledger-trading-days",
        str(authority_targets["min_runtime_ledger_trading_days"]),
    ]
    service_args = [
        "--status-service-base-url",
        "$TORGHUT_LIVE_SERVICE_BASE_URL",
        "--paper-route-service-base-url",
        "$TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL",
        "--completion-service-base-url",
        "$TORGHUT_LIVE_SERVICE_BASE_URL",
    ]
    base_args = [
        "uv",
        "run",
        "--frozen",
        "python",
        "scripts/assemble_runtime_ledger_proof_packet.py",
        *service_args,
        *smoke_threshold_args,
        "--output-file",
        RUNTIME_LEDGER_PROOF_PACKET_OUTPUT_FILE,
    ]
    authority_args = [
        "uv",
        "run",
        "--frozen",
        "python",
        "scripts/assemble_runtime_ledger_proof_packet.py",
        *service_args,
        *authority_threshold_args,
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
        "default_proof_mode": "smoke",
        "evidence_collection_ok": bool(next_targets.get("evidence_collection_ok")),
        "canary_collection_authorized": bool(
            next_targets.get("canary_collection_authorized")
        ),
        "capital_promotion_allowed": False,
        "final_promotion_allowed": False,
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
            **authority_targets,
        },
        "runtime_window": {
            "import_ready": import_ready,
            "import_blockers": sorted(dict.fromkeys(import_blockers)),
            "health_gate": _as_mapping(
                next_targets.get("runtime_window_import_health_gate")
            ),
            "source_decision_readiness": _as_mapping(
                next_targets.get("source_decision_readiness")
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


def _deferred_runtime_window_target_audits(
    targets: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    audits: list[dict[str, object]] = []
    for target in targets:
        audits.append(
            {
                "target": dict(target),
                "source_activity": {
                    "missing": True,
                    "missing_reasons": [
                        "runtime_window_import_audit_deferred_until_import_ready"
                    ],
                },
                "rejected_signal_activity": {
                    "event_count": 0,
                    "blocking_reasons": [],
                },
                "account_contamination": {
                    "contaminated": False,
                    "blockers": [],
                },
                "account_state": {
                    "blockers": [],
                },
                "account_close_state": {
                    "blockers": [],
                    "zero_open_position_evidence": False,
                },
                "source_backed_import_ready_metadata": {
                    "ready": False,
                    "synthetic_pnl_used": False,
                    "blockers": ["runtime_window_import_audit_deferred_until_import_ready"],
                },
                "runtime_ledger": {
                    "bucket_count": 0,
                    "evidence_grade_bucket_count": 0,
                    "blockers": [],
                },
                "promotion_decisions": {
                    "decision_count": 0,
                },
            }
        )
    return audits


def _runtime_window_import_plan_for_audit(
    *,
    latest_closed_targets: Mapping[str, Any],
    next_targets: Mapping[str, Any],
) -> Mapping[str, Any]:
    latest_closed_readiness = _as_mapping(
        latest_closed_targets.get("session_readiness")
    )
    if (
        bool(latest_closed_readiness.get("import_ready"))
        and _safe_int(latest_closed_targets.get("target_count")) > 0
    ):
        return latest_closed_targets
    return next_targets


def _targets_have_explicit_window_bounds(
    targets: Sequence[Mapping[str, object]],
) -> bool:
    return any(
        _parse_datetime(target.get("window_start")) is not None
        and _parse_datetime(target.get("window_end")) is not None
        for target in targets
    )


def build_paper_route_target_plan_payload(
    session: Session,
    *,
    live_submission_gate: Mapping[str, Any],
    route_reacquisition_book: Mapping[str, Any],
    generated_at: datetime | None = None,
    target_limit: int = DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    include_runtime_window_import_audit: bool | None = True,
) -> dict[str, object]:
    """Build the lightweight runtime-window target-plan payload."""

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
    next_targets = _next_paper_route_runtime_window_targets(
        session=session,
        targets=targets,
        probe=probe,
        live_submission_gate=live_submission_gate,
        generated_at=resolved_generated_at,
    )
    closed_window_start, closed_window_end = (
        _latest_closed_regular_equities_session_window(resolved_generated_at)
    )
    latest_closed_targets = _next_paper_route_runtime_window_targets(
        session=session,
        targets=targets,
        probe=probe,
        live_submission_gate=live_submission_gate,
        generated_at=resolved_generated_at,
        require_clean_pre_session=False,
        window_start=closed_window_start,
        window_end=closed_window_end,
        purpose="latest_closed_session_paper_route_runtime_window_import",
    )
    source_targets = _next_paper_route_runtime_window_targets(
        session=session,
        targets=targets,
        probe=probe,
        live_submission_gate=live_submission_gate,
        generated_at=resolved_generated_at,
        require_clean_pre_session=False,
    )
    runtime_window_import_plan = _runtime_window_import_plan_for_audit(
        latest_closed_targets=latest_closed_targets,
        next_targets=next_targets,
    )
    runtime_import_readiness = _as_mapping(
        runtime_window_import_plan.get("session_readiness")
    )
    runtime_import_handoff = _as_mapping(
        runtime_window_import_plan.get("runtime_window_import_handoff")
    )
    runtime_import_ready = bool(
        runtime_import_readiness.get("import_ready")
        or runtime_import_handoff.get("import_ready")
    )
    run_full_runtime_import_audit = (
        runtime_import_ready
        if include_runtime_window_import_audit is None
        else include_runtime_window_import_audit
    )
    runtime_window_import_audit_mode = (
        "full" if run_full_runtime_import_audit else "deferred_until_import_ready"
    )
    if run_full_runtime_import_audit:
        source_target_audits = [
            _target_audit_fail_closed(
                session,
                raw_target=target,
                probe=probe,
                generated_at=resolved_generated_at,
                lookback_hours=DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
                error_source="target_plan_source_target_audit",
            )
            for target in targets
        ]
        runtime_window_import_target_audits = [
            _target_audit_fail_closed(
                session,
                raw_target=target,
                probe=probe,
                generated_at=resolved_generated_at,
                lookback_hours=DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
                error_source="target_plan_runtime_window_target_audit",
            )
            for target in _as_mapping_items(runtime_window_import_plan.get("targets"))
        ]
    else:
        source_target_audits = _deferred_runtime_window_target_audits(targets)
        runtime_window_import_target_audits = _deferred_runtime_window_target_audits(
            _as_mapping_items(runtime_window_import_plan.get("targets"))
        )
    runtime_window_import_audit = _runtime_window_import_audit(
        next_targets=runtime_window_import_plan,
        target_audits=source_target_audits,
        next_target_audits=runtime_window_import_target_audits,
    )
    effective_target_plan: Mapping[str, Any] = {}
    for candidate_plan in (
        next_targets,
        source_targets,
        runtime_window_import_plan,
        plan,
    ):
        if _as_mapping_items(candidate_plan.get("targets")):
            effective_target_plan = candidate_plan
            break
    effective_targets = _as_mapping_items(effective_target_plan.get("targets"))
    effective_skipped_targets = _as_mapping_items(
        effective_target_plan.get("skipped_targets")
    )
    effective_target_count = max(
        _safe_int(effective_target_plan.get("target_count")),
        len(effective_targets),
    )
    effective_skipped_target_count = max(
        _safe_int(effective_target_plan.get("skipped_target_count")),
        len(effective_skipped_targets),
    )
    return {
        "schema_version": PAPER_ROUTE_TARGET_PLAN_PAYLOAD_SCHEMA_VERSION,
        "generated_at": _isoformat(resolved_generated_at),
        "source": "paper_route_target_plan_endpoint",
        "purpose": _safe_text(effective_target_plan.get("purpose"))
        or "next_session_paper_route_runtime_window_evidence_collection",
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "target_count": effective_target_count,
        "skipped_target_count": effective_skipped_target_count,
        "targets": effective_targets,
        "skipped_targets": effective_skipped_targets,
        "runtime_window_import_audit_mode": runtime_window_import_audit_mode,
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
        "runtime_window_import_plan": runtime_window_import_plan,
        "runtime_window_import_audit": runtime_window_import_audit,
        "source_runtime_window_import_plan": source_targets,
        "latest_closed_paper_route_runtime_window_targets": latest_closed_targets,
        "next_paper_route_runtime_window_targets": next_targets,
        "summary": {
            "source_target_count": len(targets),
            "next_runtime_window_target_count": _safe_int(
                next_targets.get("target_count")
            ),
            "runtime_window_import_target_count": _safe_int(
                runtime_window_import_plan.get("target_count")
            ),
            "runtime_window_import_plan_purpose": _safe_text(
                runtime_window_import_plan.get("purpose")
            ),
            "latest_closed_runtime_window_target_count": _safe_int(
                latest_closed_targets.get("target_count")
            ),
            "source_runtime_window_target_count": _safe_int(
                source_targets.get("target_count")
            ),
            "runtime_window_import_audit_state": _safe_text(
                runtime_window_import_audit.get("state")
            ),
            "runtime_window_import_audit_mode": runtime_window_import_audit_mode,
            "runtime_window_import_audit_blockers": _unique_text_items(
                runtime_window_import_audit.get("blockers")
            ),
            "skipped_target_count": _safe_int(next_targets.get("skipped_target_count")),
            "promotion_authority": {
                "allowed": False,
                "reason": "paper_route_target_plan_observability_only",
                "blockers": ["live_runtime_ledger_required"],
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
        _target_audit_fail_closed(
            session,
            raw_target=target,
            probe=probe,
            generated_at=resolved_generated_at,
            lookback_hours=lookback_hours,
            error_source="paper_route_source_target_audit",
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
    closed_window_start, closed_window_end = (
        _latest_closed_regular_equities_session_window(resolved_generated_at)
    )
    latest_closed_targets = _next_paper_route_runtime_window_targets(
        session=session,
        targets=targets,
        probe=probe,
        live_submission_gate=live_submission_gate,
        generated_at=resolved_generated_at,
        require_clean_pre_session=False,
        window_start=closed_window_start,
        window_end=closed_window_end,
        purpose="latest_closed_session_paper_route_runtime_window_import",
    )
    next_target_audits = [
        _target_audit_fail_closed(
            session,
            raw_target=target,
            probe=probe,
            generated_at=resolved_generated_at,
            lookback_hours=lookback_hours,
            error_source="paper_route_next_target_audit",
        )
        for target in _as_mapping_items(next_targets.get("targets"))
    ]
    runtime_window_import_plan = next_targets
    runtime_window_import_target_audits = next_target_audits
    latest_closed_runtime_window_import_plan = _runtime_window_import_plan_for_audit(
        latest_closed_targets=latest_closed_targets,
        next_targets=next_targets,
    )
    if latest_closed_runtime_window_import_plan is latest_closed_targets:
        targets_have_explicit_window_bounds = _targets_have_explicit_window_bounds(
            targets
        )
        latest_closed_target_audits = [
            _target_audit_fail_closed(
                session,
                raw_target=target,
                probe=probe,
                generated_at=resolved_generated_at,
                lookback_hours=lookback_hours,
                error_source="paper_route_runtime_window_import_target_audit",
            )
            for target in _as_mapping_items(latest_closed_targets.get("targets"))
        ]
        if (
            not targets_have_explicit_window_bounds
            or _target_audits_have_material_runtime_window_evidence(
                latest_closed_target_audits
            )
        ):
            runtime_window_import_plan = latest_closed_targets
            runtime_window_import_target_audits = latest_closed_target_audits
    runtime_window_import_audit = _runtime_window_import_audit(
        next_targets=runtime_window_import_plan,
        target_audits=target_audits,
        next_target_audits=runtime_window_import_target_audits,
    )
    next_target_counts = _runtime_window_target_counts(next_target_audits)
    runtime_window_import_target_counts = _runtime_window_target_counts(
        runtime_window_import_target_audits
    )
    proof_packet_handoff = _runtime_ledger_proof_packet_handoff(
        next_targets=runtime_window_import_plan,
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
        "latest_closed_paper_route_runtime_window_targets": latest_closed_targets,
        "runtime_window_import_plan": runtime_window_import_plan,
        "next_runtime_window_target_audits": next_target_audits,
        "runtime_window_import_target_audits": runtime_window_import_target_audits,
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
            "next_runtime_window_target_count": _safe_int(
                next_targets.get("target_count")
            ),
            "next_runtime_window_selected_target_count": len(next_target_audits),
            "next_runtime_window_target_with_source_activity_count": (
                next_target_counts["source_activity"]
            ),
            "next_runtime_window_target_with_rejected_signal_activity_count": (
                next_target_counts["rejected_signal_activity"]
            ),
            "next_runtime_window_target_with_runtime_ledger_count": (
                next_target_counts["runtime_ledger"]
            ),
            "next_runtime_window_target_with_evidence_grade_runtime_ledger_count": (
                next_target_counts["evidence_grade_runtime_ledger"]
            ),
            "next_runtime_window_target_with_promotion_decision_count": (
                next_target_counts["promotion_decision"]
            ),
            "runtime_window_import_target_count": _safe_int(
                runtime_window_import_plan.get("target_count")
            ),
            "runtime_window_import_selected_target_count": len(
                runtime_window_import_target_audits
            ),
            "runtime_window_import_target_with_source_activity_count": (
                runtime_window_import_target_counts["source_activity"]
            ),
            "runtime_window_import_target_with_rejected_signal_activity_count": (
                runtime_window_import_target_counts["rejected_signal_activity"]
            ),
            "runtime_window_import_target_with_runtime_ledger_count": (
                runtime_window_import_target_counts["runtime_ledger"]
            ),
            "runtime_window_import_target_with_evidence_grade_runtime_ledger_count": (
                runtime_window_import_target_counts["evidence_grade_runtime_ledger"]
            ),
            "runtime_window_import_target_with_promotion_decision_count": (
                runtime_window_import_target_counts["promotion_decision"]
            ),
            "next_runtime_window_import_next_action": runtime_window_import_audit[
                "next_action"
            ],
            "next_paper_route_targets": _next_paper_route_target_summaries(
                _as_mapping_items(next_targets.get("targets"))
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
    "PAPER_ROUTE_TARGET_PLAN_PAYLOAD_SCHEMA_VERSION",
    "PAPER_ROUTE_RUNTIME_WINDOW_IMPORT_AUDIT_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION",
    "build_paper_route_evidence_audit",
    "build_paper_route_target_plan_payload",
]
