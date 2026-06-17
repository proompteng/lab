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

# ruff: noqa: F401

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
from .blocker_ladder import (
    _blocker_ladder,
    _classify_verdict,
    _decision_projection_row,
    _decision_row,
    _event_quantity_present,
    _event_source_offset_present,
    _execution_row,
    _fill_event,
    _filled_execution,
    _json_value,
    _ladder_step,
    _ledger_days,
    _linked_order_event_fill,
    _next_action,
    _next_ladder_blocker,
    _order_event_row,
    _parse_cli_timestamp,
    _row_days,
    _row_list,
    _rows_on_day,
    _source_window_row,
    _sum_daily_int,
    _tca_row,
)


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return {
            str(key): item for key, item in cast(Mapping[object, object], value).items()
        }
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, *, default: str | None = None) -> str | None:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _int(value: object) -> int:
    try:
        return int(str(value if value is not None else "0"))
    except (TypeError, ValueError):
        return 0


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")
    return parsed if parsed.is_finite() else Decimal("0")


def _decimal_text(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    started_at = _parse_cli_timestamp(args.started_at)
    ended_at = _parse_cli_timestamp(args.ended_at)
    identity = CensusIdentity(
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        runtime_strategy_name=args.runtime_strategy_name,
        account_label=args.account_label,
        source_account_label=args.source_account_label,
        observed_stage=args.observed_stage,
    )
    read_error = None
    try:
        if args.fixture_json is not None:
            rows = load_fixture_rows(args.fixture_json)
            source_kind = "fixture_json"
        else:
            rows = load_dsn_rows(
                args.dsn,
                identity=identity,
                started_at=started_at,
                ended_at=ended_at,
            )
            source_kind = "sqlalchemy_dsn"
    except Exception as exc:
        rows = CensusSourceRows()
        read_error = str(exc)
        source_kind = (
            "fixture_json" if args.fixture_json is not None else "sqlalchemy_dsn"
        )
    report = build_source_proof_census(
        rows,
        identity=identity,
        started_at=started_at,
        ended_at=ended_at,
        read_error=read_error,
        source_kind=source_kind,
    )
    sys.stdout.write(census_json(report))
    verdict = _mapping(report.get("verdict"))
    return (
        1
        if args.fail_on_blockers
        and verdict.get("authority_candidate_ready") is not True
        else 0
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = ("main",)
