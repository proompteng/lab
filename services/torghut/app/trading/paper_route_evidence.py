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

from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
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
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
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
PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT = 100
PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT = 25
MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS = 168
MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT = 20
PAPER_ROUTE_EVIDENCE_QUERY_TIMEOUT_MS = 5000
US_EQUITIES_TIMEZONE = "America/New_York"
US_EQUITIES_OPEN = time(hour=9, minute=30)
US_EQUITIES_CLOSE = time(hour=16, minute=0)
logger = logging.getLogger(__name__)
PROMOTION_ONLY_READINESS_BLOCKERS = frozenset(
    {
        "paper_probation_evidence_collection_only",
        "paper_route_evidence_audit_stripped_promotion_authority",
        "paper_route_runtime_ledger_import_pending",
        "bounded_paper_route_evidence_collection_only",
        "runtime_ledger_source_collection_only",
        "runtime_ledger_source_window_evidence_pending",
        "runtime_ledger_stage_not_live",
        "live_runtime_ledger_required",
        "runtime_ledger_bucket_missing",
        "runtime_ledger_evidence_grade_bucket_missing",
        "hypothesis_window_missing",
        "promotion_decision_missing",
        "promotion_decision_not_allowed",
    }
)
CLEAN_WINDOW_BASELINE_SCHEMA_VERSION = "torghut.paper-route-clean-window-baseline.v1"
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
PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER = (
    "paper_route_target_account_audit_unavailable"
)
HPAIRS_ZERO_ACTIVITY_DIAGNOSTICS_SCHEMA_VERSION = (
    "torghut.hpairs-zero-activity-diagnostics.v1"
)
SOURCE_LINEAGE_OBSERVATION_SCHEMA_VERSION = (
    "torghut.paper-route-source-lineage-observation.v1"
)
SOURCE_ACTIVITY_ACCOUNT_DIAGNOSTICS_SCHEMA_VERSION = (
    "torghut.paper-route-source-activity-account-diagnostics.v1"
)
HPAIRS_CURRENT_COLLECTION_PREREQUISITE_BLOCKERS = frozenset(
    {
        "drift_checks_missing",
        "signal_lag_exceeded",
    }
)
PAPER_ROUTE_ACCOUNT_STATE_DISCARD_BLOCKERS = frozenset(
    {
        "paper_route_account_window_start_not_flat",
        "paper_route_account_window_start_positions_present",
        "paper_route_account_window_start_target_positions_present",
        "paper_route_account_window_start_non_target_positions_present",
    }
)
RUNTIME_LEDGER_SOURCE_COLLECTION_PENDING_BLOCKER = (
    "runtime_ledger_source_collection_pending"
)
RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND = (
    "runtime_ledger_source_collection_candidate"
)
RUNTIME_LEDGER_SOURCE_COLLECTION_HANDOFF = "runtime_ledger_source_collection_import"
RUNTIME_LEDGER_SOURCE_COLLECTION_SELECTED_BY = "runtime_ledger_source_collection"
RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS = (
    "runtime_ledger_source_collection_only",
    "live_runtime_ledger_required",
)


def _maybe_set_paper_route_audit_statement_timeout(session: Session) -> None:
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
        text(f"SET LOCAL statement_timeout = {PAPER_ROUTE_EVIDENCE_QUERY_TIMEOUT_MS}")
    )


def _target_account_audit_state(
    *,
    account_label: str | None,
    symbols: Sequence[str],
    window_start: datetime,
    window_end: datetime,
    audit_available: bool,
) -> dict[str, object]:
    blockers = (
        []
        if audit_available
        else [PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER]
    )
    return {
        "schema_version": "torghut.paper-route-target-account-audit.v1",
        "scope": "local_torghut_sim_paper_runtime_account_state",
        "state": "available" if audit_available else "unavailable",
        "account_label": account_label,
        "required_account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
        "symbols": [str(item).strip().upper() for item in symbols if str(item).strip()],
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "audit_available": audit_available,
        "blockers": blockers,
    }


def _account_pre_session_snapshot_audit_unavailable(
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
    return {
        "schema_version": "torghut.paper-route-account-pre-session-snapshot-audit.v1",
        "scope": "account_position_snapshot_before_runtime_window_start",
        "state": "target_account_audit_unavailable",
        "account_label": account_label,
        "symbols": sorted(symbol_filters),
        "generated_at": _isoformat(generated_at),
        "window_start": _isoformat(window_start),
        "required": required,
        "required_after": _isoformat(required_after),
        "snapshot_id": None,
        "snapshot_as_of": None,
        "snapshot_age_seconds": None,
        "snapshot_window_start_offset_seconds": None,
        "flat": None,
        "position_count": 0,
        "target_symbol_position_count": 0,
        "non_target_symbol_position_count": 0,
        "gross_position_market_value": "0",
        "sample_positions": [],
        "blockers": [],
        "source_audit_blockers": [PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER],
    }


def _account_clean_window_baseline_audit_unavailable(
    *,
    account_label: str | None,
    symbols: Sequence[str],
    generated_at: datetime,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    required_after = window_start - timedelta(
        seconds=PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS
    )
    return {
        "schema_version": CLEAN_WINDOW_BASELINE_SCHEMA_VERSION,
        "scope": "flat_account_baseline_for_bounded_paper_route_collection",
        "state": "target_account_audit_unavailable",
        "account_label": account_label,
        "symbols": [str(item).strip().upper() for item in symbols if str(item).strip()],
        "generated_at": _isoformat(generated_at),
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "required_after": _isoformat(required_after),
        "source": "local_torghut_sim_paper_runtime_account_state",
        "snapshot_id": None,
        "snapshot_as_of": None,
        "snapshot_source": None,
        "snapshot_offset_seconds": None,
        "flat": None,
        "source_auditable": False,
        "position_count": 0,
        "target_symbol_position_count": 0,
        "non_target_symbol_position_count": 0,
        "gross_position_market_value": "0",
        "sample_positions": [],
        "blockers": [PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER],
        "source_audit": {},
    }


def _account_contamination_audit_unavailable(
    *,
    account_label: str | None,
    symbols: Sequence[str],
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.paper-route-account-contamination-audit.v1",
        "scope": "target_window_account_symbol_order_events",
        "state": "target_account_audit_unavailable",
        "account_label": account_label,
        "symbols": [str(item).strip().upper() for item in symbols if str(item).strip()],
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "contaminated": None,
        "order_event_count": 0,
        "unlinked_order_event_count": 0,
        "foreign_linked_order_event_count": 0,
        "target_linked_order_event_count": 0,
        "client_order_id_count": 0,
        "sample_client_order_ids": [],
        "symbol_counts": {},
        "event_type_counts": {},
        "status_counts": {},
        "foreign_strategy_counts": {},
        "last_event_at": None,
        "reason": "target_account_audit_unavailable",
        "blockers": [],
        "sample_order_event_refs": [],
        "source_audit_blockers": [PAPER_ROUTE_TARGET_ACCOUNT_AUDIT_UNAVAILABLE_BLOCKER],
    }


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


def _strategy_name_for_decision(row: TradeDecision) -> str | None:
    return _safe_text(getattr(getattr(row, "strategy", None), "name", None))


def _source_lineage_observation(
    rows: Sequence[TradeDecision],
    *,
    candidate_id: str | None,
    hypothesis_id: str | None,
    strategy_filters: Sequence[str],
) -> dict[str, object]:
    observed_rows: list[TradeDecision] = []
    exact_rows: list[TradeDecision] = []
    candidate_match_rows: list[TradeDecision] = []
    hypothesis_match_rows: list[TradeDecision] = []
    candidate_values: set[str] = set()
    hypothesis_values: set[str] = set()
    observed_strategy_names: list[str] = []
    strategy_filter_set = {item for item in strategy_filters if item}
    strategy_mismatch_count = 0
    candidate_mismatch_count = 0
    for row in rows:
        row_candidate_values = _source_lineage_values(
            row.decision_json,
            SOURCE_LINEAGE_CANDIDATE_KEYS,
        )
        row_hypothesis_values = _source_lineage_values(
            row.decision_json,
            SOURCE_LINEAGE_HYPOTHESIS_KEYS,
        )
        candidate_values.update(row_candidate_values)
        hypothesis_values.update(row_hypothesis_values)
        candidate_matches = (
            candidate_id is not None and candidate_id in row_candidate_values
        )
        hypothesis_matches = (
            hypothesis_id is not None and hypothesis_id in row_hypothesis_values
        )
        if not candidate_matches and not hypothesis_matches:
            continue
        observed_rows.append(row)
        if candidate_matches:
            candidate_match_rows.append(row)
        if hypothesis_matches:
            hypothesis_match_rows.append(row)
        if _source_decision_lineage_matches(
            row,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
        ):
            exact_rows.append(row)
        elif hypothesis_matches and candidate_id is not None:
            candidate_mismatch_count += 1
        strategy_name = _strategy_name_for_decision(row)
        if strategy_name is not None and strategy_name not in observed_strategy_names:
            observed_strategy_names.append(strategy_name)
        if strategy_filter_set and strategy_name not in strategy_filter_set:
            strategy_mismatch_count += 1
    blockers: list[str] = []
    if observed_rows and not exact_rows:
        blockers.append("source_lineage_partial_match_only")
    if candidate_mismatch_count:
        blockers.append("source_candidate_lineage_mismatch_current_activity")
    if strategy_mismatch_count:
        blockers.append("source_strategy_filter_mismatch_current_activity")
    return {
        "schema_version": SOURCE_LINEAGE_OBSERVATION_SCHEMA_VERSION,
        "enabled": bool(candidate_id or hypothesis_id),
        "expected_candidate_id": candidate_id,
        "expected_hypothesis_id": hypothesis_id,
        "strategy_lookup_names": [item for item in strategy_filters if item],
        "observed_decision_count": len(observed_rows),
        "exact_match_decision_count": len(exact_rows),
        "candidate_match_decision_count": len(candidate_match_rows),
        "hypothesis_match_decision_count": len(hypothesis_match_rows),
        "partial_match_decision_count": max(0, len(observed_rows) - len(exact_rows)),
        "strategy_filter_mismatch_count": strategy_mismatch_count,
        "candidate_mismatch_count": candidate_mismatch_count,
        "decision_refs": [
            str(row.id) for row in observed_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
        ],
        "exact_decision_refs": [
            str(row.id) for row in exact_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
        ],
        "strategy_names": observed_strategy_names,
        "candidate_ids": sorted(candidate_values),
        "hypothesis_ids": sorted(hypothesis_values),
        "blockers": blockers,
    }


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


def _bounded_int(value: object, *, default: int, minimum: int, maximum: int) -> int:
    parsed = _safe_int(value)
    if parsed <= 0:
        parsed = default
    return max(minimum, min(parsed, maximum))


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


def _account_contamination_reason(
    *,
    unlinked_order_event_count: int,
    foreign_linked_order_event_count: int,
) -> str:
    if unlinked_order_event_count and foreign_linked_order_event_count:
        return "unlinked_and_foreign_account_order_events_present"
    if unlinked_order_event_count:
        return "unlinked_account_order_events_present"
    if foreign_linked_order_event_count:
        return "foreign_account_order_events_present"
    return "target_window_account_order_events_clean"


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


def _order_event_sample_ref(row: ExecutionOrderEvent) -> dict[str, object]:
    decision = row.trade_decision
    strategy_name = _safe_text(
        getattr(getattr(decision, "strategy", None), "name", None)
    )
    return {
        "event_fingerprint": _safe_text(row.event_fingerprint),
        "source_topic": _safe_text(row.source_topic),
        "source_partition": row.source_partition,
        "source_offset": row.source_offset,
        "event_ts": _isoformat(_order_event_activity_at(row)),
        "symbol": _safe_text(row.symbol),
        "alpaca_order_id": _safe_text(row.alpaca_order_id),
        "client_order_id": _safe_text(row.client_order_id),
        "event_type": _safe_text(row.event_type),
        "status": _safe_text(row.status),
        "trade_decision_id": row.trade_decision_id,
        "strategy_name": strategy_name,
    }


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


def _following_regular_equities_session_window(
    after_window_end: datetime,
) -> tuple[datetime, datetime]:
    """Return the next regular session after a discarded closed window."""

    zone = ZoneInfo(US_EQUITIES_TIMEZONE)
    candidate_date = after_window_end.astimezone(zone).date() + timedelta(days=1)
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


def _paper_route_collection_session_blockers(
    session_readiness: Mapping[str, object],
) -> list[str]:
    """Return blockers for submitting bounded paper collection in this window.

    Import readiness and collection readiness are intentionally not identical:
    an open window blocks import because it is not closed yet, but it is the
    only time a bounded live-paper collection target may submit. Before the
    open and after the close, report a machine-readable collection blocker
    instead of allowing ambiguous "ready" target state.
    """

    state = _safe_text(session_readiness.get("state")) or "unknown"
    if state == "collecting_session_evidence":
        return []
    if state == "waiting_for_session_open":
        return ["paper_route_session_window_not_open"]
    if state == "window_closed_settlement_pending":
        return ["paper_route_session_settlement_pending"]
    if state == "window_closed_import_ready":
        return ["paper_route_session_window_closed"]
    if state == "window_closed_import_blocked":
        blockers = [
            blocker
            for blocker in _unique_text_items(session_readiness.get("import_blockers"))
            if blocker != "paper_route_session_window_not_closed"
        ]
        return blockers or ["paper_route_session_window_closed"]
    return ["paper_route_session_state_unknown"]


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
    for key in (
        "strategy_family",
        "strategy_name",
        "runtime_strategy_name",
        "strategy_id",
    ):
        value = (_safe_text(target.get(key)) or "").lower().replace("-", "_")
        if "microbar_cross_sectional_pairs" in value:
            return True
    return False


def _target_requires_hpairs_round_trip_identity(target: Mapping[str, object]) -> bool:
    """Return whether a target is a bounded H-PAIRS collection handoff.

    Historical paper-probation imports can point at already-materialized buckets with
    legacy metadata. The stricter account/stage/runtime identity contract is for
    the bounded paper-route/live-paper collection handoff that will submit new
    TORGHUT_SIM source decisions.
    """

    if not _target_is_hpairs(target):
        return False
    source_kind = _safe_text(target.get("source_kind"))
    return (
        source_kind == "paper_route_probe_runtime_observed"
        or bool(target.get("bounded_evidence_collection_authorized"))
        or bool(target.get("canary_collection_authorized"))
    )


def _hpairs_round_trip_identity_blockers(target: Mapping[str, object]) -> list[str]:
    if not _target_requires_hpairs_round_trip_identity(target):
        return []
    blockers: list[str] = []
    if _safe_text(target.get("candidate_id")) is None:
        blockers.append("paper_route_hpairs_candidate_id_missing")
    if _safe_text(target.get("hypothesis_id")) is None:
        blockers.append("paper_route_hpairs_hypothesis_id_missing")
    account_label = _safe_text(target.get("account_label"))
    if account_label is None:
        blockers.append("paper_route_hpairs_account_label_missing")
    elif account_label != PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL:
        blockers.append("paper_route_hpairs_torghut_sim_account_required")
    observed_stage = (_safe_text(target.get("observed_stage")) or "").lower()
    if observed_stage != "paper":
        blockers.append("paper_route_hpairs_paper_stage_required")
    if (
        _safe_text(target.get("runtime_strategy_name")) is None
        and _safe_text(target.get("strategy_name")) is None
    ):
        blockers.append("paper_route_hpairs_runtime_strategy_name_missing")
    if _safe_text(target.get("source_kind")) is None:
        blockers.append("paper_route_hpairs_source_kind_missing")
    return blockers


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


def _paper_route_probe_symbol_quantities(
    target: Mapping[str, object],
    symbols: Sequence[str],
) -> dict[str, str]:
    normalized_symbols = [
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    ]
    quantities: dict[str, str] = {}
    for field in (
        "paper_route_probe_symbol_quantities",
        "target_symbol_quantities",
        "symbol_quantities",
    ):
        raw_quantities = _as_mapping(target.get(field))
        for symbol in normalized_symbols:
            if symbol in quantities:
                continue
            quantity = _safe_decimal(raw_quantities.get(symbol))
            if quantity > 0:
                quantities[symbol] = _decimal_text(quantity)

    fallback_quantity = Decimal("0")
    for field in (
        "paper_route_probe_target_quantity",
        "target_quantity",
        "qty",
        "quantity",
    ):
        fallback_quantity = _safe_decimal(target.get(field))
        if fallback_quantity > 0:
            break
    if fallback_quantity <= 0 and normalized_symbols:
        # The bounded source materializer requires an explicit quantity per leg.
        # H-PAIRS collection is capped independently by the target notional and
        # simple-pipeline risk clamps; use the minimum integer probe leg so the
        # materializer can create auditable source decisions instead of
        # silently producing a zero-decision packet.
        fallback_quantity = Decimal("1")

    if fallback_quantity > 0:
        fallback_text = _decimal_text(fallback_quantity)
        for symbol in normalized_symbols:
            quantities.setdefault(symbol, fallback_text)
    return quantities


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
    symbol_set = {
        str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()
    }
    missing = [
        symbol
        for symbol in HPAIRS_REQUIRED_PAPER_ROUTE_SYMBOLS
        if symbol not in symbol_set
    ]
    blockers: list[str] = []
    if missing:
        blockers.append("paper_route_hpairs_aapl_amzn_legs_missing")
        blockers.extend(
            f"paper_route_hpairs_{symbol.lower()}_leg_missing" for symbol in missing
        )
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
    _maybe_set_paper_route_audit_statement_timeout(session)
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
    _maybe_set_paper_route_audit_statement_timeout(session)
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
            _maybe_set_paper_route_audit_statement_timeout(session)
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
    stripped_source_promotion_authority = bool(target.get("promotion_allowed")) or bool(
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
        "account_stage_runtime_identity": {
            "account_label": _safe_text(target.get("account_label")),
            "source_account_label": _safe_text(target.get("source_account_label")),
            "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
            "runtime_strategy_name": runtime_strategy_name,
            "source_kind": _safe_text(target.get("source_kind")),
        },
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
        "bounded_live_paper_collection_authorized": bool(
            target.get("bounded_live_paper_collection_authorized")
            or target.get("canary_collection_authorized")
            or target.get("bounded_evidence_collection_authorized")
        ),
        "capital_promotion_allowed": False,
        "final_authority_ok": False,
        "stripped_source_promotion_authority": stripped_source_promotion_authority,
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


def _health_gate_ready_bool(
    health_gate: Mapping[str, object],
    *,
    ok_key: str,
    source_key: str,
) -> bool:
    return str(health_gate.get(ok_key) or "").strip().lower() == "true" and _safe_text(
        health_gate.get(source_key)
    ) not in {None, "missing"}


def _hpairs_current_collection_prerequisite_blockers(
    *,
    target: Mapping[str, object],
    health_gate: Mapping[str, object],
) -> list[str]:
    """Return current H-PAIRS source/TA health blockers for collection."""

    if not _target_is_hpairs(target):
        return []

    raw_blockers = (
        set(
            _unique_text_items(
                [
                    *_unique_text_items(target.get("candidate_blockers")),
                    *_unique_text_items(
                        target.get("runtime_ledger_target_metadata_blockers")
                    ),
                ]
            )
        )
        & HPAIRS_CURRENT_COLLECTION_PREREQUISITE_BLOCKERS
    )
    current_blockers: set[str] = set()
    continuity_reason = _safe_text(health_gate.get("continuity_reason"))
    drift_reason = _safe_text(health_gate.get("drift_reason"))

    signal_currently_stale = not _health_gate_ready_bool(
        health_gate,
        ok_key="continuity_ok",
        source_key="continuity_source",
    )
    if (
        "signal_lag_exceeded" in raw_blockers
        or continuity_reason == "signal_lag_exceeded"
    ) and signal_currently_stale:
        current_blockers.add("signal_lag_exceeded")

    drift_currently_missing = not _health_gate_ready_bool(
        health_gate,
        ok_key="drift_ok",
        source_key="drift_source",
    )
    if (
        "drift_checks_missing" in raw_blockers
        or (drift_reason is not None and "missing" in drift_reason)
    ) and drift_currently_missing:
        current_blockers.add("drift_checks_missing")

    return sorted(current_blockers)


def _hpairs_stale_collection_blockers_cleared_by_current_inputs(
    *,
    target: Mapping[str, object],
    health_gate: Mapping[str, object],
) -> list[str]:
    if not _target_is_hpairs(target):
        return []

    raw_blockers = (
        set(
            _unique_text_items(
                [
                    *_unique_text_items(target.get("candidate_blockers")),
                    *_unique_text_items(
                        target.get("runtime_ledger_target_metadata_blockers")
                    ),
                ]
            )
        )
        & HPAIRS_CURRENT_COLLECTION_PREREQUISITE_BLOCKERS
    )
    cleared: list[str] = []
    if "drift_checks_missing" in raw_blockers and _health_gate_ready_bool(
        health_gate,
        ok_key="drift_ok",
        source_key="drift_source",
    ):
        cleared.append("drift_checks_missing")
    if "signal_lag_exceeded" in raw_blockers and _health_gate_ready_bool(
        health_gate,
        ok_key="continuity_ok",
        source_key="continuity_source",
    ):
        cleared.append("signal_lag_exceeded")
    return sorted(cleared)


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
    target_account_audit_available: bool = True,
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
    collection_session_blockers = _paper_route_collection_session_blockers(
        session_readiness
    )
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
    planned_account_window_keys: dict[
        tuple[str, str, str, str, str, str], dict[str, object]
    ] = {}
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
        pair_symbol_quantities = _paper_route_probe_symbol_quantities(
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
        target_account_audit_state = _target_account_audit_state(
            account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            symbols=target_probe_symbols,
            window_start=window_start,
            window_end=window_end,
            audit_available=target_account_audit_available,
        )
        target_account_audit_blockers = _unique_text_items(
            target_account_audit_state.get("blockers")
        )
        account_pre_session_state = (
            _account_pre_session_snapshot_audit(
                session,
                account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                symbols=target_probe_symbols,
                generated_at=generated_at,
                window_start=window_start,
                window_end=window_end,
            )
            if target_account_audit_available
            else _account_pre_session_snapshot_audit_unavailable(
                account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                symbols=target_probe_symbols,
                generated_at=generated_at,
                window_start=window_start,
                window_end=window_end,
            )
        )
        account_pre_session_blockers = _unique_text_items(
            account_pre_session_state.get("blockers")
        )
        clean_window_baseline_state = (
            _account_clean_window_baseline_snapshot_audit(
                session,
                account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                symbols=target_probe_symbols,
                generated_at=generated_at,
                window_start=window_start,
                window_end=window_end,
            )
            if target_account_audit_available
            else _account_clean_window_baseline_audit_unavailable(
                account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                symbols=target_probe_symbols,
                generated_at=generated_at,
                window_start=window_start,
                window_end=window_end,
            )
        )
        clean_window_baseline_blockers = _unique_text_items(
            clean_window_baseline_state.get("blockers")
        )
        account_contamination_state = (
            _account_contamination_audit(
                session,
                account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                symbols=target_probe_symbols,
                window_start=window_start,
                window_end=window_end,
                strategy_lookup_names=strategy_lookup_names,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                require_source_lineage=_target_requires_source_lineage(target),
            )
            if target_account_audit_available
            else _account_contamination_audit_unavailable(
                account_label=PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                symbols=target_probe_symbols,
                window_start=window_start,
                window_end=window_end,
            )
        )
        account_contamination_blockers = _unique_text_items(
            account_contamination_state.get("blockers")
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
        account_window_start = _isoformat(window_start) or ""
        account_window_end = _isoformat(window_end) or ""
        account_window_key = (
            PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
            account_window_start,
            account_window_end,
            hypothesis_id or "",
            candidate_id or "",
            canonical_strategy_name or "",
        )
        existing_account_window = planned_account_window_keys.get(account_window_key)
        if existing_account_window is not None:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "reason": "paper_route_account_window_already_assigned",
                    "duplicate_of_hypothesis_id": existing_account_window.get(
                        "hypothesis_id"
                    ),
                    "duplicate_of_candidate_id": existing_account_window.get(
                        "candidate_id"
                    ),
                    "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                    "window_start": account_window_start,
                    "window_end": account_window_end,
                    "missing_or_blocking_fields": [
                        "paper_route_account_window_already_assigned"
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
        paper_probation_satisfied = bool(
            target.get("paper_probation_satisfied_for_bounded_live_paper_collection")
            or (
                target.get(
                    "paper_probation_satisfied_for_bounded_live_paper_collection"
                )
                is None
                and target.get("bounded_live_paper_collection_authorized")
            )
        )
        current_collection_prerequisite_blockers = (
            _hpairs_current_collection_prerequisite_blockers(
                target=pair_balance_target,
                health_gate=health_gate,
            )
        )
        stale_collection_blockers_cleared_by_current_inputs = (
            _hpairs_stale_collection_blockers_cleared_by_current_inputs(
                target=pair_balance_target,
                health_gate=health_gate,
            )
        )
        paper_probation_or_source_collection_satisfied = (
            paper_probation_satisfied or source_collection_authorized
        )
        evidence_collection_blockers = _unique_text_items(
            [
                *collection_session_blockers,
                *(
                    []
                    if paper_probation_or_source_collection_satisfied
                    else [
                        "paper_probation_prerequisites_not_satisfied_for_bounded_collection"
                    ]
                ),
                *_unique_text_items(source_decision_readiness.get("blockers")),
                *current_collection_prerequisite_blockers,
                *target_account_audit_blockers,
                *account_pre_session_blockers,
                *clean_window_baseline_blockers,
                *account_contamination_blockers,
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
        bounded_collection_authorized = bool(canary_collection_authorized)
        source_decision_mode = (
            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
            if bounded_collection_authorized
            else ROUTE_ACQUISITION_SOURCE_DECISION_MODE
        )
        profit_proof_eligible = source_decision_mode_is_profit_proof_eligible(
            source_decision_mode
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
            "paper_route_probe_symbol_quantities": pair_symbol_quantities,
            "paper_route_probe_target_quantity": _decimal_text(
                sum(
                    (
                        _safe_decimal(quantity)
                        for quantity in pair_symbol_quantities.values()
                    ),
                    Decimal("0"),
                )
            ),
            "paper_route_probe_symbol_quantity_source": (
                "target_plan_explicit_or_min_integer_probe"
            ),
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
            "paper_route_target_account_audit_state": target_account_audit_state,
            "paper_route_target_account_audit_blockers": (
                target_account_audit_blockers
            ),
            "paper_route_account_pre_session_state": account_pre_session_state,
            "paper_route_account_pre_session_blockers": (account_pre_session_blockers),
            "paper_route_clean_window_baseline_state": clean_window_baseline_state,
            "paper_route_clean_window_baseline_blockers": (
                clean_window_baseline_blockers
            ),
            "paper_route_account_contamination_state": account_contamination_state,
            "paper_route_account_contamination_blockers": (
                account_contamination_blockers
            ),
            "paper_route_clean_window_state": (
                "target_account_audit_unavailable"
                if target_account_audit_blockers
                else "contaminated_window_discarded"
                if account_contamination_blockers
                else "clean_window_collection_ready"
                if not clean_window_baseline_blockers
                else "clean_window_required"
            ),
            "paper_route_execution_source_key": {
                "strategy_family": strategy_family or "",
                "strategy": execution_source_key[1],
                "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                "source_manifest_ref": source_manifest_ref,
                "window_start": _isoformat(window_start),
                "window_end": _isoformat(window_end),
                "paper_route_probe_symbols": target_probe_symbols,
            },
            "account_stage_runtime_identity": {
                "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
                "source_account_label": source_account_label or "",
                "observed_stage": "paper",
                "runtime_strategy_name": canonical_strategy_name or "",
                "source_kind": "paper_route_probe_runtime_observed",
            },
            "source_decision_readiness": source_decision_readiness,
            "paper_route_session_readiness_state": _safe_text(
                session_readiness.get("state")
            )
            or "unknown",
            "paper_route_session_collection_blockers": collection_session_blockers,
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
            "paper_probation_satisfied_for_bounded_live_paper_collection": (
                paper_probation_satisfied
            ),
            "evidence_collection_ok": evidence_collection_ok,
            "canary_collection_authorized": canary_collection_authorized,
            "capital_promotion_allowed": False,
            "final_authority_ok": False,
            "bounded_evidence_collection_authorized": bounded_collection_authorized,
            "bounded_live_paper_collection_authorized": (bounded_collection_authorized),
            "bounded_evidence_collection_scope": (
                "paper_route_probe_next_session_only"
            ),
            "bounded_evidence_collection_max_notional": next_notional,
            "bounded_evidence_collection_blockers": evidence_collection_blockers,
            "current_collection_prerequisite_blockers": (
                current_collection_prerequisite_blockers
            ),
            "stale_collection_blockers_cleared_by_current_inputs": (
                stale_collection_blockers_cleared_by_current_inputs
            ),
            "evidence_collection_stage": "paper",
            "probation_allowed": True,
            "probation_reason": "paper_route_probe_next_session_runtime_window",
            "selection_reason": "paper_route_probe_next_session_evidence_collection",
            "selected_by": "paper_route_evidence_audit",
            "source_decision_mode": source_decision_mode,
            "source_decision_mode_profit_proof_eligible": profit_proof_eligible,
            "profit_proof_eligible": profit_proof_eligible,
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
                    *[
                        blocker
                        for blocker in _unique_text_items(
                            target.get("candidate_blockers")
                        )
                        if blocker
                        not in stale_collection_blockers_cleared_by_current_inputs
                    ],
                    *evidence_collection_blockers,
                    *health_gate_blockers,
                    *health_gate_promotion_blockers,
                ]
            ),
            "runtime_ledger_target_metadata_blockers": _unique_text_items(
                [
                    "paper_route_runtime_ledger_import_pending",
                    "live_runtime_ledger_required",
                    *[
                        blocker
                        for blocker in _unique_text_items(
                            target.get("runtime_ledger_target_metadata_blockers")
                        )
                        if blocker
                        not in stale_collection_blockers_cleared_by_current_inputs
                    ],
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
        planned_account_window_keys[account_window_key] = planned_target
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
    target_account_audit_items = [
        item
        for target in planned_targets
        if (item := _as_mapping(target.get("paper_route_target_account_audit_state")))
    ]
    target_account_audit_blockers = sorted(
        {
            blocker
            for item in target_account_audit_items
            for blocker in _unique_text_items(item.get("blockers"))
        }
    )
    target_account_audit_available_count = sum(
        1 for item in target_account_audit_items if bool(item.get("audit_available"))
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
    clean_window_baseline_items = [
        item
        for target in planned_targets
        if (item := _as_mapping(target.get("paper_route_clean_window_baseline_state")))
    ]
    clean_window_baseline_blockers = sorted(
        {
            blocker
            for item in clean_window_baseline_items
            for blocker in _unique_text_items(item.get("blockers"))
        }
    )
    clean_window_baseline_clean_count = sum(
        1
        for item in clean_window_baseline_items
        if item.get("state") == "clean" and not _unique_text_items(item.get("blockers"))
    )
    clean_window_baseline_blocked_count = sum(
        1
        for item in clean_window_baseline_items
        if item.get("state") == "blocked" or _unique_text_items(item.get("blockers"))
    )
    if not clean_window_baseline_items:
        clean_window_baseline_summary_state = "no_targets"
    elif clean_window_baseline_blocked_count:
        clean_window_baseline_summary_state = "clean_window_required"
    elif clean_window_baseline_clean_count == len(clean_window_baseline_items):
        clean_window_baseline_summary_state = "clean"
    else:
        clean_window_baseline_summary_state = "unknown"
    account_contamination_items = [
        item
        for target in planned_targets
        if (item := _as_mapping(target.get("paper_route_account_contamination_state")))
    ]
    account_contamination_blockers = sorted(
        {
            blocker
            for item in account_contamination_items
            for blocker in _unique_text_items(item.get("blockers"))
        }
    )
    account_contamination_contaminated_count = sum(
        1
        for item in account_contamination_items
        if bool(item.get("contaminated")) or _unique_text_items(item.get("blockers"))
    )
    account_contamination_clean_count = sum(
        1
        for item in account_contamination_items
        if not bool(item.get("contaminated"))
        and not _unique_text_items(item.get("blockers"))
    )
    account_contamination_sample_client_order_ids = _unique_text_items(
        [
            client_order_id
            for item in account_contamination_items
            for client_order_id in _as_sequence(item.get("sample_client_order_ids"))
        ]
    )[:10]
    account_contamination_sample_order_event_refs: list[dict[str, Any]] = []
    seen_account_contamination_sample_refs: set[tuple[str | None, str | None]] = set()
    for item in account_contamination_items:
        for raw_ref in _as_sequence(item.get("sample_order_event_refs")):
            ref = _as_mapping(raw_ref)
            key = (
                _safe_text(ref.get("event_fingerprint")),
                _safe_text(ref.get("client_order_id")),
            )
            if key in seen_account_contamination_sample_refs:
                continue
            seen_account_contamination_sample_refs.add(key)
            account_contamination_sample_order_event_refs.append(ref)
            if len(account_contamination_sample_order_event_refs) >= 10:
                break
        if len(account_contamination_sample_order_event_refs) >= 10:
            break
    account_contamination_summary_state = "unknown"
    if not account_contamination_items:
        account_contamination_summary_state = "no_targets"
    elif account_contamination_contaminated_count:
        account_contamination_summary_state = "contaminated_window_discarded"
    elif account_contamination_clean_count == len(account_contamination_items):
        account_contamination_summary_state = "clean"
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
        "collection_session_readiness": {
            "schema_version": "torghut.paper-route-collection-session-readiness.v1",
            "state": ("ready" if not collection_session_blockers else "blocked"),
            "blockers": collection_session_blockers,
        },
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
        "target_account_audit_readiness": {
            "schema_version": "torghut.paper-route-target-account-audit-readiness-summary.v1",
            "state": (
                "available"
                if target_account_audit_items
                and target_account_audit_available_count
                == len(target_account_audit_items)
                else "unavailable"
                if target_account_audit_blockers
                else "no_targets"
            ),
            "target_count": len(target_account_audit_items),
            "available_target_count": target_account_audit_available_count,
            "blocked_target_count": (
                len(target_account_audit_items) - target_account_audit_available_count
            ),
            "blockers": target_account_audit_blockers,
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
        "clean_window_baseline_readiness": {
            "schema_version": "torghut.paper-route-clean-window-baseline-readiness-summary.v1",
            "state": clean_window_baseline_summary_state,
            "target_count": len(clean_window_baseline_items),
            "clean_target_count": clean_window_baseline_clean_count,
            "blocked_target_count": clean_window_baseline_blocked_count,
            "blockers": clean_window_baseline_blockers,
        },
        "account_contamination_readiness": {
            "schema_version": "torghut.paper-route-account-contamination-readiness-summary.v1",
            "state": account_contamination_summary_state,
            "target_count": len(account_contamination_items),
            "clean_target_count": account_contamination_clean_count,
            "contaminated_target_count": account_contamination_contaminated_count,
            "order_event_count": sum(
                _safe_int(item.get("order_event_count"))
                for item in account_contamination_items
            ),
            "unlinked_order_event_count": sum(
                _safe_int(item.get("unlinked_order_event_count"))
                for item in account_contamination_items
            ),
            "foreign_linked_order_event_count": sum(
                _safe_int(item.get("foreign_linked_order_event_count"))
                for item in account_contamination_items
            ),
            "target_linked_order_event_count": sum(
                _safe_int(item.get("target_linked_order_event_count"))
                for item in account_contamination_items
            ),
            "blockers": account_contamination_blockers,
            "sample_client_order_ids": account_contamination_sample_client_order_ids,
            "sample_order_event_refs": account_contamination_sample_order_event_refs,
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
        "decision_refs": [],
        "execution_refs": [],
        "order_lifecycle_refs": [],
        "tca_metric_refs": [],
        "source_window_refs": [],
        "source_offset_refs": [],
        "source_reference_blockers": [
            "source_execution_refs_missing",
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
        ],
        "source_window_blockers": [],
        "submitted_order_blockers": [
            "source_submitted_orders_missing",
            "source_execution_refs_missing",
        ],
        "decision_count": lineage_matched_decision_count,
        "source_decision_count": lineage_matched_decision_count,
        "target_plan_source_decision_count": 0,
        "source_decision_mode_counts": {},
        "execution_count": 0,
        "linked_execution_count": 0,
        "filled_execution_count": 0,
        "order_event_count": 0,
        "linked_order_lifecycle_count": 0,
        "fill_order_event_count": 0,
        "complete_fill_order_event_count": 0,
        "tca_sample_count": 0,
        "explicit_cost_tca_count": 0,
        "source_window_count": 0,
        "linked_source_window_count": 0,
        "readback_state": "query_unavailable",
        "stage_presence": {
            "source_decisions_present": raw_decision_count > 0,
            "submitted_lifecycle_present": False,
            "fills_present": False,
            "source_refs_present": False,
            "source_windows_present": False,
            "runtime_execution_economics_present": False,
        },
        "query_limits": {
            "row_limit": PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
            "ref_limit": PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
            "decision_truncated": False,
            "execution_truncated": False,
            "order_event_truncated": False,
            "tca_truncated": False,
            "truncated_sources": [],
        },
        "last_decision_at": None,
        "last_execution_at": None,
        "last_order_event_at": None,
        "last_tca_at": None,
        "missing": True,
        "missing_reasons": [missing_reason],
        "source_lifecycle_blockers": [
            "source_execution_refs_missing",
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
        ],
        "query_unavailable": True,
        "unavailable_source": source,
    }


def _order_event_signed_filled_qty(
    row: ExecutionOrderEvent,
    *,
    execution_side_by_id: Mapping[object, str] | None = None,
) -> Decimal:
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
    if not side and execution_side_by_id is not None and row.execution_id is not None:
        side = execution_side_by_id.get(row.execution_id, "").lower()
    if not side:
        client_order_id = (_safe_text(row.client_order_id) or "").lower()
        if "sell" in client_order_id or "short" in client_order_id:
            side = "sell"
        elif "buy" in client_order_id or "cover" in client_order_id:
            side = "buy"
    if side in {"sell", "short"}:
        return -qty.copy_abs()
    return qty.copy_abs()


def _source_decision_reject_reason_values(row: TradeDecision) -> list[str]:
    decision_json = _as_mapping(row.decision_json)
    params = _as_mapping(decision_json.get("params"))
    routeability = _as_mapping(params.get("quote_routeability"))
    raw_values: list[object] = [
        decision_json.get("risk_reasons"),
        decision_json.get("reject_reason_atomic"),
        decision_json.get("reject_reason"),
    ]
    if _safe_text(routeability.get("status")) == "blocked":
        raw_values.append(routeability.get("reason"))

    reasons: list[str] = []
    for raw_value in raw_values:
        raw_items: Sequence[object]
        if isinstance(raw_value, str):
            raw_items = raw_value.replace(";", ",").split(",")
        elif isinstance(raw_value, Sequence) and not isinstance(
            raw_value, (bytes, bytearray)
        ):
            raw_items = cast(Sequence[object], raw_value)
        else:
            raw_items = ()
        for raw_item in raw_items:
            reason = _safe_text(raw_item)
            if reason and reason not in reasons:
                reasons.append(reason)
    return reasons


def _source_decision_rejection_summary(
    decision_rows: Sequence[TradeDecision],
) -> dict[str, object]:
    reason_counts: Counter[str] = Counter()
    decision_refs: list[str] = []
    for row in decision_rows:
        if _safe_text(row.status) != "rejected":
            continue
        row_reasons = _source_decision_reject_reason_values(row)
        if not row_reasons:
            row_reasons = ["source_decision_rejected_without_reason"]
        decision_refs.append(str(row.id))
        for reason in row_reasons:
            reason_counts[reason] += 1
    blockers = [f"source_reject_{reason}" for reason in sorted(reason_counts)]
    return {
        "rejected_decision_count": len(decision_refs),
        "decision_refs": decision_refs[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT],
        "reason_counts": [
            {"reason": reason, "count": count}
            for reason, count in sorted(reason_counts.items())
        ],
        "blockers": blockers,
    }


def _trade_decision_source_decision_mode(row: TradeDecision) -> str:
    payload = _as_mapping(row.decision_json)
    params = _as_mapping(payload.get("params"))
    metadata = _as_mapping(params.get("paper_route_target_plan_source_decision"))
    if not metadata:
        metadata = _as_mapping(params.get("paper_route_target_plan"))
    mode = (
        _safe_text(payload.get("source_decision_mode"))
        or _safe_text(params.get("source_decision_mode"))
        or _safe_text(metadata.get("source_decision_mode"))
    )
    return normalize_source_decision_mode(mode) or "missing"


def _trade_decision_is_target_plan_source_decision(row: TradeDecision) -> bool:
    payload = _as_mapping(row.decision_json)
    params = _as_mapping(payload.get("params"))
    metadata = _as_mapping(params.get("paper_route_target_plan_source_decision"))
    if not metadata:
        metadata = _as_mapping(params.get("paper_route_target_plan"))
    return _safe_text(metadata.get("mode")) == "paper_route_target_plan_source_decision"


def _trade_decision_is_paper_route_closeout(row: TradeDecision) -> bool:
    payload = _as_mapping(row.decision_json)
    params = _as_mapping(payload.get("params"))
    metadata = _as_mapping(params.get("paper_route_probe_exit"))
    return _safe_text(metadata.get("mode")) == "paper_route_exit"


def _source_closeout_fillability_summary(
    *,
    decision_rows: Sequence[TradeDecision],
    execution_rows: Sequence[Execution],
    order_event_rows: Sequence[ExecutionOrderEvent],
) -> dict[str, object]:
    closeout_decisions = [
        row for row in decision_rows if _trade_decision_is_paper_route_closeout(row)
    ]
    closeout_decision_ids = {row.id for row in closeout_decisions}
    closeout_executions = [
        row for row in execution_rows if row.trade_decision_id in closeout_decision_ids
    ]
    closeout_order_events = [
        row
        for row in order_event_rows
        if row.trade_decision_id in closeout_decision_ids
    ]
    filled_execution_count = sum(
        int(_safe_decimal(row.filled_qty) > 0) for row in closeout_executions
    )
    fill_order_event_count = sum(
        int(_order_event_is_fill(row)) for row in closeout_order_events
    )
    blockers: list[str] = []
    if (
        closeout_decisions
        and filled_execution_count <= 0
        and fill_order_event_count <= 0
    ):
        blockers.append("source_closeout_fillability_missing")
    return {
        "schema_version": "torghut.paper-route-closeout-fillability-summary.v1",
        "closeout_decision_count": len(closeout_decisions),
        "closeout_execution_count": len(closeout_executions),
        "closeout_filled_execution_count": filled_execution_count,
        "closeout_order_event_count": len(closeout_order_events),
        "closeout_fill_order_event_count": fill_order_event_count,
        "closeout_decision_refs": [
            str(row.id)
            for row in closeout_decisions[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
        ],
        "closeout_execution_refs": [
            str(row.id)
            for row in closeout_executions[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
        ],
        "blockers": blockers,
    }


def _source_decision_mode_counts(
    decision_rows: Sequence[TradeDecision],
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for row in decision_rows:
        counts[_trade_decision_source_decision_mode(row)] += 1
    return dict(sorted(counts.items()))


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
    execution_side_by_id: dict[object, str] = {
        row.id: (_safe_text(row.side) or "")
        for row in execution_rows
        if _safe_text(row.side) is not None
    }
    if fill_event_rows:
        for row in fill_event_rows:
            symbol = (_safe_text(row.symbol) or "missing").upper()
            signed_qty = _order_event_signed_filled_qty(
                row,
                execution_side_by_id=execution_side_by_id,
            )
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
        symbol
        for symbol, qty in net_filled_qty_by_symbol.items()
        if _safe_decimal(qty) != 0
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
        lifecycle_blockers.extend(
            ["source_close_missing", "source_closed_round_trip_missing"]
        )
    if len(tca_rows) <= 0 and complete_fill_event_count <= 0:
        lifecycle_blockers.append("source_execution_economics_missing")
    submitted_order_blockers = (
        ["source_submitted_orders_missing"] if submitted_order_count <= 0 else []
    )
    return {
        "schema_version": "torghut.paper-route-source-lifecycle-summary.v1",
        "submitted_order_count": submitted_order_count,
        "submitted_order_blockers": submitted_order_blockers,
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
        "closed_round_trip_evidence": bool(fill_count > 0 or fill_event_count > 0)
        and not open_symbols,
        "execution_economics_present": len(tca_rows) > 0
        or complete_fill_event_count > 0,
        "blockers": sorted(dict.fromkeys(lifecycle_blockers)),
    }


def _order_event_source_offset_refs(
    order_event_rows: Sequence[ExecutionOrderEvent],
) -> list[dict[str, object]]:
    refs: list[dict[str, object]] = []
    seen: set[tuple[str, int, int]] = set()
    for row in order_event_rows:
        topic = _safe_text(row.source_topic)
        partition = row.source_partition
        offset = row.source_offset
        if topic is None or partition is None or offset is None:
            continue
        key = (topic, int(partition), int(offset))
        if key in seen:
            continue
        seen.add(key)
        refs.append(
            {"topic": topic, "partition": int(partition), "offset": int(offset)}
        )
        if len(refs) >= PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT:
            break
    return refs


def _source_window_refs(
    source_window_rows: Sequence[OrderFeedSourceWindow],
) -> list[str]:
    return [
        str(row.id)
        for row in source_window_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
    ]


def _source_activity_readback_state(
    *,
    decision_count: int,
    execution_count: int,
    filled_execution_count: int,
    fill_order_event_count: int,
    complete_fill_order_event_count: int,
    tca_sample_count: int,
) -> str:
    if tca_sample_count > 0:
        return "source_execution_economics_present"
    if (
        filled_execution_count > 0
        or fill_order_event_count > 0
        or complete_fill_order_event_count > 0
    ):
        return "source_fills_present"
    if execution_count > 0:
        return "submitted_lifecycle_present"
    if decision_count > 0:
        return "source_decisions_present"
    return "no_source_activity"


def _source_activity_account_diagnostic_labels(
    target: Mapping[str, Any],
) -> list[str]:
    return _unique_text_items(
        [
            target.get("account_label"),
            target.get("source_account_label"),
            target.get("configured_trading_account_label"),
            settings.trading_account_label,
        ]
    )


def _source_activity_account_diagnostics(
    session: Session,
    *,
    target: Mapping[str, Any],
    probe: Mapping[str, object],
    strategy_lookup_names: Sequence[str],
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    target_account_label = _safe_text(target.get("account_label"))
    source_account_label = _safe_text(target.get("source_account_label"))
    configured_account_label = _safe_text(
        target.get("configured_trading_account_label")
    ) or _safe_text(settings.trading_account_label)
    account_labels = _source_activity_account_diagnostic_labels(target)
    target_strategy_names = _strategy_lookup_names(
        target.get("strategy_name"),
        target.get("runtime_strategy_name"),
        strategy_lookup_names,
    )
    symbol_filters = [
        str(item).strip().upper()
        for item in _target_probe_symbols(target, probe)
        if str(item).strip()
    ]

    def unavailable(error: BaseException) -> dict[str, object]:
        return {
            "schema_version": SOURCE_ACTIVITY_ACCOUNT_DIAGNOSTICS_SCHEMA_VERSION,
            "available": False,
            "diagnostic_only": True,
            "readiness_authority": "not_used_for_import_or_promotion_readiness",
            "target_account_label": target_account_label,
            "source_account_label": source_account_label,
            "configured_trading_account_label": configured_account_label,
            "account_labels": account_labels,
            "strategy_lookup_names": target_strategy_names,
            "symbols": symbol_filters,
            "account_summaries": [],
            "strategy_summaries": [],
            "scope_mismatch_reasons": [
                "source_activity_account_diagnostics_unavailable"
            ],
            "error": {
                "type": type(error).__name__,
                "message": str(error),
            },
        }

    if not account_labels:
        return {
            "schema_version": SOURCE_ACTIVITY_ACCOUNT_DIAGNOSTICS_SCHEMA_VERSION,
            "available": True,
            "diagnostic_only": True,
            "readiness_authority": "not_used_for_import_or_promotion_readiness",
            "target_account_label": target_account_label,
            "source_account_label": source_account_label,
            "configured_trading_account_label": configured_account_label,
            "account_labels": [],
            "strategy_lookup_names": target_strategy_names,
            "symbols": symbol_filters,
            "account_summaries": [],
            "strategy_summaries": [],
            "target_scope_activity_present": False,
            "configured_account_activity_present": False,
            "alternate_account_activity_present": False,
            "alternate_account_target_strategy_activity_present": False,
            "alternate_account_non_target_strategy_activity_present": False,
            "scope_mismatch_reasons": ["source_activity_account_scope_missing"],
        }

    account_summaries: dict[str, dict[str, Any]] = {
        label: cast(
            dict[str, Any],
            {
                "account_label": label,
                "decision_count": 0,
                "execution_count": 0,
                "order_event_count": 0,
                "tca_sample_count": 0,
                "target_strategy_decision_count": 0,
                "target_strategy_execution_count": 0,
                "target_strategy_order_event_count": 0,
                "target_strategy_tca_sample_count": 0,
                "non_target_strategy_decision_count": 0,
                "decision_status_counts": {},
                "strategy_names": [],
                "_last_activity_at": None,
            },
        )
        for label in account_labels
    }
    strategy_summaries: dict[tuple[str, str], dict[str, Any]] = {}

    def bump_last_activity(summary: dict[str, Any], value: object) -> None:
        activity_at = _parse_datetime(value)
        if activity_at is None:
            return
        current = summary.get("_last_activity_at")
        if not isinstance(current, datetime) or activity_at > current:
            summary["_last_activity_at"] = activity_at

    def strategy_summary(
        account_label: str, strategy_name: str | None
    ) -> dict[str, Any]:
        strategy_key = strategy_name or ""
        key = (account_label, strategy_key)
        summary = strategy_summaries.get(key)
        if summary is None:
            summary = cast(
                dict[str, Any],
                {
                    "account_label": account_label,
                    "strategy_name": strategy_key or None,
                    "target_strategy": strategy_key in target_strategy_names,
                    "decision_count": 0,
                    "execution_count": 0,
                    "order_event_count": 0,
                    "tca_sample_count": 0,
                    "decision_status_counts": {},
                    "_last_activity_at": None,
                },
            )
            strategy_summaries[key] = summary
        return summary

    def bump(
        *,
        account_label: object,
        strategy_name: object,
        field: str,
        count: object,
        last_activity_at: object,
        decision_status: object = None,
    ) -> None:
        account = _safe_text(account_label)
        if account is None:
            return
        strategy = _safe_text(strategy_name)
        amount = _safe_int(count)
        if amount <= 0:
            return
        account_summary = account_summaries.setdefault(
            account,
            cast(
                dict[str, Any],
                {
                    "account_label": account,
                    "decision_count": 0,
                    "execution_count": 0,
                    "order_event_count": 0,
                    "tca_sample_count": 0,
                    "target_strategy_decision_count": 0,
                    "target_strategy_execution_count": 0,
                    "target_strategy_order_event_count": 0,
                    "target_strategy_tca_sample_count": 0,
                    "non_target_strategy_decision_count": 0,
                    "decision_status_counts": {},
                    "strategy_names": [],
                    "_last_activity_at": None,
                },
            ),
        )
        account_summary[field] = _safe_int(account_summary.get(field)) + amount
        strategy_names = _unique_text_items(account_summary.get("strategy_names"))
        if strategy is not None and strategy not in strategy_names:
            strategy_names.append(strategy)
            account_summary["strategy_names"] = strategy_names
        is_target_strategy = strategy in target_strategy_names if strategy else False
        if is_target_strategy:
            target_field = f"target_strategy_{field}"
            account_summary[target_field] = (
                _safe_int(account_summary.get(target_field)) + amount
            )
        elif field == "decision_count":
            account_summary["non_target_strategy_decision_count"] = (
                _safe_int(account_summary.get("non_target_strategy_decision_count"))
                + amount
            )
        status = _safe_text(decision_status)
        if field == "decision_count" and status is not None:
            status_counts = _as_mapping(account_summary.get("decision_status_counts"))
            status_counts[status] = _safe_int(status_counts.get(status)) + amount
            account_summary["decision_status_counts"] = status_counts
        bump_last_activity(account_summary, last_activity_at)

        per_strategy = strategy_summary(account, strategy)
        per_strategy[field] = _safe_int(per_strategy.get(field)) + amount
        if field == "decision_count" and status is not None:
            strategy_status_counts = _as_mapping(
                per_strategy.get("decision_status_counts")
            )
            strategy_status_counts[status] = (
                _safe_int(strategy_status_counts.get(status)) + amount
            )
            per_strategy["decision_status_counts"] = strategy_status_counts
        bump_last_activity(per_strategy, last_activity_at)

    try:
        _maybe_set_paper_route_audit_statement_timeout(session)
        decision_stmt = (
            select(
                TradeDecision.alpaca_account_label,
                Strategy.name,
                TradeDecision.status,
                func.count(TradeDecision.id),
                func.max(TradeDecision.created_at),
            )
            .join(Strategy, TradeDecision.strategy_id == Strategy.id)
            .where(TradeDecision.alpaca_account_label.in_(account_labels))
            .where(TradeDecision.created_at >= window_start)
            .where(TradeDecision.created_at <= window_end)
            .group_by(
                TradeDecision.alpaca_account_label,
                Strategy.name,
                TradeDecision.status,
            )
        )
        if symbol_filters:
            decision_stmt = decision_stmt.where(
                TradeDecision.symbol.in_(symbol_filters)
            )
        for (
            account_label,
            strategy_name,
            status,
            count,
            last_activity_at,
        ) in session.execute(decision_stmt):
            bump(
                account_label=account_label,
                strategy_name=strategy_name,
                field="decision_count",
                count=count,
                last_activity_at=last_activity_at,
                decision_status=status,
            )

        execution_activity_ts = _execution_activity_timestamp()
        execution_stmt = (
            select(
                Execution.alpaca_account_label,
                Strategy.name,
                func.count(Execution.id),
                func.max(execution_activity_ts),
            )
            .outerjoin(
                TradeDecision,
                Execution.trade_decision_id == TradeDecision.id,
            )
            .outerjoin(Strategy, TradeDecision.strategy_id == Strategy.id)
            .where(Execution.alpaca_account_label.in_(account_labels))
            .where(execution_activity_ts >= window_start)
            .where(execution_activity_ts <= window_end)
            .group_by(Execution.alpaca_account_label, Strategy.name)
        )
        if symbol_filters:
            execution_stmt = execution_stmt.where(Execution.symbol.in_(symbol_filters))
        for account_label, strategy_name, count, last_activity_at in session.execute(
            execution_stmt
        ):
            bump(
                account_label=account_label,
                strategy_name=strategy_name,
                field="execution_count",
                count=count,
                last_activity_at=last_activity_at,
            )

        order_event_activity_ts = _order_event_activity_timestamp()
        order_event_stmt = (
            select(
                ExecutionOrderEvent.alpaca_account_label,
                Strategy.name,
                func.count(ExecutionOrderEvent.id),
                func.max(order_event_activity_ts),
            )
            .outerjoin(
                TradeDecision,
                ExecutionOrderEvent.trade_decision_id == TradeDecision.id,
            )
            .outerjoin(Strategy, TradeDecision.strategy_id == Strategy.id)
            .where(ExecutionOrderEvent.alpaca_account_label.in_(account_labels))
            .where(order_event_activity_ts >= window_start)
            .where(order_event_activity_ts <= window_end)
            .group_by(ExecutionOrderEvent.alpaca_account_label, Strategy.name)
        )
        if symbol_filters:
            order_event_stmt = order_event_stmt.where(
                ExecutionOrderEvent.symbol.in_(symbol_filters)
            )
        for account_label, strategy_name, count, last_activity_at in session.execute(
            order_event_stmt
        ):
            bump(
                account_label=account_label,
                strategy_name=strategy_name,
                field="order_event_count",
                count=count,
                last_activity_at=last_activity_at,
            )

        tca_stmt = (
            select(
                ExecutionTCAMetric.alpaca_account_label,
                Strategy.name,
                func.count(ExecutionTCAMetric.id),
                func.max(ExecutionTCAMetric.computed_at),
            )
            .outerjoin(Strategy, ExecutionTCAMetric.strategy_id == Strategy.id)
            .where(ExecutionTCAMetric.alpaca_account_label.in_(account_labels))
            .where(ExecutionTCAMetric.computed_at >= window_start)
            .where(ExecutionTCAMetric.computed_at <= window_end)
            .group_by(ExecutionTCAMetric.alpaca_account_label, Strategy.name)
        )
        if symbol_filters:
            tca_stmt = tca_stmt.where(ExecutionTCAMetric.symbol.in_(symbol_filters))
        for account_label, strategy_name, count, last_activity_at in session.execute(
            tca_stmt
        ):
            bump(
                account_label=account_label,
                strategy_name=strategy_name,
                field="tca_sample_count",
                count=count,
                last_activity_at=last_activity_at,
            )
    except SQLAlchemyError as exc:
        _rollback_paper_route_audit_session(session)
        return unavailable(exc)

    account_results: list[dict[str, object]] = []
    for summary in account_summaries.values():
        result = {
            key: value for key, value in summary.items() if not key.startswith("_")
        }
        result["last_activity_at"] = _isoformat(
            cast(datetime | None, summary.get("_last_activity_at"))
        )
        account_results.append(result)
    strategy_results: list[dict[str, object]] = []
    for summary in strategy_summaries.values():
        result = {
            key: value for key, value in summary.items() if not key.startswith("_")
        }
        result["last_activity_at"] = _isoformat(
            cast(datetime | None, summary.get("_last_activity_at"))
        )
        strategy_results.append(result)

    def activity_total(summary: Mapping[str, object]) -> int:
        return (
            _safe_int(summary.get("decision_count"))
            + _safe_int(summary.get("execution_count"))
            + _safe_int(summary.get("order_event_count"))
            + _safe_int(summary.get("tca_sample_count"))
        )

    account_results.sort(
        key=lambda item: (
            activity_total(item),
            _safe_text(item.get("account_label")) or "",
        ),
        reverse=True,
    )
    strategy_results.sort(
        key=lambda item: (
            activity_total(item),
            _safe_text(item.get("account_label")) or "",
            _safe_text(item.get("strategy_name")) or "",
        ),
        reverse=True,
    )

    target_account_summary = _as_mapping(
        account_summaries.get(target_account_label)
        if target_account_label is not None
        else None
    )
    configured_account_summary = _as_mapping(
        account_summaries.get(configured_account_label)
        if configured_account_label is not None
        else None
    )
    target_scope_activity_present = activity_total(target_account_summary) > 0 and (
        _safe_int(target_account_summary.get("target_strategy_decision_count")) > 0
        or _safe_int(target_account_summary.get("target_strategy_execution_count")) > 0
        or _safe_int(target_account_summary.get("target_strategy_order_event_count"))
        > 0
        or _safe_int(target_account_summary.get("target_strategy_tca_sample_count")) > 0
    )
    configured_account_activity_present = (
        configured_account_label is not None
        and activity_total(configured_account_summary) > 0
    )
    alternate_account_activity_present = any(
        _safe_text(summary.get("account_label")) != target_account_label
        and activity_total(summary) > 0
        for summary in account_results
    )
    alternate_account_target_strategy_activity_present = any(
        _safe_text(summary.get("account_label")) != target_account_label
        and (
            _safe_int(summary.get("target_strategy_decision_count")) > 0
            or _safe_int(summary.get("target_strategy_execution_count")) > 0
            or _safe_int(summary.get("target_strategy_order_event_count")) > 0
            or _safe_int(summary.get("target_strategy_tca_sample_count")) > 0
        )
        for summary in account_results
    )
    alternate_account_non_target_strategy_activity_present = any(
        _safe_text(summary.get("account_label")) != target_account_label
        and _safe_int(summary.get("non_target_strategy_decision_count")) > 0
        for summary in account_results
    )
    scope_mismatch_reasons = _unique_text_items(
        [
            *(
                ["target_strategy_activity_missing"]
                if not target_scope_activity_present
                else []
            ),
            *(
                ["source_activity_on_non_target_account"]
                if alternate_account_activity_present
                else []
            ),
            *(
                ["alternate_account_target_strategy_activity_present"]
                if alternate_account_target_strategy_activity_present
                else []
            ),
            *(
                ["non_target_strategy_activity_present"]
                if alternate_account_non_target_strategy_activity_present
                else []
            ),
        ]
    )

    return {
        "schema_version": SOURCE_ACTIVITY_ACCOUNT_DIAGNOSTICS_SCHEMA_VERSION,
        "available": True,
        "diagnostic_only": True,
        "readiness_authority": "not_used_for_import_or_promotion_readiness",
        "target_account_label": target_account_label,
        "source_account_label": source_account_label,
        "configured_trading_account_label": configured_account_label,
        "account_labels": account_labels,
        "strategy_lookup_names": target_strategy_names,
        "symbols": symbol_filters,
        "target_scope_activity_present": target_scope_activity_present,
        "configured_account_activity_present": configured_account_activity_present,
        "alternate_account_activity_present": alternate_account_activity_present,
        "alternate_account_target_strategy_activity_present": (
            alternate_account_target_strategy_activity_present
        ),
        "alternate_account_non_target_strategy_activity_present": (
            alternate_account_non_target_strategy_activity_present
        ),
        "scope_mismatch_reasons": scope_mismatch_reasons,
        "account_summaries": account_results[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT],
        "strategy_summaries": strategy_results[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT],
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
            "decision_refs": [],
            "execution_refs": [],
            "order_lifecycle_refs": [],
            "tca_metric_refs": [],
            "source_window_refs": [],
            "source_offset_refs": [],
            "source_reference_blockers": [
                "source_decision_refs_missing",
                "source_execution_refs_missing",
                "source_order_lifecycle_refs_missing",
                "source_explicit_costs_missing",
            ],
            "source_window_blockers": [],
            "submitted_order_blockers": ["source_submitted_orders_missing"],
            "decision_count": 0,
            "source_decision_count": 0,
            "target_plan_source_decision_count": 0,
            "source_decision_mode_counts": {},
            "execution_count": 0,
            "linked_execution_count": 0,
            "filled_execution_count": 0,
            "order_event_count": 0,
            "linked_order_lifecycle_count": 0,
            "fill_order_event_count": 0,
            "complete_fill_order_event_count": 0,
            "tca_sample_count": 0,
            "explicit_cost_tca_count": 0,
            "source_window_count": 0,
            "linked_source_window_count": 0,
            "readback_state": "no_source_activity",
            "stage_presence": {
                "source_decisions_present": False,
                "submitted_lifecycle_present": False,
                "fills_present": False,
                "source_refs_present": False,
                "source_windows_present": False,
                "runtime_execution_economics_present": False,
            },
            "query_limits": {
                "row_limit": PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
                "ref_limit": PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
                "decision_truncated": False,
                "execution_truncated": False,
                "order_event_truncated": False,
                "tca_truncated": False,
                "truncated_sources": [],
            },
            "last_decision_at": None,
            "last_execution_at": None,
            "last_order_event_at": None,
            "last_tca_at": None,
            "missing": True,
            "missing_reasons": ["strategy_name_missing"],
            "source_lifecycle_blockers": [
                "source_decision_refs_missing",
                "source_execution_refs_missing",
                "source_order_lifecycle_refs_missing",
                "source_explicit_costs_missing",
            ],
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
        decision_stmt = decision_stmt.where(TradeDecision.symbol.in_(symbol_filters))
    decision_truncated = False
    try:
        _maybe_set_paper_route_audit_statement_timeout(session)
        queried_decision_rows = list(
            session.execute(
                decision_stmt.order_by(TradeDecision.created_at.desc()).limit(
                    PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT + 1
                )
            ).scalars()
        )
        decision_truncated = (
            len(queried_decision_rows) > PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
        )
        decision_rows = queried_decision_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT]
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
    source_lineage_observation: dict[str, object] = {
        "schema_version": SOURCE_LINEAGE_OBSERVATION_SCHEMA_VERSION,
        "enabled": False,
        "expected_candidate_id": candidate_id,
        "expected_hypothesis_id": hypothesis_id,
        "strategy_lookup_names": strategy_filters,
        "observed_decision_count": 0,
        "exact_match_decision_count": 0,
        "candidate_match_decision_count": 0,
        "hypothesis_match_decision_count": 0,
        "partial_match_decision_count": 0,
        "strategy_filter_mismatch_count": 0,
        "candidate_mismatch_count": 0,
        "decision_refs": [],
        "exact_decision_refs": [],
        "strategy_names": [],
        "candidate_ids": [],
        "hypothesis_ids": [],
        "blockers": [],
    }
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
            execution_stmt = execution_stmt.where(Execution.symbol.in_(symbol_filters))
        try:
            _maybe_set_paper_route_audit_statement_timeout(session)
            queried_execution_rows = list(
                session.execute(
                    execution_stmt.order_by(execution_activity_ts.desc()).limit(
                        PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT + 1
                    )
                ).scalars()
            )
            execution_truncated = (
                len(queried_execution_rows) > PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
            )
            execution_rows = queried_execution_rows[
                :PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
            ]
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
    else:
        execution_truncated = False
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
                ExecutionOrderEvent.symbol.in_(symbol_filters)
            )
        try:
            _maybe_set_paper_route_audit_statement_timeout(session)
            queried_order_event_rows = list(
                session.execute(
                    order_event_stmt.order_by(order_event_activity_ts.desc()).limit(
                        PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT + 1
                    )
                ).scalars()
            )
            order_event_truncated = (
                len(queried_order_event_rows) > PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
            )
            order_event_rows = queried_order_event_rows[
                :PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
            ]
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
    else:
        order_event_truncated = False
    source_window_rows: list[OrderFeedSourceWindow] = []
    if order_event_rows:
        source_window_ids = sorted(
            {
                row.source_window_id
                for row in order_event_rows
                if row.source_window_id is not None
            }
        )
        if source_window_ids:
            try:
                _maybe_set_paper_route_audit_statement_timeout(session)
                source_window_rows = list(
                    session.execute(
                        select(OrderFeedSourceWindow)
                        .where(OrderFeedSourceWindow.id.in_(source_window_ids))
                        .order_by(OrderFeedSourceWindow.window_ended_at.desc())
                        .limit(PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT)
                    ).scalars()
                )
            except SQLAlchemyError as exc:
                _rollback_after_source_activity_error(
                    session,
                    source="order_feed_source_windows",
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
                    source="order_feed_source_windows",
                    missing_reason="source_windows_unavailable",
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
            tca_stmt = tca_stmt.where(ExecutionTCAMetric.symbol.in_(symbol_filters))
        try:
            _maybe_set_paper_route_audit_statement_timeout(session)
            queried_tca_rows = list(
                session.execute(
                    tca_stmt.order_by(ExecutionTCAMetric.computed_at.desc()).limit(
                        PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT + 1
                    )
                ).scalars()
            )
            tca_truncated = (
                len(queried_tca_rows) > PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
            )
            tca_rows = queried_tca_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT]
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
    else:
        tca_truncated = False
    if require_source_lineage and (
        candidate_id is not None or hypothesis_id is not None
    ):
        lineage_stmt = (
            select(TradeDecision)
            .where(TradeDecision.created_at >= window_start)
            .where(TradeDecision.created_at <= window_end)
        )
        if account_label:
            lineage_stmt = lineage_stmt.where(
                TradeDecision.alpaca_account_label == account_label
            )
        if symbol_filters:
            lineage_stmt = lineage_stmt.where(TradeDecision.symbol.in_(symbol_filters))
        try:
            _maybe_set_paper_route_audit_statement_timeout(session)
            lineage_rows = list(
                session.execute(
                    lineage_stmt.order_by(TradeDecision.created_at.desc()).limit(
                        PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT + 1
                    )
                ).scalars()
            )
            source_lineage_observation = _source_lineage_observation(
                lineage_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT],
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                strategy_filters=strategy_filters,
            )
        except SQLAlchemyError as exc:
            _rollback_after_source_activity_error(
                session,
                source="trade_decision_source_lineage",
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
                source="trade_decision_source_lineage",
                missing_reason="source_lineage_readback_unavailable",
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
    source_window_count = len(source_window_rows)
    source_offset_refs = _order_event_source_offset_refs(order_event_rows)
    source_window_reference_count = len(
        {
            row.source_window_id
            for row in order_event_rows
            if row.source_window_id is not None
        }
    )
    target_plan_source_decision_count = sum(
        int(_trade_decision_is_target_plan_source_decision(row))
        for row in decision_rows
    )
    decision_rejection_summary = _source_decision_rejection_summary(decision_rows)
    decision_reject_blockers = _unique_text_items(
        decision_rejection_summary.get("blockers")
    )
    missing_reasons: list[str] = []
    if decision_count <= 0:
        missing_reasons.append("source_decisions_missing")
    if execution_count <= 0:
        missing_reasons.append("source_executions_missing")
        missing_reasons.extend(decision_reject_blockers)
    if tca_sample_count <= 0 and complete_fill_order_event_count <= 0:
        missing_reasons.append("source_tca_missing")
    missing_reasons.extend(lineage_blockers)
    if decision_count <= 0:
        missing_reasons.extend(
            _unique_text_items(source_lineage_observation.get("blockers"))
        )
    if (
        decision_truncated
        or execution_truncated
        or order_event_truncated
        or tca_truncated
    ):
        missing_reasons.append("source_activity_readback_truncated")
    lifecycle_summary = _source_activity_lifecycle_summary(
        execution_rows=execution_rows,
        order_event_rows=order_event_rows,
        tca_rows=tca_rows,
    )
    closeout_fillability = _source_closeout_fillability_summary(
        decision_rows=decision_rows,
        execution_rows=execution_rows,
        order_event_rows=order_event_rows,
    )
    decision_refs = [
        str(row.id) for row in decision_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
    ]
    execution_refs = [
        str(row.id) for row in execution_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
    ]
    order_lifecycle_refs = [
        str(row.id) for row in order_event_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
    ]
    tca_metric_refs = [
        str(row.id) for row in tca_rows[:PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT]
    ]
    source_window_refs = _source_window_refs(source_window_rows)
    source_reference_blockers = _unique_text_items(
        [
            *(["source_decision_refs_missing"] if not decision_refs else []),
            *(["source_execution_refs_missing"] if not execution_refs else []),
            *(
                ["source_order_lifecycle_refs_missing"]
                if not order_lifecycle_refs
                else []
            ),
            *(["source_explicit_costs_missing"] if not tca_metric_refs else []),
        ]
    )
    source_window_blockers = _unique_text_items(
        [
            *(
                ["source_window_refs_missing"]
                if order_lifecycle_refs and not source_window_refs
                else []
            ),
            *(
                ["source_offsets_missing"]
                if order_lifecycle_refs and not source_offset_refs
                else []
            ),
        ]
    )
    submitted_order_blockers = _unique_text_items(
        [
            *_unique_text_items(lifecycle_summary.get("submitted_order_blockers")),
            *(["source_execution_refs_missing"] if not execution_refs else []),
            *(
                decision_reject_blockers
                if execution_count <= 0 and decision_reject_blockers
                else []
            ),
        ]
    )
    source_lifecycle_blockers = _unique_text_items(
        [
            *_unique_text_items(lifecycle_summary.get("blockers")),
            *_unique_text_items(closeout_fillability.get("blockers")),
            *source_reference_blockers,
            *(
                decision_reject_blockers
                if execution_count <= 0 and decision_reject_blockers
                else []
            ),
            *(
                ["source_activity_readback_truncated"]
                if decision_truncated
                or execution_truncated
                or order_event_truncated
                or tca_truncated
                else []
            ),
        ]
    )
    truncated_sources = [
        source
        for source, truncated in (
            ("trade_decisions", decision_truncated),
            ("executions", execution_truncated),
            ("execution_order_events", order_event_truncated),
            ("execution_tca_metrics", tca_truncated),
        )
        if truncated
    ]
    readback_state = _source_activity_readback_state(
        decision_count=decision_count,
        execution_count=execution_count,
        filled_execution_count=filled_execution_count,
        fill_order_event_count=fill_order_event_count,
        complete_fill_order_event_count=complete_fill_order_event_count,
        tca_sample_count=tca_sample_count,
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
        "source_lineage_observation": source_lineage_observation,
        "source_decision_rejection_summary": decision_rejection_summary,
        "source_decision_reject_blockers": decision_reject_blockers,
        "decision_refs": decision_refs,
        "execution_refs": execution_refs,
        "order_lifecycle_refs": order_lifecycle_refs,
        "tca_metric_refs": tca_metric_refs,
        "source_window_refs": source_window_refs,
        "source_offset_refs": source_offset_refs,
        "source_reference_blockers": source_reference_blockers,
        "source_window_blockers": source_window_blockers,
        "submitted_order_blockers": submitted_order_blockers,
        "decision_count": decision_count,
        "source_decision_count": decision_count,
        "target_plan_source_decision_count": target_plan_source_decision_count,
        "source_decision_mode_counts": _source_decision_mode_counts(decision_rows),
        "execution_count": execution_count,
        "linked_execution_count": execution_count,
        "filled_execution_count": filled_execution_count,
        "order_event_count": order_event_count,
        "linked_order_lifecycle_count": order_event_count,
        "fill_order_event_count": fill_order_event_count,
        "complete_fill_order_event_count": complete_fill_order_event_count,
        "tca_sample_count": tca_sample_count,
        "explicit_cost_tca_count": tca_sample_count,
        "source_window_count": source_window_count,
        "linked_source_window_count": source_window_reference_count,
        "submitted_order_count": execution_count,
        "readback_state": readback_state,
        "stage_presence": {
            "source_decisions_present": decision_count > 0,
            "submitted_lifecycle_present": execution_count > 0 or order_event_count > 0,
            "fills_present": filled_execution_count > 0
            or fill_order_event_count > 0
            or complete_fill_order_event_count > 0,
            "source_refs_present": bool(
                decision_refs
                or execution_refs
                or order_lifecycle_refs
                or tca_metric_refs
                or source_window_refs
                or source_offset_refs
            ),
            "source_windows_present": source_window_count > 0,
            "runtime_execution_economics_present": tca_sample_count > 0
            or complete_fill_order_event_count > 0,
        },
        "query_limits": {
            "row_limit": PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
            "ref_limit": PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
            "decision_truncated": decision_truncated,
            "execution_truncated": execution_truncated,
            "order_event_truncated": order_event_truncated,
            "tca_truncated": tca_truncated,
            "truncated_sources": truncated_sources,
        },
        "source_lifecycle": lifecycle_summary,
        "closeout_fillability": closeout_fillability,
        "source_lifecycle_blockers": source_lifecycle_blockers,
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
        "decision_refs": [],
        "execution_refs": [],
        "order_lifecycle_refs": [],
        "tca_metric_refs": [],
        "source_reference_blockers": [
            "source_decision_refs_missing",
            "source_execution_refs_missing",
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
        ],
        "decision_count": 0,
        "execution_count": 0,
        "filled_execution_count": 0,
        "order_event_count": 0,
        "fill_order_event_count": 0,
        "complete_fill_order_event_count": 0,
        "tca_sample_count": 0,
        "readback_state": "query_unavailable",
        "stage_presence": {
            "source_decisions_present": False,
            "submitted_lifecycle_present": False,
            "fills_present": False,
            "source_refs_present": False,
            "runtime_execution_economics_present": False,
        },
        "query_limits": {
            "row_limit": PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
            "ref_limit": PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
            "decision_truncated": False,
            "execution_truncated": False,
            "order_event_truncated": False,
            "tca_truncated": False,
            "truncated_sources": [],
        },
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
        "source_lifecycle_blockers": [
            "source_decision_refs_missing",
            "source_execution_refs_missing",
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
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
    strategy_lookup_names: Sequence[str] = (),
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
    require_source_lineage: bool = False,
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
            "order_event_count": 0,
            "unlinked_order_event_count": 0,
            "foreign_linked_order_event_count": 0,
            "target_linked_order_event_count": 0,
            "client_order_id_count": 0,
            "sample_client_order_ids": [],
            "symbol_counts": {},
            "event_type_counts": {},
            "status_counts": {},
            "foreign_strategy_counts": {},
            "last_event_at": None,
            "reason": "account_label_missing",
            "blockers": [],
            "sample_order_event_refs": [],
        }
    order_event_activity_ts = _order_event_activity_timestamp()
    strategy_filters = [name for name in strategy_lookup_names if name]
    stmt = (
        select(ExecutionOrderEvent)
        .where(ExecutionOrderEvent.alpaca_account_label == account_label)
        .where(order_event_activity_ts >= window_start)
        .where(order_event_activity_ts < window_end)
    )
    if symbol_filters:
        stmt = stmt.where(ExecutionOrderEvent.symbol.in_(symbol_filters))
    _maybe_set_paper_route_audit_statement_timeout(session)
    rows = list(
        session.execute(
            stmt.order_by(order_event_activity_ts.desc()).limit(500)
        ).scalars()
    )
    target_linked_rows: list[ExecutionOrderEvent] = []
    foreign_linked_rows: list[ExecutionOrderEvent] = []
    unlinked_rows: list[ExecutionOrderEvent] = []
    foreign_strategy_counts: Counter[str] = Counter()
    for row in rows:
        decision = row.trade_decision
        if decision is None:
            unlinked_rows.append(row)
            continue
        strategy_name = _safe_text(
            getattr(getattr(decision, "strategy", None), "name", None)
        )
        strategy_matches = not strategy_filters or strategy_name in strategy_filters
        lineage_matches = (
            _source_decision_lineage_matches(
                decision,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            if require_source_lineage
            else True
        )
        if strategy_matches and lineage_matches:
            target_linked_rows.append(row)
            continue
        foreign_linked_rows.append(row)
        foreign_strategy_counts[strategy_name or "missing"] += 1
    if unlinked_rows or foreign_linked_rows:
        blockers.extend(
            [
                "paper_route_account_contamination_detected",
            ]
        )
    if unlinked_rows:
        blockers.append("unlinked_order_events_present")
    if foreign_linked_rows:
        blockers.append("foreign_order_events_present")
    client_order_ids: list[str] = []
    symbol_counts: Counter[str] = Counter()
    event_type_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    for row in [*unlinked_rows, *foreign_linked_rows]:
        if client_order_id := _safe_text(row.client_order_id):
            if client_order_id not in client_order_ids:
                client_order_ids.append(client_order_id)
        symbol_counts[_safe_text(row.symbol) or "missing"] += 1
        event_type_counts[_safe_text(row.event_type) or "missing"] += 1
        status_counts[_safe_text(row.status) or "missing"] += 1
    contaminating_rows = [*unlinked_rows, *foreign_linked_rows]
    last_event_row = (
        contaminating_rows[0] if contaminating_rows else rows[0] if rows else None
    )
    reason = _account_contamination_reason(
        unlinked_order_event_count=len(unlinked_rows),
        foreign_linked_order_event_count=len(foreign_linked_rows),
    )
    return {
        "schema_version": "torghut.paper-route-account-contamination-audit.v1",
        "scope": "target_window_account_symbol_order_events",
        "account_label": account_label,
        "symbols": symbol_filters,
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "contaminated": bool(unlinked_rows or foreign_linked_rows),
        "order_event_count": len(rows),
        "unlinked_order_event_count": len(unlinked_rows),
        "foreign_linked_order_event_count": len(foreign_linked_rows),
        "target_linked_order_event_count": len(target_linked_rows),
        "client_order_id_count": len(client_order_ids),
        "sample_client_order_ids": client_order_ids[:10],
        "symbol_counts": dict(sorted(symbol_counts.items())),
        "event_type_counts": dict(sorted(event_type_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "foreign_strategy_counts": dict(sorted(foreign_strategy_counts.items())),
        "last_event_at": _isoformat(
            _order_event_activity_at(last_event_row)
            if last_event_row is not None
            else None
        ),
        "reason": reason,
        "blockers": blockers,
        "sample_order_event_refs": [
            _order_event_sample_ref(row) for row in contaminating_rows[:10]
        ],
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

    _maybe_set_paper_route_audit_statement_timeout(session)
    before_snapshot = session.execute(
        select(PositionSnapshot)
        .where(PositionSnapshot.alpaca_account_label == account_label)
        .where(PositionSnapshot.as_of <= window_start)
        .order_by(PositionSnapshot.as_of.desc())
        .limit(1)
    ).scalar_one_or_none()
    after_snapshot = None
    if before_snapshot is None:
        _maybe_set_paper_route_audit_statement_timeout(session)
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
        "snapshot_window_start_offset_seconds": None,
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

    snapshot_cutoff = min(generated_at, window_start)
    _maybe_set_paper_route_audit_statement_timeout(session)
    snapshot = session.execute(
        select(PositionSnapshot)
        .where(PositionSnapshot.alpaca_account_label == account_label)
        .where(PositionSnapshot.as_of <= snapshot_cutoff)
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
    snapshot_window_start_offset_seconds = int(
        (snapshot_as_of - window_start).total_seconds()
    )
    blockers: list[str] = []
    if snapshot_as_of < required_after:
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
        "snapshot_window_start_offset_seconds": snapshot_window_start_offset_seconds,
        "flat": not positions and not blockers,
        "position_count": len(positions),
        "target_symbol_position_count": target_position_count,
        "non_target_symbol_position_count": non_target_position_count,
        "gross_position_market_value": _decimal_text(gross_market_value),
        "sample_positions": positions[:10],
        "blockers": blockers,
    }


def _account_clean_window_baseline_snapshot_audit(
    session: Session,
    *,
    account_label: str | None,
    symbols: Sequence[str],
    generated_at: datetime,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    """Return the flat, source-auditable baseline required for collection.

    Bounded H-PAIRS SIM collection is allowed to start only after the target
    account has an auditable flat baseline immediately before, or at, the
    window start.  Before the pre-session readiness window we surface an
    explicit pending blocker instead of marking collection ready.
    """

    required_after = window_start - timedelta(
        seconds=PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS
    )
    if generated_at < required_after:
        return {
            "schema_version": CLEAN_WINDOW_BASELINE_SCHEMA_VERSION,
            "scope": "flat_account_baseline_for_bounded_paper_route_collection",
            "state": "pending_until_clean_window_baseline",
            "account_label": account_label,
            "symbols": [
                str(item).strip().upper() for item in symbols if str(item).strip()
            ],
            "generated_at": _isoformat(generated_at),
            "window_start": _isoformat(window_start),
            "window_end": _isoformat(window_end),
            "required_after": _isoformat(required_after),
            "source": "pre_session_or_window_start_position_snapshot",
            "snapshot_id": None,
            "snapshot_as_of": None,
            "snapshot_source": None,
            "flat": None,
            "source_auditable": False,
            "position_count": 0,
            "target_symbol_position_count": 0,
            "non_target_symbol_position_count": 0,
            "sample_positions": [],
            "blockers": ["paper_route_clean_window_baseline_snapshot_pending"],
        }

    if generated_at < window_start:
        baseline = _account_pre_session_snapshot_audit(
            session,
            account_label=account_label,
            symbols=symbols,
            generated_at=generated_at,
            window_start=window_start,
            window_end=window_end,
        )
    else:
        baseline = _account_window_start_snapshot_audit(
            session,
            account_label=account_label,
            symbols=symbols,
            window_start=window_start,
            generated_at=generated_at,
        )
    blockers = _unique_text_items(baseline.get("blockers"))
    source_auditable = bool(baseline.get("flat")) and bool(
        _safe_text(baseline.get("snapshot_id")) or account_label is None
    )
    if not source_auditable and not blockers:
        blockers.append("paper_route_clean_window_baseline_snapshot_missing")
    return {
        "schema_version": CLEAN_WINDOW_BASELINE_SCHEMA_VERSION,
        "scope": "flat_account_baseline_for_bounded_paper_route_collection",
        "state": "clean" if source_auditable and not blockers else "blocked",
        "account_label": account_label,
        "symbols": [str(item).strip().upper() for item in symbols if str(item).strip()],
        "generated_at": _isoformat(generated_at),
        "window_start": _isoformat(window_start),
        "window_end": _isoformat(window_end),
        "required_after": _isoformat(required_after),
        "source": _safe_text(baseline.get("scope")),
        "snapshot_id": _safe_text(baseline.get("snapshot_id")),
        "snapshot_as_of": _safe_text(baseline.get("snapshot_as_of")),
        "snapshot_source": _safe_text(baseline.get("snapshot_source")),
        "snapshot_offset_seconds": baseline.get("snapshot_offset_seconds"),
        "flat": (
            baseline.get("flat") if isinstance(baseline.get("flat"), bool) else None
        ),
        "source_auditable": source_auditable,
        "position_count": _safe_int(baseline.get("position_count")),
        "target_symbol_position_count": _safe_int(
            baseline.get("target_symbol_position_count")
        ),
        "non_target_symbol_position_count": _safe_int(
            baseline.get("non_target_symbol_position_count")
        ),
        "gross_position_market_value": _safe_text(
            baseline.get("gross_position_market_value")
        )
        or "0",
        "sample_positions": [
            _as_mapping(item) for item in _as_sequence(baseline.get("sample_positions"))
        ],
        "blockers": blockers,
        "source_audit": baseline,
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
    required = generated_at > window_end
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
        stmt = stmt.where(RejectedSignalOutcomeEvent.symbol.in_(symbol_filters))
    _maybe_set_paper_route_audit_statement_timeout(session)
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


def _runtime_ledger_bucket_authority_payload(
    row: StrategyRuntimeLedgerBucket,
) -> dict[str, Any]:
    payload = _as_mapping(row.payload_json)
    cost_basis_counts = payload.get("cost_basis_counts") or payload.get(
        "post_cost_basis_counts"
    )
    merged: dict[str, Any] = {
        **payload,
        "fill_count": row.fill_count,
        "decision_count": row.decision_count,
        "submitted_order_count": row.submitted_order_count,
        "closed_trade_count": row.closed_trade_count,
        "open_position_count": row.open_position_count,
        "filled_notional": row.filled_notional,
        "gross_strategy_pnl": row.gross_strategy_pnl,
        "cost_amount": row.cost_amount,
        "net_strategy_pnl_after_costs": row.net_strategy_pnl_after_costs,
        "post_cost_expectancy_bps": row.post_cost_expectancy_bps,
        "ledger_schema_version": row.ledger_schema_version,
        "pnl_basis": row.pnl_basis,
        "execution_policy_hash_counts": row.execution_policy_hash_counts,
        "cost_model_hash_counts": row.cost_model_hash_counts,
        "lineage_hash_counts": row.lineage_hash_counts,
    }
    if cost_basis_counts is not None:
        merged.setdefault("cost_basis_counts", cost_basis_counts)
    return merged


def _runtime_ledger_bucket_evidence_grade(row: StrategyRuntimeLedgerBucket) -> bool:
    blockers = [
        str(item).strip()
        for item in _as_sequence(row.blockers_json)
        if str(item).strip()
    ]
    authority_payload = _runtime_ledger_bucket_authority_payload(row)
    source_authority_blockers = runtime_ledger_promotion_source_authority_blockers(
        authority_payload
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
            authority_payload.get("cost_basis_counts")
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
            _runtime_ledger_bucket_authority_payload(row)
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
    _maybe_set_paper_route_audit_statement_timeout(session)
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
    _maybe_set_paper_route_audit_statement_timeout(session)
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
    _maybe_set_paper_route_audit_statement_timeout(session)
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
    if bool(target.get("stripped_source_promotion_authority")):
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
        blockers.update(_hpairs_round_trip_identity_blockers(target))
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
        "decision_refs": _unique_text_items(source_activity.get("decision_refs")),
        "submitted_order_count": _safe_int(
            source_lifecycle.get("submitted_order_count")
            or source_activity.get("submitted_order_count")
        ),
        "execution_refs": _unique_text_items(source_activity.get("execution_refs")),
        "order_lifecycle_refs": _unique_text_items(
            source_activity.get("order_lifecycle_refs")
        ),
        "fill_count": _safe_int(source_lifecycle.get("fill_count")),
        "fill_order_event_count": _safe_int(
            source_lifecycle.get("fill_order_event_count")
        ),
        "tca_metric_refs": _unique_text_items(source_activity.get("tca_metric_refs")),
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
        "runtime_ledger_db_row_refs": _unique_text_items(
            runtime_ledger.get("db_row_refs")
        ),
        "blockers": _unique_text_items(
            [
                *(
                    _unique_text_items(source_activity.get("missing_reasons"))
                    if bool(source_activity.get("missing"))
                    else []
                ),
                *_unique_text_items(source_activity.get("source_lifecycle_blockers")),
                *_unique_text_items(source_activity.get("source_reference_blockers")),
                *_unique_text_items(account_close_state.get("blockers")),
                *(
                    ["runtime_ledger_evidence_grade_bucket_missing"]
                    if _safe_int(runtime_ledger.get("evidence_grade_bucket_count")) <= 0
                    else []
                ),
            ]
        ),
    }


def _target_evidence_readback_diagnostics(
    *,
    target: Mapping[str, object],
    source_activity: Mapping[str, object],
    runtime_ledger: Mapping[str, object],
    promotion_decisions: Mapping[str, object],
    readiness_blockers: Sequence[str],
) -> dict[str, object]:
    stage_presence = _as_mapping(source_activity.get("stage_presence"))
    decision_count = _safe_int(source_activity.get("decision_count"))
    execution_count = _safe_int(source_activity.get("execution_count"))
    filled_execution_count = _safe_int(source_activity.get("filled_execution_count"))
    fill_order_event_count = _safe_int(source_activity.get("fill_order_event_count"))
    complete_fill_order_event_count = _safe_int(
        source_activity.get("complete_fill_order_event_count")
    )
    tca_sample_count = _safe_int(source_activity.get("tca_sample_count"))
    runtime_bucket_count = _safe_int(runtime_ledger.get("bucket_count"))
    evidence_grade_runtime_bucket_count = _safe_int(
        runtime_ledger.get("evidence_grade_bucket_count")
    )
    source_decisions_present = bool(stage_presence.get("source_decisions_present")) or (
        decision_count > 0
    )
    submitted_lifecycle_present = (
        bool(stage_presence.get("submitted_lifecycle_present")) or execution_count > 0
    )
    fills_present = (
        bool(stage_presence.get("fills_present"))
        or filled_execution_count > 0
        or fill_order_event_count > 0
        or complete_fill_order_event_count > 0
    )
    source_refs_present = bool(stage_presence.get("source_refs_present")) or bool(
        _unique_text_items(source_activity.get("decision_refs"))
        or _unique_text_items(source_activity.get("execution_refs"))
        or _unique_text_items(source_activity.get("order_lifecycle_refs"))
        or _unique_text_items(source_activity.get("tca_metric_refs"))
    )
    runtime_buckets_present = runtime_bucket_count > 0
    source_activity_stage_diagnostics = _source_activity_stage_diagnostics(
        source_activity=source_activity,
        runtime_ledger=runtime_ledger,
    )
    if evidence_grade_runtime_bucket_count > 0:
        state = "evidence_grade_runtime_buckets_present"
    elif runtime_buckets_present:
        state = "runtime_buckets_present"
    elif tca_sample_count > 0:
        state = "source_execution_economics_present"
    elif fills_present:
        state = "source_fills_present"
    elif submitted_lifecycle_present:
        state = "submitted_lifecycle_present"
    elif source_decisions_present:
        state = "source_decisions_present"
    else:
        state = "no_source_activity"
    promotion_authority_blockers = _unique_text_items(
        [
            *readiness_blockers,
            *_unique_text_items(runtime_ledger.get("blockers")),
            *(
                ["final_promotion_authority_blocked"]
                if not bool(target.get("final_promotion_allowed"))
                else []
            ),
            *(
                ["promotion_decision_not_allowed"]
                if not bool(
                    _as_mapping(promotion_decisions.get("latest")).get("allowed")
                )
                and _safe_int(promotion_decisions.get("decision_count")) > 0
                else []
            ),
        ]
    )
    return {
        "schema_version": "torghut.paper-route-evidence-readback-diagnostics.v1",
        "state": state,
        "source_decisions_present": source_decisions_present,
        "submitted_lifecycle_present": submitted_lifecycle_present,
        "fills_or_executions_present": fills_present,
        "source_refs_present": source_refs_present,
        "runtime_buckets_present": runtime_buckets_present,
        "evidence_grade_runtime_buckets_present": (
            evidence_grade_runtime_bucket_count > 0
        ),
        "source_activity_stage_diagnostics": source_activity_stage_diagnostics,
        "runtime_bucket_count": runtime_bucket_count,
        "evidence_grade_runtime_bucket_count": evidence_grade_runtime_bucket_count,
        "final_promotion_authority_blocked": not bool(
            target.get("final_promotion_allowed")
        ),
        "promotion_decision_count": _safe_int(
            promotion_decisions.get("decision_count")
        ),
        "promotion_decision_allowed_count": _safe_int(
            promotion_decisions.get("allowed_count")
        ),
        "query_unavailable": bool(source_activity.get("query_unavailable")),
        "query_limits": {
            "source_activity": _as_mapping(source_activity.get("query_limits")),
            "runtime_ledger": {
                "row_limit": _safe_int(runtime_ledger.get("query_limit")),
                "truncated": bool(runtime_ledger.get("truncated")),
            },
        },
        "blockers": promotion_authority_blockers,
    }


def _source_activity_stage_diagnostics(
    *,
    source_activity: Mapping[str, object],
    runtime_ledger: Mapping[str, object],
) -> dict[str, object]:
    stage_presence = _as_mapping(source_activity.get("stage_presence"))
    decision_count = _safe_int(source_activity.get("decision_count"))
    target_plan_source_decision_count = _safe_int(
        source_activity.get("target_plan_source_decision_count")
    )
    execution_count = _safe_int(
        source_activity.get("submitted_order_count")
        or source_activity.get("execution_count")
    )
    tca_sample_count = _safe_int(source_activity.get("tca_sample_count"))
    source_window_count = _safe_int(source_activity.get("source_window_count"))
    complete_fill_order_event_count = _safe_int(
        source_activity.get("complete_fill_order_event_count")
    )
    runtime_bucket_count = _safe_int(runtime_ledger.get("bucket_count"))
    source_decisions_present = bool(stage_presence.get("source_decisions_present")) or (
        decision_count > 0
    )
    source_executions_present = bool(
        stage_presence.get("submitted_lifecycle_present")
    ) or (execution_count > 0)
    source_tca_present = bool(
        stage_presence.get("runtime_execution_economics_present")
    ) or (tca_sample_count > 0 or complete_fill_order_event_count > 0)
    source_windows_present = bool(stage_presence.get("source_windows_present")) or (
        source_window_count > 0
    )
    runtime_ledger_buckets_present = runtime_bucket_count > 0
    blockers = _unique_text_items(
        [
            *(["source_decisions_missing"] if not source_decisions_present else []),
            *(["source_executions_missing"] if not source_executions_present else []),
            *(["source_tca_missing"] if not source_tca_present else []),
            *(
                ["runtime_ledger_bucket_missing"]
                if not runtime_ledger_buckets_present
                else []
            ),
        ]
    )
    return {
        "schema_version": "torghut.paper-route-source-activity-stage-diagnostics.v1",
        "source_decisions_present": source_decisions_present,
        "target_plan_source_decisions_present": target_plan_source_decision_count > 0,
        "source_executions_present": source_executions_present,
        "source_tca_present": source_tca_present,
        "source_windows_present": source_windows_present,
        "runtime_ledger_buckets_present": runtime_ledger_buckets_present,
        "decision_count": decision_count,
        "target_plan_source_decision_count": target_plan_source_decision_count,
        "execution_count": execution_count,
        "tca_sample_count": tca_sample_count,
        "source_window_count": source_window_count,
        "runtime_ledger_bucket_count": runtime_bucket_count,
        "blockers": blockers,
    }


def _collect_hpairs_zero_activity_texts(*values: object) -> list[str]:
    texts: list[str] = []
    for value in values:
        if isinstance(value, Mapping):
            for item in cast(Mapping[object, object], value).values():
                texts.extend(_collect_hpairs_zero_activity_texts(item))
            continue
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            for item in cast(Sequence[object], value):
                texts.extend(_collect_hpairs_zero_activity_texts(item))
            continue
        text = _safe_text(value)
        if text and text not in texts:
            texts.append(text)
    return texts


def _hpairs_zero_activity_reason_flags(
    *,
    blockers: Sequence[str],
    probe: Mapping[str, object],
    runtime_window_import_audit: Mapping[str, object],
    hpairs_target_count: int,
    hpairs_symbol_count: int,
    hpairs_source_decision_ready_count: int,
    hpairs_decision_count: int,
    hpairs_submitted_order_count: int,
    hpairs_tca_sample_count: int,
    hpairs_runtime_bucket_count: int,
) -> dict[str, bool]:
    normalized = {blocker.lower() for blocker in blockers}
    session_state = (
        _safe_text(runtime_window_import_audit.get("session_state")) or ""
    ).lower()
    audit_state = (_safe_text(runtime_window_import_audit.get("state")) or "").lower()
    import_ready = bool(runtime_window_import_audit.get("import_ready"))
    no_market_window = bool(
        {
            "paper_route_session_window_not_open",
            "paper_route_session_window_closed",
            "paper_route_session_window_not_closed",
            "paper_route_session_settlement_pending",
            "market_session_closed",
        }
        & normalized
    ) or session_state in {
        "waiting_for_session_open",
        "collecting_session_evidence",
        "window_closed_settlement_pending",
    }
    no_candidate_target_materialization = hpairs_target_count <= 0
    no_symbols = hpairs_symbol_count <= 0 or bool(
        {
            "paper_route_probe_symbol_missing",
            "paper_route_hpairs_aapl_amzn_legs_missing",
            "paper_route_hpairs_aapl_leg_missing",
            "paper_route_hpairs_amzn_leg_missing",
        }
        & normalized
    )
    stale_quotes = any(
        "stale_quote" in blocker or "quote_stale" in blocker for blocker in normalized
    )
    route_veto = any(
        token in blocker
        for blocker in normalized
        for token in (
            "source_reject_",
            "quote_quality",
            "missing_executable_quote",
            "spread_bps_exceeded",
            "fillability",
            "routeability",
            "paper_route_submit_blocked",
        )
    )
    risk_veto = any(
        token in blocker
        for blocker in normalized
        for token in (
            "risk",
            "buying_power",
            "notional",
            "short",
            "kill_switch",
            "account_contamination",
            "open_exposure",
            "position",
            "firewall",
        )
    )
    paper_route_disabled = (
        not bool(probe.get("configured_enabled"))
        or "paper_route_probe_disabled" in normalized
    )
    strategy_not_scheduled = hpairs_target_count > 0 and (
        hpairs_source_decision_ready_count <= 0
        or bool(
            {
                "source_strategy_lookup_missing",
                "source_strategy_missing",
                "source_strategy_disabled",
                "source_strategy_universe_excludes_probe_symbols",
            }
            & normalized
        )
    )
    source_ledger_import_not_running = (
        import_ready and hpairs_decision_count > 0 and hpairs_runtime_bucket_count <= 0
    ) or audit_state in {
        "import_due_runtime_ledger_missing",
        "import_due_runtime_ledger_not_materialized",
    }
    source_decisions_missing = (
        hpairs_target_count > 0 and hpairs_decision_count <= 0
    ) or "source_decisions_missing" in normalized
    source_executions_missing = (
        hpairs_decision_count > 0 and hpairs_submitted_order_count <= 0
    ) or "source_executions_missing" in normalized
    source_tca_missing = (
        hpairs_submitted_order_count > 0 and hpairs_tca_sample_count <= 0
    ) or "source_tca_missing" in normalized
    runtime_ledger_bucket_missing = (
        hpairs_decision_count > 0 and hpairs_runtime_bucket_count <= 0
    ) or bool(
        {
            "runtime_ledger_bucket_missing",
            "runtime_ledger_source_bucket_missing",
            "runtime_ledger_evidence_grade_bucket_missing",
        }
        & normalized
    )
    source_lineage_mismatch = bool(
        {
            "source_lineage_partial_match_only",
            "source_candidate_lineage_mismatch_current_activity",
            "source_strategy_filter_mismatch_current_activity",
        }
        & normalized
    )
    return {
        "no_market_window": no_market_window,
        "no_candidate_target_materialization": no_candidate_target_materialization,
        "no_symbols": no_symbols,
        "stale_quotes": stale_quotes,
        "route_veto": route_veto,
        "risk_veto": risk_veto,
        "paper_route_disabled": paper_route_disabled,
        "strategy_not_scheduled": strategy_not_scheduled,
        "source_lineage_mismatch": source_lineage_mismatch,
        "source_ledger_import_not_running": source_ledger_import_not_running,
        "source_decisions_missing": source_decisions_missing,
        "source_executions_missing": source_executions_missing,
        "source_tca_missing": source_tca_missing,
        "runtime_ledger_bucket_missing": runtime_ledger_bucket_missing,
    }


def _hpairs_zero_activity_state(reason_flags: Mapping[str, bool]) -> str:
    for state, flag_name in (
        ("paper_route_disabled", "paper_route_disabled"),
        ("no_candidate_target_materialization", "no_candidate_target_materialization"),
        ("no_symbols", "no_symbols"),
        ("no_market_window", "no_market_window"),
        ("strategy_not_scheduled", "strategy_not_scheduled"),
        ("source_lineage_mismatch", "source_lineage_mismatch"),
        ("risk_veto", "risk_veto"),
        ("stale_quotes", "stale_quotes"),
        ("route_veto", "route_veto"),
        ("source_ledger_import_not_running", "source_ledger_import_not_running"),
    ):
        if bool(reason_flags.get(flag_name)):
            return state
    return "activity_path_clear_or_waiting_for_source_events"


def _hpairs_zero_activity_diagnostics(
    *,
    generated_at: datetime,
    probe: Mapping[str, object],
    next_targets: Mapping[str, object],
    runtime_window_import_audit: Mapping[str, object],
    target_audits: Sequence[Mapping[str, object]],
    runtime_window_import_target_audits: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    plan_targets = [
        target
        for target in _as_mapping_items(next_targets.get("targets"))
        if _target_is_hpairs(target)
    ]
    skipped_targets = [
        target
        for target in _as_mapping_items(next_targets.get("skipped_targets"))
        if _target_is_hpairs(target)
    ]
    hpairs_audits: list[Mapping[str, object]] = []
    seen_audit_keys: set[tuple[object, ...]] = set()
    for audit in [*target_audits, *runtime_window_import_target_audits]:
        target = _as_mapping(audit.get("target"))
        if not _target_is_hpairs(target):
            continue
        audit_key = (
            _safe_text(target.get("hypothesis_id")),
            _safe_text(target.get("candidate_id")),
            _safe_text(target.get("window_start")),
            _safe_text(target.get("window_end")),
            tuple(_unique_text_items(target.get("paper_route_probe_symbols"))),
        )
        if audit_key in seen_audit_keys:
            continue
        seen_audit_keys.add(audit_key)
        hpairs_audits.append(audit)
    hpairs_target_count = len(plan_targets) if plan_targets else len(hpairs_audits)
    hpairs_symbol_count = len(
        {
            symbol
            for target in plan_targets
            for symbol in _unique_text_items(target.get("paper_route_probe_symbols"))
        }
    )
    hpairs_source_decision_ready_count = sum(
        int(bool(_as_mapping(target.get("source_decision_readiness")).get("ready")))
        for target in plan_targets
    )
    hpairs_decision_count = sum(
        _safe_int(_as_mapping(audit.get("source_activity")).get("decision_count"))
        for audit in hpairs_audits
    )
    hpairs_submitted_order_count = sum(
        _safe_int(
            _as_mapping(audit.get("source_activity")).get("submitted_order_count")
            or _as_mapping(audit.get("source_activity")).get("execution_count")
        )
        for audit in hpairs_audits
    )
    hpairs_order_event_count = sum(
        _safe_int(_as_mapping(audit.get("source_activity")).get("order_event_count"))
        for audit in hpairs_audits
    )
    hpairs_fill_count = sum(
        _safe_int(
            _as_mapping(audit.get("source_activity")).get("filled_execution_count")
        )
        + _safe_int(
            _as_mapping(audit.get("source_activity")).get("fill_order_event_count")
        )
        + _safe_int(
            _as_mapping(audit.get("source_activity")).get(
                "complete_fill_order_event_count"
            )
        )
        for audit in hpairs_audits
    )
    hpairs_tca_sample_count = sum(
        _safe_int(_as_mapping(audit.get("source_activity")).get("tca_sample_count"))
        for audit in hpairs_audits
    )
    hpairs_runtime_bucket_count = sum(
        _safe_int(_as_mapping(audit.get("runtime_ledger")).get("bucket_count"))
        for audit in hpairs_audits
    )
    hpairs_evidence_grade_runtime_bucket_count = sum(
        _safe_int(
            _as_mapping(audit.get("runtime_ledger")).get("evidence_grade_bucket_count")
        )
        for audit in hpairs_audits
    )
    audit_diagnostics = _as_mapping(runtime_window_import_audit.get("diagnostics"))
    blockers = _unique_text_items(
        [
            *_collect_hpairs_zero_activity_texts(probe.get("blocking_reasons")),
            *_collect_hpairs_zero_activity_texts(
                runtime_window_import_audit.get("blockers"),
                runtime_window_import_audit.get("target_blockers"),
                audit_diagnostics,
            ),
            *_collect_hpairs_zero_activity_texts(
                [
                    _as_mapping(target.get("source_decision_readiness")).get("blockers")
                    for target in plan_targets
                ],
                [
                    target.get("bounded_evidence_collection_blockers")
                    for target in plan_targets
                ],
                [
                    target.get("paper_route_session_collection_blockers")
                    for target in plan_targets
                ],
                [
                    target.get("paper_route_hpairs_symbol_blockers")
                    for target in plan_targets
                ],
                [target.get("candidate_blockers") for target in plan_targets],
                [
                    target.get("runtime_window_import_health_gate_blockers")
                    for target in plan_targets
                ],
                [
                    target.get("runtime_window_import_promotion_blockers")
                    for target in plan_targets
                ],
                [
                    target.get("missing_or_blocking_fields")
                    for target in skipped_targets
                ],
                [target.get("reason") for target in skipped_targets],
            ),
            *_collect_hpairs_zero_activity_texts(
                [
                    _as_mapping(audit.get("source_activity")).get("missing_reasons")
                    for audit in hpairs_audits
                ],
                [
                    _as_mapping(audit.get("source_activity")).get(
                        "source_lifecycle_blockers"
                    )
                    for audit in hpairs_audits
                ],
                [
                    _as_mapping(
                        _as_mapping(audit.get("source_activity")).get(
                            "source_lineage_observation"
                        )
                    ).get("blockers")
                    for audit in hpairs_audits
                ],
                [
                    _as_mapping(audit.get("rejected_signal_activity")).get(
                        "blocking_reasons"
                    )
                    for audit in hpairs_audits
                ],
                [
                    _as_mapping(audit.get("runtime_ledger")).get("blockers")
                    for audit in hpairs_audits
                ],
                [
                    _as_mapping(audit.get("evidence_readback")).get("blockers")
                    for audit in hpairs_audits
                ],
            ),
        ]
    )
    reason_flags = _hpairs_zero_activity_reason_flags(
        blockers=blockers,
        probe=probe,
        runtime_window_import_audit=runtime_window_import_audit,
        hpairs_target_count=hpairs_target_count,
        hpairs_symbol_count=hpairs_symbol_count,
        hpairs_source_decision_ready_count=hpairs_source_decision_ready_count,
        hpairs_decision_count=hpairs_decision_count,
        hpairs_submitted_order_count=hpairs_submitted_order_count,
        hpairs_tca_sample_count=hpairs_tca_sample_count,
        hpairs_runtime_bucket_count=hpairs_runtime_bucket_count,
    )
    session_window = _as_mapping(runtime_window_import_audit.get("session_window"))
    return {
        "schema_version": HPAIRS_ZERO_ACTIVITY_DIAGNOSTICS_SCHEMA_VERSION,
        "generated_at": _isoformat(generated_at),
        "state": _hpairs_zero_activity_state(reason_flags),
        "reason_flags": reason_flags,
        "blockers": blockers,
        "counts": {
            "hpairs_target_count": hpairs_target_count,
            "hpairs_skipped_target_count": len(skipped_targets),
            "hpairs_symbol_count": hpairs_symbol_count,
            "hpairs_source_decision_ready_count": hpairs_source_decision_ready_count,
            "hpairs_decision_count": hpairs_decision_count,
            "hpairs_submitted_order_count": hpairs_submitted_order_count,
            "hpairs_order_event_count": hpairs_order_event_count,
            "hpairs_tca_sample_count": hpairs_tca_sample_count,
            "hpairs_fill_evidence_count": hpairs_fill_count,
            "hpairs_runtime_bucket_count": hpairs_runtime_bucket_count,
            "hpairs_evidence_grade_runtime_bucket_count": (
                hpairs_evidence_grade_runtime_bucket_count
            ),
        },
        "source_activity_stage_diagnostics": {
            "schema_version": "torghut.hpairs-source-activity-stage-diagnostics.v1",
            "source_decisions_present": hpairs_decision_count > 0,
            "source_executions_present": hpairs_submitted_order_count > 0,
            "source_tca_present": hpairs_tca_sample_count > 0,
            "runtime_ledger_buckets_present": hpairs_runtime_bucket_count > 0,
            "blockers": _unique_text_items(
                [
                    *(
                        ["source_decisions_missing"]
                        if bool(reason_flags.get("source_decisions_missing"))
                        else []
                    ),
                    *(
                        ["source_executions_missing"]
                        if bool(reason_flags.get("source_executions_missing"))
                        else []
                    ),
                    *(
                        ["source_tca_missing"]
                        if bool(reason_flags.get("source_tca_missing"))
                        else []
                    ),
                    *(
                        ["runtime_ledger_bucket_missing"]
                        if bool(reason_flags.get("runtime_ledger_bucket_missing"))
                        else []
                    ),
                ]
            ),
        },
        "market_window": {
            "state": _safe_text(runtime_window_import_audit.get("session_state"))
            or _safe_text(runtime_window_import_audit.get("state")),
            "start": _safe_text(session_window.get("start")),
            "end": _safe_text(session_window.get("end")),
            "import_ready": bool(runtime_window_import_audit.get("import_ready")),
            "next_action": _safe_text(runtime_window_import_audit.get("next_action")),
        },
        "safe_to_promote": False,
        "proof_semantics": {
            "synthetic_decisions": False,
            "synthetic_orders_or_fills": False,
            "relaxes_profitability_gate": False,
        },
    }


def _evidence_window_contract(
    *,
    target: Mapping[str, object],
    account_contamination: Mapping[str, object],
    account_state: Mapping[str, object],
) -> dict[str, object]:
    contamination_blockers = _unique_text_items(account_contamination.get("blockers"))
    account_state_blockers = _unique_text_items(account_state.get("blockers"))
    if contamination_blockers:
        state = "contaminated_window_discarded"
        reason = _safe_text(account_contamination.get("reason")) or (
            "account_order_events_present"
        )
    elif account_state_blockers:
        state = "clean_window_required"
        reason = "window_start_account_state_not_clean"
    else:
        state = "clean_window_verified"
        reason = "flat_source_auditable_window_start"
    blockers = _unique_text_items([*contamination_blockers, *account_state_blockers])
    return {
        "schema_version": "torghut.paper-route-evidence-window-contract.v1",
        "state": state,
        "reason": reason,
        "proof_allowed": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "account_label": _safe_text(target.get("account_label")),
        "window_start": _safe_text(target.get("window_start")),
        "window_end": _safe_text(target.get("window_end")),
        "contaminated": bool(account_contamination.get("contaminated"))
        or bool(contamination_blockers),
        "flat_at_baseline": (
            account_state.get("flat")
            if isinstance(account_state.get("flat"), bool)
            else None
        ),
        "window_start_snapshot_id": _safe_text(account_state.get("snapshot_id")),
        "window_start_snapshot_as_of": _safe_text(account_state.get("snapshot_as_of")),
        "contamination_blockers": contamination_blockers,
        "account_state_blockers": account_state_blockers,
        "blockers": blockers,
        "sample_client_order_ids": _unique_text_items(
            account_contamination.get("sample_client_order_ids")
        ),
        "sample_order_event_refs": [
            _as_mapping(item)
            for item in _as_sequence(
                account_contamination.get("sample_order_event_refs")
            )
        ],
        "sample_positions": [
            _as_mapping(item)
            for item in _as_sequence(account_state.get("sample_positions"))
        ],
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
    source_activity_account_diagnostics = _source_activity_account_diagnostics(
        session,
        target=target,
        probe=probe,
        strategy_lookup_names=strategy_lookup_names,
        window_start=window_start,
        window_end=window_end,
    )
    account_contamination = _account_contamination_audit(
        session,
        account_label=cast(str | None, target.get("account_label")),
        symbols=_target_probe_symbols(target, probe),
        window_start=window_start,
        window_end=window_end,
        strategy_lookup_names=strategy_lookup_names,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        require_source_lineage=_target_requires_source_lineage(target),
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
    evidence_window_contract = _evidence_window_contract(
        target=target,
        account_contamination=account_contamination,
        account_state=account_state,
    )
    evidence_readback = _target_evidence_readback_diagnostics(
        target=target,
        source_activity=source_activity,
        runtime_ledger=runtime_ledger,
        promotion_decisions=promotion_decisions,
        readiness_blockers=blockers,
    )
    return {
        "target": target,
        "window": {
            "start": _isoformat(window_start),
            "end": _isoformat(window_end),
        },
        "source_activity": source_activity,
        "source_activity_account_diagnostics": source_activity_account_diagnostics,
        "account_contamination": account_contamination,
        "account_state": account_state,
        "account_close_state": account_close_state,
        "evidence_window_contract": evidence_window_contract,
        "evidence_readback": evidence_readback,
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
            "evidence_window_state": evidence_window_contract["state"],
            "evidence_collection_ok": not evidence_collection_blockers,
            "canary_collection_authorized": bool(
                target.get("canary_collection_authorized")
            )
            and not evidence_collection_blockers,
            "capital_promotion_allowed": False,
            "final_authority_ok": False,
            "promotion_allowed": bool(target.get("promotion_allowed")),
            "final_promotion_allowed": bool(target.get("final_promotion_allowed")),
            "blockers": blockers,
            "evidence_collection_blockers": evidence_collection_blockers,
            "capital_promotion_blockers": blockers,
            "promotion_authority": {
                "allowed": False,
                "final_authority_ok": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "stripped_source_promotion_authority": bool(
                    target.get("stripped_source_promotion_authority")
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
        "decision_refs": [],
        "execution_refs": [],
        "order_lifecycle_refs": [],
        "tca_metric_refs": [],
        "source_reference_blockers": [
            "source_decision_refs_missing",
            "source_execution_refs_missing",
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
        ],
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
        "source_lifecycle_blockers": [
            "source_decision_refs_missing",
            "source_execution_refs_missing",
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
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
    runtime_ledger = {
        "bucket_count": 0,
        "evidence_grade_bucket_count": 0,
        "non_evidence_grade_bucket_count": 0,
        "returned_bucket_count": 0,
        "query_limit": RUNTIME_LEDGER_SUMMARY_ROW_LIMIT,
        "truncated": False,
        "filled_notional": "0",
        "net_strategy_pnl_after_costs": "0",
        "closed_trade_count": 0,
        "open_position_count": 0,
        "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
        "db_load_error": error_payload,
    }
    promotion_decisions = {
        "decision_count": 0,
        "allowed_count": 0,
        "latest": None,
        "db_row_refs": [],
        "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
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
            "required": generated_at > window_end,
            "state": "database_unavailable",
            "flat": None,
            "zero_open_position_evidence": False,
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
            "db_load_error": error_payload,
        },
        "evidence_window_contract": {
            "schema_version": "torghut.paper-route-evidence-window-contract.v1",
            "state": "clean_window_required",
            "reason": "database_unavailable",
            "proof_allowed": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "hypothesis_id": _safe_text(target.get("hypothesis_id")),
            "candidate_id": _safe_text(target.get("candidate_id")),
            "account_label": _safe_text(target.get("account_label")),
            "blockers": [PAPER_ROUTE_EVIDENCE_DB_UNAVAILABLE_BLOCKER, source_blocker],
        },
        "evidence_readback": _target_evidence_readback_diagnostics(
            target=target,
            source_activity=source_activity,
            runtime_ledger=runtime_ledger,
            promotion_decisions=promotion_decisions,
            readiness_blockers=blockers,
        ),
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
        "runtime_ledger": runtime_ledger,
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
        "promotion_decisions": promotion_decisions,
        "readiness": {
            "state": "evidence_collection_blocked",
            "evidence_collection_ok": False,
            "canary_collection_authorized": False,
            "capital_promotion_allowed": False,
            "final_authority_ok": False,
            "promotion_allowed": bool(target.get("promotion_allowed")),
            "final_promotion_allowed": bool(target.get("final_promotion_allowed")),
            "blockers": blockers,
            "evidence_collection_blockers": blockers,
            "capital_promotion_blockers": blockers,
            "promotion_authority": {
                "allowed": False,
                "final_authority_ok": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "stripped_source_promotion_authority": bool(
                    target.get("stripped_source_promotion_authority")
                ),
                "blockers": blockers,
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
                _as_mapping(audit.get("source_activity")).get(
                    "source_lifecycle_blockers"
                )
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
        int(
            bool(
                _as_mapping(audit.get("account_close_state")).get(
                    "zero_open_position_evidence"
                )
            )
        )
        for audit in next_target_audits
    )
    targets_with_source_backed_import_ready = sum(
        int(
            bool(
                _as_mapping(audit.get("source_backed_import_ready_metadata")).get(
                    "ready"
                )
            )
        )
        for audit in next_target_audits
    )
    import_ready = bool(session_readiness.get("import_ready"))
    session_state = _safe_text(session_readiness.get("state")) or "unknown"
    blockers: list[str]
    evidence_window_state = "clean_window_collection_pending"
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
        evidence_window_state = "contaminated_window_discarded"
    elif account_state_blockers:
        state = "import_due_account_state_not_clean"
        next_action = "reset_paper_account_or_discard_contaminated_window"
        blockers = account_state_blockers
        evidence_window_state = "clean_window_required"
    elif targets_with_source_activity < current_target_count:
        state = "import_due_source_activity_missing"
        next_action = "inspect_paper_route_source_activity_before_import"
        blockers = [
            "paper_route_source_activity_missing",
            *source_missing_reasons,
            *rejected_signal_reasons,
        ]
        evidence_window_state = "source_evidence_required"
    elif source_lifecycle_blockers:
        state = "import_due_source_lifecycle_incomplete"
        next_action = "repair_paper_route_order_fill_close_lifecycle"
        blockers = source_lifecycle_blockers
        evidence_window_state = "source_lifecycle_required"
    elif account_close_blockers:
        state = "import_due_flatten_handoff_missing"
        next_action = "run_paper_account_flatten_and_persist_position_snapshot"
        blockers = account_close_blockers
        evidence_window_state = "close_flatten_evidence_required"
    elif targets_with_runtime_ledger < current_target_count:
        state = "import_due_runtime_ledger_missing"
        next_action = "run_runtime_window_import_or_repair_source_materialization"
        blockers = [
            "runtime_ledger_bucket_missing",
            *source_runtime_ledger_blockers,
        ]
        evidence_window_state = "runtime_ledger_required"
    elif targets_with_evidence_grade_runtime_ledger < current_target_count:
        state = "runtime_ledger_imported_but_not_evidence_grade"
        next_action = "repair_runtime_ledger_bucket_authority_or_candidate"
        blockers = [
            "runtime_ledger_evidence_grade_bucket_missing",
            *runtime_ledger_blockers,
        ]
        evidence_window_state = "runtime_ledger_evidence_grade_required"
    else:
        state = "runtime_ledger_ready_for_gate_review"
        next_action = "review_runtime_ledger_profit_gates"
        blockers = []
        evidence_window_state = "clean_source_backed_window_ready_for_gate_review"
    if source_plan_target_count <= 0:
        evidence_window_state = "clean_window_required"
    elif not import_ready:
        evidence_window_state = "clean_window_collection_pending"
    elif current_target_count <= 0:
        evidence_window_state = "clean_window_required"
    target_blockers = _runtime_window_target_blockers(next_target_audits)
    return {
        "schema_version": PAPER_ROUTE_RUNTIME_WINDOW_IMPORT_AUDIT_SCHEMA_VERSION,
        "state": state,
        "evidence_window_state": evidence_window_state,
        "proof_allowed": False,
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
        source_activity_account_diagnostics = _as_mapping(
            audit.get("source_activity_account_diagnostics")
        )
        account_contamination = _as_mapping(audit.get("account_contamination"))
        account_state = _as_mapping(audit.get("account_state"))
        evidence_window_contract = _as_mapping(audit.get("evidence_window_contract"))
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
                    if _target_is_hpairs(target)
                    and not bool(source_activity.get("missing"))
                    else []
                ),
                *(
                    _unique_text_items(account_close_state.get("blockers"))
                    if _target_is_hpairs(target)
                    and not bool(source_activity.get("missing"))
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
                "source_activity_account_diagnostics": (
                    source_activity_account_diagnostics
                ),
                "account_contamination": {
                    "contaminated": bool(account_contamination.get("contaminated")),
                    "order_event_count": _safe_int(
                        account_contamination.get("order_event_count")
                    ),
                    "unlinked_order_event_count": _safe_int(
                        account_contamination.get("unlinked_order_event_count")
                    ),
                    "foreign_linked_order_event_count": _safe_int(
                        account_contamination.get("foreign_linked_order_event_count")
                    ),
                    "target_linked_order_event_count": _safe_int(
                        account_contamination.get("target_linked_order_event_count")
                    ),
                    "client_order_id_count": _safe_int(
                        account_contamination.get("client_order_id_count")
                    ),
                    "sample_client_order_ids": _unique_text_items(
                        account_contamination.get("sample_client_order_ids")
                    ),
                    "sample_order_event_refs": [
                        _as_mapping(item)
                        for item in _as_sequence(
                            account_contamination.get("sample_order_event_refs")
                        )
                    ],
                    "last_event_at": _safe_text(
                        account_contamination.get("last_event_at")
                    ),
                    "reason": _safe_text(account_contamination.get("reason")),
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
                "evidence_window_contract": {
                    "state": _safe_text(evidence_window_contract.get("state")),
                    "proof_allowed": bool(
                        evidence_window_contract.get("proof_allowed")
                    ),
                    "promotion_allowed": bool(
                        evidence_window_contract.get("promotion_allowed")
                    ),
                    "final_promotion_allowed": bool(
                        evidence_window_contract.get("final_promotion_allowed")
                    ),
                    "blockers": _unique_text_items(
                        evidence_window_contract.get("blockers")
                    ),
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
                    "snapshot_as_of": _safe_text(
                        account_close_state.get("snapshot_as_of")
                    ),
                    "position_count": _safe_int(
                        account_close_state.get("position_count")
                    ),
                    "target_symbol_position_count": _safe_int(
                        account_close_state.get("target_symbol_position_count")
                    ),
                    "sample_positions": [
                        _as_mapping(item)
                        for item in _as_sequence(
                            account_close_state.get("sample_positions")
                        )
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


def _target_audits_have_source_backed_runtime_window_import_evidence(
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
        )
    )


def _target_audit_runtime_window_discard_blockers(
    audit: Mapping[str, object],
) -> list[str]:
    evidence_window_contract = _as_mapping(audit.get("evidence_window_contract"))
    account_contamination = _as_mapping(audit.get("account_contamination"))
    account_state = _as_mapping(audit.get("account_state"))
    contract_state = _safe_text(evidence_window_contract.get("state"))
    contamination_blockers = _unique_text_items(account_contamination.get("blockers"))
    account_state_discard_blockers = [
        blocker
        for blocker in _unique_text_items(account_state.get("blockers"))
        if blocker in PAPER_ROUTE_ACCOUNT_STATE_DISCARD_BLOCKERS
    ]
    blockers = _unique_text_items(
        [*contamination_blockers, *account_state_discard_blockers]
    )
    if contract_state == "contaminated_window_discarded":
        return blockers or [contract_state]
    if contamination_blockers or account_state_discard_blockers:
        return blockers
    return blockers


def _target_audits_have_importable_source_backed_runtime_window_import_evidence(
    target_audits: Sequence[Mapping[str, object]],
) -> bool:
    return _target_audits_have_source_backed_runtime_window_import_evidence(
        target_audits
    ) and not _runtime_window_import_candidate_discard_blockers(target_audits)


def _runtime_window_import_candidate_discard_blockers(
    target_audits: Sequence[Mapping[str, object]],
) -> list[str]:
    return sorted(
        {
            blocker
            for audit in target_audits
            for blocker in _target_audit_runtime_window_discard_blockers(audit)
        }
    )


def _runtime_window_import_candidate_selection(
    *,
    latest_closed_targets: Mapping[str, object],
    latest_closed_target_audits: Sequence[Mapping[str, object]],
    selected: bool,
) -> dict[str, object]:
    source_backed = _target_audits_have_source_backed_runtime_window_import_evidence(
        latest_closed_target_audits
    )
    discard_blockers = _runtime_window_import_candidate_discard_blockers(
        latest_closed_target_audits
    )
    clean_importable = source_backed and not discard_blockers
    if selected:
        state = "selected"
        reason = "latest_closed_window_source_backed_and_clean"
    elif not latest_closed_target_audits:
        state = "not_evaluated"
        reason = "latest_closed_window_not_import_ready"
    elif discard_blockers:
        state = "rejected_contaminated_or_unclean"
        reason = "latest_closed_window_must_be_discarded"
    elif not source_backed:
        state = "rejected_source_backed_evidence_missing"
        reason = "latest_closed_window_has_no_source_backed_runtime_evidence"
    else:
        state = "rejected"
        reason = "latest_closed_window_not_selected"
    return {
        "schema_version": "torghut.paper-route-runtime-window-import-selection.v1",
        "candidate_purpose": _safe_text(latest_closed_targets.get("purpose"))
        or "latest_closed_session_paper_route_runtime_window_import",
        "selected": selected,
        "state": state,
        "reason": reason,
        "candidate_target_count": _safe_int(latest_closed_targets.get("target_count")),
        "evaluated_target_count": len(latest_closed_target_audits),
        "source_backed_evidence_present": source_backed,
        "clean_window_importable": clean_importable,
        "discard_blockers": discard_blockers,
        "evidence_window_states": sorted(
            {
                state
                for audit in latest_closed_target_audits
                if (
                    state := _safe_text(
                        _as_mapping(audit.get("evidence_window_contract")).get("state")
                    )
                )
            }
        ),
        "sample_client_order_ids": _unique_text_items(
            [
                client_order_id
                for audit in latest_closed_target_audits
                for client_order_id in _as_sequence(
                    _as_mapping(audit.get("account_contamination")).get(
                        "sample_client_order_ids"
                    )
                )
            ]
        )[:10],
        "sample_order_event_refs": [
            _as_mapping(ref)
            for audit in latest_closed_target_audits
            for ref in _as_sequence(
                _as_mapping(audit.get("account_contamination")).get(
                    "sample_order_event_refs"
                )
            )
        ][:10],
    }


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
                    "blockers": [
                        "runtime_window_import_audit_deferred_until_import_ready"
                    ],
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


def _truthy_plan_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def _live_gate_has_source_collection_pending(
    live_submission_gate: Mapping[str, Any],
) -> bool:
    blocked_reasons = {
        str(reason or "").strip()
        for reason in _as_sequence(live_submission_gate.get("blocked_reasons"))
        if str(reason or "").strip()
    }
    if RUNTIME_LEDGER_SOURCE_COLLECTION_PENDING_BLOCKER in blocked_reasons:
        return True
    if _as_mapping_items(
        live_submission_gate.get("runtime_ledger_source_collection_candidates")
    ):
        return True
    if (
        _safe_int(
            live_submission_gate.get("runtime_ledger_source_collection_candidate_total")
        )
        > 0
    ):
        return True
    plan = _as_mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    if _safe_int(plan.get("source_collection_target_count")) > 0:
        return True
    return any(
        _target_is_runtime_ledger_source_collection(target)
        for target in _as_mapping_items(plan.get("targets"))
    )


def _target_is_runtime_ledger_source_collection(
    target: Mapping[str, Any],
) -> bool:
    source_kind = _safe_text(target.get("source_kind"))
    handoff = _safe_text(target.get("handoff"))
    selected_by = _safe_text(target.get("selected_by"))
    return (
        _truthy_plan_value(target.get("source_collection_authorized"))
        or source_kind == RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
        or handoff == RUNTIME_LEDGER_SOURCE_COLLECTION_HANDOFF
        or selected_by == RUNTIME_LEDGER_SOURCE_COLLECTION_SELECTED_BY
    )


def _runtime_window_import_target_metadata(
    target: Mapping[str, Any],
) -> dict[str, object]:
    metadata: dict[str, object] = {}
    for key in (
        "dependency_quorum_decision",
        "continuity_ok",
        "continuity_reason",
        "drift_ok",
        "drift_reason",
        "paper_route_session_readiness_state",
        "paper_route_runtime_window_import_not_before",
    ):
        value = _safe_text(target.get(key))
        if value is not None:
            metadata[key] = value
    for key in (
        "runtime_window_import_health_gate_blockers",
        "runtime_window_import_promotion_blockers",
        "paper_route_session_import_blockers",
    ):
        if key in target:
            metadata[key] = _unique_text_items(target.get(key))
    for key in (
        "runtime_window_import_health_gate",
        "paper_route_runtime_import_handoff",
    ):
        value = _as_mapping(target.get(key))
        if value:
            metadata[key] = dict(value)
    if "paper_route_session_import_ready" in target:
        metadata["paper_route_session_import_ready"] = bool(
            target.get("paper_route_session_import_ready")
        )
    return metadata


def _sanitized_runtime_ledger_source_collection_target(
    target: Mapping[str, Any],
) -> dict[str, object]:
    strategy_name = _safe_text(target.get("strategy_name"))
    strategy_id = _safe_text(target.get("strategy_id"))
    runtime_strategy_name = (
        explicit_runtime_strategy_name_or_family_harness(
            runtime_strategy_name=target.get("runtime_strategy_name"),
            strategy_name=strategy_name,
            strategy_id=strategy_id,
        )
        or strategy_name
        or ""
    )
    strategy_lookup_names = _strategy_lookup_names(
        target.get("strategy_lookup_names"),
        runtime_strategy_name,
        strategy_name,
        strategy_names_from_strategy_id(strategy_id),
        derived_strategy_name_from_strategy_id(strategy_id),
    )
    account_label = (
        _safe_text(target.get("account_label")) or PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL
    )
    source_account_label = (
        _safe_text(target.get("source_account_label")) or account_label
    )
    source_kind = (
        _safe_text(target.get("source_kind"))
        or RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
    )
    final_promotion_blockers = _unique_text_items(
        target.get("final_promotion_blockers")
    ) or list(RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS)
    sanitized: dict[str, object] = {
        "hypothesis_id": _safe_text(target.get("hypothesis_id")),
        "candidate_id": _safe_text(target.get("candidate_id")),
        "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
        "strategy_family": _safe_text(target.get("strategy_family")),
        "strategy_name": strategy_name or runtime_strategy_name,
        "strategy_id": strategy_id or "",
        "runtime_strategy_name": runtime_strategy_name,
        "strategy_lookup_names": strategy_lookup_names,
        "account_label": account_label,
        "source_account_label": source_account_label,
        "account_stage_runtime_identity": {
            "account_label": account_label,
            "source_account_label": source_account_label,
            "observed_stage": _safe_text(target.get("observed_stage")) or "paper",
            "runtime_strategy_name": runtime_strategy_name,
            "source_kind": source_kind,
        },
        "source_dsn_env": _safe_text(target.get("source_dsn_env")) or "SIM_DB_DSN",
        "target_dsn_env": _safe_text(target.get("target_dsn_env")) or "SIM_DB_DSN",
        "dataset_snapshot_ref": _safe_text(target.get("dataset_snapshot_ref")) or "",
        "source_manifest_ref": _safe_text(target.get("source_manifest_ref")) or "",
        "source_kind": source_kind,
        "window_start": _safe_text(target.get("window_start")) or "",
        "window_end": _safe_text(target.get("window_end")) or "",
        "paper_probation_authorized": False,
        "paper_probation_authorization_scope": "",
        "paper_probation_satisfied_for_bounded_live_paper_collection": False,
        "source_collection_authorized": True,
        "source_collection_authorization_scope": _safe_text(
            target.get("source_collection_authorization_scope")
        )
        or "source_window_evidence_collection_only",
        "source_collection_reason_codes": _unique_text_items(
            target.get("source_collection_reason_codes")
        ),
        "proof_mode": "probation",
        "evidence_collection_ok": True,
        "canary_collection_authorized": False,
        "bounded_live_paper_collection_authorized": False,
        "bounded_evidence_collection_authorized": False,
        "capital_promotion_allowed": False,
        "final_authority_ok": False,
        "evidence_collection_stage": "paper",
        "probation_allowed": False,
        "probation_reason": "source_window_evidence_collection_pending",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "final_promotion_blockers": final_promotion_blockers,
        "candidate_blockers": _unique_text_items(target.get("candidate_blockers")),
        "runtime_ledger_target_metadata_blockers": _unique_text_items(
            target.get("runtime_ledger_target_metadata_blockers")
        )
        or final_promotion_blockers,
        "handoff": _safe_text(target.get("handoff"))
        or RUNTIME_LEDGER_SOURCE_COLLECTION_HANDOFF,
        "promotion_gate": _safe_text(target.get("promotion_gate"))
        or "runtime_ledger_live_or_live_paper_required",
        "selected_by": _safe_text(target.get("selected_by"))
        or RUNTIME_LEDGER_SOURCE_COLLECTION_SELECTED_BY,
        "selection_reason": _safe_text(target.get("selection_reason"))
        or "positive_activity_needs_source_window_runtime_evidence",
        "max_notional": "0",
        "stripped_source_promotion_authority": bool(
            target.get("promotion_allowed")
            or target.get("final_promotion_allowed")
            or target.get("final_promotion_authorized")
        ),
    }
    sanitized.update(_runtime_window_import_target_metadata(target))
    if runtime_ledger_bucket_ref := _safe_text(target.get("runtime_ledger_bucket_ref")):
        sanitized["runtime_ledger_bucket_ref"] = runtime_ledger_bucket_ref
    observed_from_contaminated_target = _as_mapping(
        target.get("observed_from_contaminated_target")
    )
    if observed_from_contaminated_target:
        sanitized["observed_from_contaminated_target"] = dict(
            observed_from_contaminated_target
        )
    if artifact_refs := _unique_text_items(target.get("artifact_refs")):
        sanitized["artifact_refs"] = artifact_refs
    return sanitized


def _runtime_ledger_source_collection_import_plan_for_payload(
    *,
    plan: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    target_limit: int,
) -> dict[str, object]:
    if not _live_gate_has_source_collection_pending(live_submission_gate):
        return {}
    limit = max(0, target_limit)
    source_targets: list[dict[str, object]] = []
    for target in _as_mapping_items(plan.get("targets")):
        if len(source_targets) >= limit:
            break
        if not _target_is_runtime_ledger_source_collection(target):
            continue
        source_targets.append(
            _sanitized_runtime_ledger_source_collection_target(target)
        )
    if not source_targets:
        return {}
    return {
        "schema_version": _safe_text(plan.get("schema_version"))
        or "torghut.runtime-ledger-paper-probation-import-plan.v1",
        "source": "live_submission_gate_runtime_ledger_source_collection",
        "purpose": "runtime_ledger_source_collection_import",
        "proof_mode": "probation",
        "evidence_collection_ok": True,
        "paper_probation_satisfied_for_bounded_live_paper_collection": False,
        "canary_collection_authorized": False,
        "bounded_live_paper_collection_authorized": False,
        "capital_promotion_allowed": False,
        "final_authority_ok": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "target_count": len(source_targets),
        "paper_probation_target_count": 0,
        "source_collection_target_count": len(source_targets),
        "skipped_target_count": 0,
        "targets": source_targets,
        "skipped_targets": [],
    }


def _hypothesis_manifest_ref(hypothesis_id: object) -> str:
    text = str(hypothesis_id or "").strip().lower().replace("_", "-")
    return f"config/trading/hypotheses/{text}.json" if text else ""


def _runtime_ledger_repair_candidate_lookup_names(
    candidate: Mapping[str, Any],
) -> list[str]:
    strategy_name = _safe_text(candidate.get("strategy_name"))
    strategy_id = _safe_text(candidate.get("strategy_id"))
    runtime_strategy_name = (
        explicit_runtime_strategy_name_or_family_harness(
            runtime_strategy_name=candidate.get("runtime_strategy_name"),
            strategy_name=strategy_name,
            strategy_id=strategy_id,
        )
        or strategy_name
    )
    return _strategy_lookup_names(
        candidate.get("strategy_lookup_names"),
        runtime_strategy_name,
        strategy_name,
        strategy_names_from_strategy_id(strategy_id),
        derived_strategy_name_from_strategy_id(strategy_id),
    )


def _runtime_ledger_repair_candidates_by_strategy_name(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    candidates_by_name: dict[str, Mapping[str, Any]] = {}
    candidate_sources = [
        *[
            _as_mapping_items(live_submission_gate.get(key))
            for key in (
                "runtime_ledger_repair_candidates",
                "runtime_ledger_source_collection_candidates",
            )
        ],
        _as_mapping_items(
            _as_mapping(
                live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
            ).get("targets")
        ),
    ]
    for candidates in candidate_sources:
        for candidate in candidates:
            for name in _runtime_ledger_repair_candidate_lookup_names(candidate):
                candidates_by_name.setdefault(name, candidate)
    return candidates_by_name


def _observed_strategy_source_collection_target(
    *,
    candidate: Mapping[str, Any],
    observed_strategy_name: str,
    observed_count: int,
    contaminated_target: Mapping[str, Any],
) -> dict[str, object] | None:
    hypothesis_id = _safe_text(candidate.get("hypothesis_id"))
    candidate_id = _safe_text(candidate.get("candidate_id"))
    strategy_family = _safe_text(candidate.get("strategy_family"))
    strategy_id = _safe_text(candidate.get("strategy_id"))
    strategy_name = (
        explicit_runtime_strategy_name_or_family_harness(
            runtime_strategy_name=candidate.get("runtime_strategy_name"),
            strategy_name=candidate.get("strategy_name"),
            strategy_id=strategy_id,
        )
        or observed_strategy_name
    )
    window_start = _safe_text(contaminated_target.get("window_start"))
    window_end = _safe_text(contaminated_target.get("window_end"))
    missing = [
        value
        for value in (
            hypothesis_id,
            candidate_id,
            strategy_family,
            strategy_name,
            window_start,
            window_end,
        )
        if value is None
    ]
    if missing:
        return None
    target = {
        **dict(candidate),
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id,
        "observed_stage": "paper",
        "strategy_family": strategy_family,
        "strategy_name": strategy_name,
        "runtime_strategy_name": strategy_name,
        "strategy_id": strategy_id or "",
        "strategy_lookup_names": _strategy_lookup_names(
            candidate.get("strategy_lookup_names"),
            strategy_name,
            observed_strategy_name,
            strategy_names_from_strategy_id(strategy_id),
            derived_strategy_name_from_strategy_id(strategy_id),
        ),
        "account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
        "source_account_label": PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
        "source_dsn_env": "SIM_DB_DSN",
        "target_dsn_env": "SIM_DB_DSN",
        "source_manifest_ref": _safe_text(candidate.get("source_manifest_ref"))
        or _hypothesis_manifest_ref(hypothesis_id),
        "source_kind": RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND,
        "window_start": window_start,
        "window_end": window_end,
        "source_collection_authorized": True,
        "source_collection_authorization_scope": "source_window_evidence_collection_only",
        "source_collection_reason_codes": _unique_text_items(
            [
                "paper_route_foreign_strategy_source_activity_observed",
                RUNTIME_LEDGER_SOURCE_COLLECTION_PENDING_BLOCKER,
                *(_unique_text_items(candidate.get("source_collection_reason_codes"))),
            ]
        ),
        "final_promotion_blockers": list(
            RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS
        ),
        "candidate_blockers": _unique_text_items(
            [
                "paper_route_runtime_ledger_import_pending",
                "runtime_ledger_source_collection_only",
                *(_unique_text_items(candidate.get("reason_codes"))),
                *(_unique_text_items(candidate.get("candidate_blockers"))),
            ]
        ),
        "runtime_ledger_target_metadata_blockers": list(
            RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS
        ),
        "handoff": RUNTIME_LEDGER_SOURCE_COLLECTION_HANDOFF,
        "promotion_gate": "runtime_ledger_live_or_live_paper_required",
        "selected_by": "paper_route_observed_strategy_source_collection",
        "selection_reason": "foreign_strategy_source_activity_observed_in_paper_route_window",
        "max_notional": "0",
        **_runtime_window_import_target_metadata(contaminated_target),
        "observed_from_contaminated_target": {
            "hypothesis_id": _safe_text(contaminated_target.get("hypothesis_id")),
            "candidate_id": _safe_text(contaminated_target.get("candidate_id")),
            "strategy_name": observed_strategy_name,
            "order_event_count": observed_count,
            "reason": "paper_route_account_contamination_strategy_observed",
        },
    }
    return _sanitized_runtime_ledger_source_collection_target(target)


def _runtime_window_import_plan_metadata(plan: Mapping[str, Any]) -> dict[str, object]:
    metadata: dict[str, object] = {}
    for key in (
        "session_window",
        "session_readiness",
        "runtime_window_import_handoff",
        "runtime_window_import_health_gate",
        "source_decision_readiness",
    ):
        value = _as_mapping(plan.get(key))
        if value:
            metadata[key] = dict(value)
    return metadata


def _observed_strategy_source_collection_import_plan(
    *,
    live_submission_gate: Mapping[str, Any],
    candidate_plans: Sequence[Mapping[str, Any]],
    target_limit: int,
) -> dict[str, object]:
    if not _live_gate_has_source_collection_pending(live_submission_gate):
        return {}
    candidates_by_strategy = _runtime_ledger_repair_candidates_by_strategy_name(
        live_submission_gate
    )
    if not candidates_by_strategy:
        return {}
    limit = max(0, target_limit)
    targets: list[dict[str, object]] = []
    skipped_targets: list[dict[str, object]] = []
    seen_keys: set[tuple[str, str, str, str, str]] = set()
    selected_plan: Mapping[str, Any] | None = None
    for plan in candidate_plans:
        if len(targets) >= limit:
            break
        for contaminated_target in _as_mapping_items(plan.get("targets")):
            if len(targets) >= limit:
                break
            contamination = _as_mapping(
                contaminated_target.get("paper_route_account_contamination_state")
            )
            foreign_strategy_counts = _as_mapping(
                contamination.get("foreign_strategy_counts")
            )
            if not foreign_strategy_counts:
                continue
            sorted_strategy_counts = sorted(
                (
                    (str(strategy_name or "").strip(), _safe_int(count))
                    for strategy_name, count in foreign_strategy_counts.items()
                ),
                key=lambda item: (-item[1], item[0]),
            )
            for observed_strategy_name, observed_count in sorted_strategy_counts:
                if len(targets) >= limit:
                    break
                if not observed_strategy_name or observed_strategy_name == "missing":
                    continue
                candidate = candidates_by_strategy.get(observed_strategy_name)
                if candidate is None:
                    skipped_targets.append(
                        {
                            "strategy_name": observed_strategy_name,
                            "window_start": _safe_text(
                                contaminated_target.get("window_start")
                            ),
                            "window_end": _safe_text(
                                contaminated_target.get("window_end")
                            ),
                            "reason": "observed_strategy_repair_candidate_missing",
                        }
                    )
                    continue
                target = _observed_strategy_source_collection_target(
                    candidate=candidate,
                    observed_strategy_name=observed_strategy_name,
                    observed_count=observed_count,
                    contaminated_target=contaminated_target,
                )
                if target is None:
                    skipped_targets.append(
                        {
                            "strategy_name": observed_strategy_name,
                            "reason": "observed_strategy_source_collection_target_missing_required_fields",
                        }
                    )
                    continue
                key = (
                    str(target.get("hypothesis_id") or ""),
                    str(target.get("candidate_id") or ""),
                    str(target.get("runtime_strategy_name") or ""),
                    str(target.get("window_start") or ""),
                    str(target.get("window_end") or ""),
                )
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                if selected_plan is None:
                    selected_plan = plan
                targets.append(target)
    if not targets:
        return {}
    return {
        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
        "source": "paper_route_observed_strategy_source_collection",
        "purpose": "observed_strategy_runtime_ledger_source_collection_import",
        "proof_mode": "probation",
        "evidence_collection_ok": True,
        "paper_probation_satisfied_for_bounded_live_paper_collection": False,
        "canary_collection_authorized": False,
        "bounded_live_paper_collection_authorized": False,
        "capital_promotion_allowed": False,
        "final_authority_ok": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "target_count": len(targets),
        **_runtime_window_import_plan_metadata(selected_plan or {}),
        "paper_probation_target_count": 0,
        "source_collection_target_count": len(targets),
        "skipped_target_count": len(skipped_targets),
        "targets": targets,
        "skipped_targets": skipped_targets,
    }


def build_paper_route_target_plan_payload(
    session: Session,
    *,
    live_submission_gate: Mapping[str, Any],
    route_reacquisition_book: Mapping[str, Any],
    generated_at: datetime | None = None,
    target_limit: int = DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    include_runtime_window_import_audit: bool | None = True,
    target_account_audit_available: bool = True,
) -> dict[str, object]:
    """Build the lightweight runtime-window target-plan payload."""

    resolved_generated_at = generated_at or datetime.now(timezone.utc)
    plan = _as_mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    source_collection_import_plan = (
        _runtime_ledger_source_collection_import_plan_for_payload(
            plan=plan,
            live_submission_gate=live_submission_gate,
            target_limit=target_limit,
        )
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
        target_account_audit_available=target_account_audit_available,
    )
    runtime_window_import_plan = next_targets
    next_clean_after_discard_targets: Mapping[str, Any] = {}
    latest_closed_targets: Mapping[str, Any] = {}
    source_targets: Mapping[str, Any] = source_collection_import_plan
    observed_strategy_source_targets: Mapping[str, Any] = {}
    latest_closed_runtime_window_import_target_audits: (
        list[dict[str, object]] | None
    ) = None
    latest_closed_runtime_window_import_selection = (
        _runtime_window_import_candidate_selection(
            latest_closed_targets=latest_closed_targets,
            latest_closed_target_audits=[],
            selected=False,
        )
    )
    if include_runtime_window_import_audit is not False:
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
            target_account_audit_available=target_account_audit_available,
        )
        if not _as_mapping_items(source_targets.get("targets")):
            source_targets = _next_paper_route_runtime_window_targets(
                session=session,
                targets=targets,
                probe=probe,
                live_submission_gate=live_submission_gate,
                generated_at=resolved_generated_at,
                require_clean_pre_session=False,
                target_account_audit_available=target_account_audit_available,
            )
        latest_closed_runtime_window_import_plan = (
            _runtime_window_import_plan_for_audit(
                latest_closed_targets=latest_closed_targets,
                next_targets=next_targets,
            )
        )
        if latest_closed_runtime_window_import_plan is latest_closed_targets:
            latest_closed_runtime_window_import_target_audits = [
                _target_audit_fail_closed(
                    session,
                    raw_target=target,
                    probe=probe,
                    generated_at=resolved_generated_at,
                    lookback_hours=DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
                    error_source="target_plan_runtime_window_target_audit",
                )
                for target in _as_mapping_items(latest_closed_targets.get("targets"))
            ]
            latest_closed_importable = _target_audits_have_importable_source_backed_runtime_window_import_evidence(
                latest_closed_runtime_window_import_target_audits
            )
            latest_closed_runtime_window_import_selection = (
                _runtime_window_import_candidate_selection(
                    latest_closed_targets=latest_closed_targets,
                    latest_closed_target_audits=(
                        latest_closed_runtime_window_import_target_audits
                    ),
                    selected=latest_closed_importable,
                )
            )
            if latest_closed_importable:
                runtime_window_import_plan = latest_closed_targets
            elif _runtime_window_import_candidate_discard_blockers(
                latest_closed_runtime_window_import_target_audits
            ):
                followup_window_start, followup_window_end = (
                    _following_regular_equities_session_window(closed_window_end)
                )
                next_clean_after_discard_targets = _next_paper_route_runtime_window_targets(
                    session=session,
                    targets=targets,
                    probe=probe,
                    live_submission_gate=live_submission_gate,
                    generated_at=resolved_generated_at,
                    window_start=followup_window_start,
                    window_end=followup_window_end,
                    purpose=(
                        "next_clean_session_paper_route_runtime_window_collection_after_discard"
                    ),
                    target_account_audit_available=target_account_audit_available,
                )
                runtime_window_import_plan = next_clean_after_discard_targets
        observed_strategy_source_targets = (
            _observed_strategy_source_collection_import_plan(
                live_submission_gate=live_submission_gate,
                candidate_plans=(
                    runtime_window_import_plan,
                    latest_closed_targets,
                    next_targets,
                ),
                target_limit=target_limit,
            )
        )
        if _as_mapping_items(observed_strategy_source_targets.get("targets")):
            source_targets = observed_strategy_source_targets
            runtime_window_import_plan = observed_strategy_source_targets
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
        if (
            runtime_window_import_plan is latest_closed_targets
            and latest_closed_runtime_window_import_target_audits is not None
        ):
            runtime_window_import_target_audits = (
                latest_closed_runtime_window_import_target_audits
            )
        else:
            runtime_window_import_target_audits = [
                _target_audit_fail_closed(
                    session,
                    raw_target=target,
                    probe=probe,
                    generated_at=resolved_generated_at,
                    lookback_hours=DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
                    error_source="target_plan_runtime_window_target_audit",
                )
                for target in _as_mapping_items(
                    runtime_window_import_plan.get("targets")
                )
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
        observed_strategy_source_targets,
        next_clean_after_discard_targets,
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
                "source_collection_target_count": _safe_int(
                    source_collection_import_plan.get("target_count")
                    or plan.get("source_collection_target_count")
                ),
                "targets": _as_mapping_items(
                    source_collection_import_plan.get("targets")
                ),
                "skipped_targets": _as_mapping_items(
                    source_collection_import_plan.get("skipped_targets")
                ),
                "stripped_source_promotion_authority": bool(
                    plan.get("promotion_allowed")
                    or plan.get("final_promotion_allowed")
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
        "latest_closed_runtime_window_import_selection": (
            latest_closed_runtime_window_import_selection
        ),
        "next_clean_paper_route_runtime_window_targets_after_discard": (
            next_clean_after_discard_targets
        ),
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
            "runtime_window_import_selected_latest_closed_window": bool(
                latest_closed_runtime_window_import_selection.get("selected")
            ),
            "latest_closed_runtime_window_import_selection_state": _safe_text(
                latest_closed_runtime_window_import_selection.get("state")
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
    target_account_audit_available: bool = True,
) -> dict[str, object]:
    """Build a target-by-target audit for paper-route evidence collection."""

    resolved_generated_at = generated_at or datetime.now(timezone.utc)
    effective_lookback_hours = _bounded_int(
        lookback_hours,
        default=DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
        minimum=1,
        maximum=MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    )
    effective_target_limit = _bounded_int(
        target_limit,
        default=DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
        minimum=1,
        maximum=MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    )
    plan = _as_mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    targets = _as_mapping_items(plan.get("targets"))[:effective_target_limit]
    source_collection_import_plan = (
        _runtime_ledger_source_collection_import_plan_for_payload(
            plan=plan,
            live_submission_gate=live_submission_gate,
            target_limit=effective_target_limit,
        )
    )
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
            lookback_hours=effective_lookback_hours,
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
        target_account_audit_available=target_account_audit_available,
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
        target_account_audit_available=target_account_audit_available,
    )
    next_target_audits = [
        _target_audit_fail_closed(
            session,
            raw_target=target,
            probe=probe,
            generated_at=resolved_generated_at,
            lookback_hours=effective_lookback_hours,
            error_source="paper_route_next_target_audit",
        )
        for target in _as_mapping_items(next_targets.get("targets"))
    ]
    raw_next_targets: Mapping[str, Any] = next_targets
    raw_next_target_audits: list[dict[str, object]] = next_target_audits
    runtime_window_import_plan = next_targets
    runtime_window_import_target_audits = next_target_audits
    source_targets: Mapping[str, Any] = source_collection_import_plan
    observed_strategy_source_targets: Mapping[str, Any] = {}
    next_clean_after_discard_targets: Mapping[str, Any] = {}
    latest_closed_runtime_window_import_selection = (
        _runtime_window_import_candidate_selection(
            latest_closed_targets=latest_closed_targets,
            latest_closed_target_audits=[],
            selected=False,
        )
    )
    latest_closed_runtime_window_import_plan = _runtime_window_import_plan_for_audit(
        latest_closed_targets=latest_closed_targets,
        next_targets=next_targets,
    )
    if latest_closed_runtime_window_import_plan is latest_closed_targets:
        latest_closed_target_audits = [
            _target_audit_fail_closed(
                session,
                raw_target=target,
                probe=probe,
                generated_at=resolved_generated_at,
                lookback_hours=effective_lookback_hours,
                error_source="paper_route_runtime_window_import_target_audit",
            )
            for target in _as_mapping_items(latest_closed_targets.get("targets"))
        ]
        latest_closed_importable = (
            _target_audits_have_importable_source_backed_runtime_window_import_evidence(
                latest_closed_target_audits
            )
        )
        latest_closed_runtime_window_import_selection = (
            _runtime_window_import_candidate_selection(
                latest_closed_targets=latest_closed_targets,
                latest_closed_target_audits=latest_closed_target_audits,
                selected=latest_closed_importable,
            )
        )
        if latest_closed_importable:
            runtime_window_import_plan = latest_closed_targets
            runtime_window_import_target_audits = latest_closed_target_audits
        elif _runtime_window_import_candidate_discard_blockers(
            latest_closed_target_audits
        ):
            followup_window_start, followup_window_end = (
                _following_regular_equities_session_window(closed_window_end)
            )
            next_clean_after_discard_targets = _next_paper_route_runtime_window_targets(
                session=session,
                targets=targets,
                probe=probe,
                live_submission_gate=live_submission_gate,
                generated_at=resolved_generated_at,
                window_start=followup_window_start,
                window_end=followup_window_end,
                purpose=(
                    "next_clean_session_paper_route_runtime_window_collection_after_discard"
                ),
                target_account_audit_available=target_account_audit_available,
            )
            runtime_window_import_plan = next_clean_after_discard_targets
            runtime_window_import_target_audits = [
                _target_audit_fail_closed(
                    session,
                    raw_target=target,
                    probe=probe,
                    generated_at=resolved_generated_at,
                    lookback_hours=effective_lookback_hours,
                    error_source="paper_route_runtime_window_import_target_audit",
                )
                for target in _as_mapping_items(
                    runtime_window_import_plan.get("targets")
                )
            ]
    observed_strategy_source_targets = _observed_strategy_source_collection_import_plan(
        live_submission_gate=live_submission_gate,
        candidate_plans=(
            runtime_window_import_plan,
            latest_closed_targets,
            raw_next_targets,
        ),
        target_limit=effective_target_limit,
    )
    if _as_mapping_items(observed_strategy_source_targets.get("targets")):
        source_targets = observed_strategy_source_targets
        runtime_window_import_plan = observed_strategy_source_targets
        runtime_window_import_target_audits = [
            _target_audit_fail_closed(
                session,
                raw_target=target,
                probe=probe,
                generated_at=resolved_generated_at,
                lookback_hours=effective_lookback_hours,
                error_source="paper_route_observed_strategy_source_target_audit",
            )
            for target in _as_mapping_items(runtime_window_import_plan.get("targets"))
        ]
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
    summary_target_audits: Sequence[Mapping[str, object]]
    summary_target_audit_source: str
    if (
        _as_mapping_items(observed_strategy_source_targets.get("targets"))
        and runtime_window_import_target_audits
    ):
        summary_target_audits = runtime_window_import_target_audits
        summary_target_audit_source = "runtime_window_import_target_audits"
    else:
        summary_target_audits = target_audits
        summary_target_audit_source = "paper_route_source_target_audits"
    source_plan_target_counts = _runtime_window_target_counts(target_audits)
    summary_target_counts = _runtime_window_target_counts(summary_target_audits)
    summary_blockers = sorted(
        {
            str(blocker)
            for audit in summary_target_audits
            for blocker in _as_sequence(
                _as_mapping(audit.get("readiness")).get("blockers")
            )
        }
        | {
            str(blocker).strip()
            for blocker in _as_sequence(runtime_window_import_audit.get("blockers"))
            if str(blocker).strip()
        }
    )
    if not targets:
        summary_blockers = ["paper_probation_import_plan_missing"]
    readback_items = [
        _as_mapping(audit.get("evidence_readback")) for audit in summary_target_audits
    ]
    source_activity_limits = [
        _as_mapping(_as_mapping(audit.get("source_activity")).get("query_limits"))
        for audit in summary_target_audits
    ]
    truncated_source_names = sorted(
        {
            source
            for limits in source_activity_limits
            for source in _unique_text_items(limits.get("truncated_sources"))
        }
    )
    hpairs_zero_activity_diagnostics = _hpairs_zero_activity_diagnostics(
        generated_at=resolved_generated_at,
        probe=probe,
        next_targets=raw_next_targets,
        runtime_window_import_audit=runtime_window_import_audit,
        target_audits=target_audits,
        runtime_window_import_target_audits=raw_next_target_audits,
    )
    return {
        "schema_version": PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION,
        "generated_at": _isoformat(resolved_generated_at),
        "window": {
            "lookback_hours": effective_lookback_hours,
            "requested_lookback_hours": lookback_hours,
            "max_lookback_hours": MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
            "target_limit": effective_target_limit,
            "requested_target_limit": target_limit,
            "max_target_limit": MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
            "source_activity_row_limit": PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
            "source_activity_ref_limit": PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
            "runtime_ledger_row_limit": RUNTIME_LEDGER_SUMMARY_ROW_LIMIT,
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
                "source_collection_target_count": _safe_int(
                    source_collection_import_plan.get("target_count")
                    or plan.get("source_collection_target_count")
                ),
                "targets": _as_mapping_items(
                    source_collection_import_plan.get("targets")
                ),
                "skipped_targets": _as_mapping_items(
                    source_collection_import_plan.get("skipped_targets")
                ),
                "stripped_source_promotion_authority": bool(
                    plan.get("promotion_allowed")
                    or plan.get("final_promotion_allowed")
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
        "raw_next_paper_route_runtime_window_targets": (
            raw_next_targets if raw_next_targets is not next_targets else {}
        ),
        "latest_closed_paper_route_runtime_window_targets": latest_closed_targets,
        "runtime_window_import_plan": runtime_window_import_plan,
        "source_runtime_window_import_plan": source_targets,
        "observed_strategy_source_runtime_window_import_plan": (
            observed_strategy_source_targets
        ),
        "latest_closed_runtime_window_import_selection": (
            latest_closed_runtime_window_import_selection
        ),
        "next_clean_paper_route_runtime_window_targets_after_discard": (
            next_clean_after_discard_targets
        ),
        "next_runtime_window_target_audits": next_target_audits,
        "raw_next_runtime_window_target_audits": (
            raw_next_target_audits
            if raw_next_target_audits is not next_target_audits
            else []
        ),
        "runtime_window_import_target_audits": runtime_window_import_target_audits,
        "runtime_window_import_audit": runtime_window_import_audit,
        "runtime_ledger_proof_packet_handoff": proof_packet_handoff,
        "summary": {
            "target_count": len(targets),
            "source_runtime_window_target_count": _safe_int(
                source_targets.get("target_count")
            ),
            "observed_strategy_source_runtime_window_target_count": _safe_int(
                observed_strategy_source_targets.get("target_count")
            ),
            "raw_next_runtime_window_target_count": _safe_int(
                raw_next_targets.get("target_count")
            ),
            "selected_next_runtime_window_target_count": _safe_int(
                next_targets.get("target_count")
            ),
            "selected_next_runtime_window_plan_source": _safe_text(
                next_targets.get("source")
            ),
            "runtime_window_import_plan_source": _safe_text(
                runtime_window_import_plan.get("source")
            ),
            "summary_target_count": len(summary_target_audits),
            "summary_target_audit_source": summary_target_audit_source,
            "source_plan_target_with_source_activity_count": (
                source_plan_target_counts["source_activity"]
            ),
            "source_plan_target_with_rejected_signal_activity_count": (
                source_plan_target_counts["rejected_signal_activity"]
            ),
            "source_plan_target_with_runtime_ledger_count": (
                source_plan_target_counts["runtime_ledger"]
            ),
            "source_plan_target_with_evidence_grade_runtime_ledger_count": (
                source_plan_target_counts["evidence_grade_runtime_ledger"]
            ),
            "source_plan_target_with_promotion_decision_count": (
                source_plan_target_counts["promotion_decision"]
            ),
            "target_with_source_activity_count": summary_target_counts[
                "source_activity"
            ],
            "target_with_rejected_signal_activity_count": summary_target_counts[
                "rejected_signal_activity"
            ],
            "target_with_runtime_ledger_count": summary_target_counts["runtime_ledger"],
            "target_with_evidence_grade_runtime_ledger_count": summary_target_counts[
                "evidence_grade_runtime_ledger"
            ],
            "target_with_promotion_decision_count": summary_target_counts[
                "promotion_decision"
            ],
            "readback": {
                "schema_version": "torghut.paper-route-evidence-readback-summary.v1",
                "target_count": len(readback_items),
                "no_source_activity_count": sum(
                    int(item.get("state") == "no_source_activity")
                    for item in readback_items
                ),
                "source_decisions_present_count": sum(
                    int(bool(item.get("source_decisions_present")))
                    for item in readback_items
                ),
                "submitted_lifecycle_present_count": sum(
                    int(bool(item.get("submitted_lifecycle_present")))
                    for item in readback_items
                ),
                "fills_or_executions_present_count": sum(
                    int(bool(item.get("fills_or_executions_present")))
                    for item in readback_items
                ),
                "source_refs_present_count": sum(
                    int(bool(item.get("source_refs_present")))
                    for item in readback_items
                ),
                "runtime_buckets_present_count": sum(
                    int(bool(item.get("runtime_buckets_present")))
                    for item in readback_items
                ),
                "evidence_grade_runtime_buckets_present_count": sum(
                    int(bool(item.get("evidence_grade_runtime_buckets_present")))
                    for item in readback_items
                ),
                "final_promotion_authority_blocked_count": sum(
                    int(bool(item.get("final_promotion_authority_blocked")))
                    for item in readback_items
                ),
                "query_unavailable_count": sum(
                    int(bool(item.get("query_unavailable"))) for item in readback_items
                ),
                "truncated_source_activity_count": sum(
                    int(bool(_unique_text_items(limits.get("truncated_sources"))))
                    for limits in source_activity_limits
                ),
                "truncated_source_activity_sources": truncated_source_names,
            },
            "promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "promotion_allowed"
                        )
                    )
                )
                for audit in summary_target_audits
            ),
            "final_promotion_allowed_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "final_promotion_allowed"
                        )
                    )
                )
                for audit in summary_target_audits
            ),
            "stripped_source_promotion_authority_count": sum(
                int(
                    bool(
                        _as_mapping(_as_mapping(audit.get("target"))).get(
                            "stripped_source_promotion_authority"
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
            "runtime_window_import_selected_latest_closed_window": bool(
                latest_closed_runtime_window_import_selection.get("selected")
            ),
            "latest_closed_runtime_window_import_selection_state": _safe_text(
                latest_closed_runtime_window_import_selection.get("state")
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
            "hpairs_zero_activity_diagnostics": hpairs_zero_activity_diagnostics,
            "blockers": summary_blockers,
        },
        "targets": target_audits,
    }


__all__ = [
    "DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION",
    "MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT",
    "PAPER_ROUTE_EVIDENCE_SCHEMA_VERSION",
    "PAPER_ROUTE_TARGET_PLAN_PAYLOAD_SCHEMA_VERSION",
    "PAPER_ROUTE_RUNTIME_WINDOW_IMPORT_AUDIT_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION",
    "build_paper_route_evidence_audit",
    "build_paper_route_target_plan_payload",
]
