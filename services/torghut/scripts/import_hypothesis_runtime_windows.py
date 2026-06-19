#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import replace
import hashlib
import json
import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_CEILING, Decimal
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence, cast

import psycopg
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.db import SessionLocal
from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
    RuntimeLedgerFill,
    RuntimeLedgerBucket,
    build_runtime_ledger_buckets,
)
from app.trading.runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)
from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from app.trading.runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from app.trading.runtime_window_import import (
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    persist_observed_runtime_windows,
    resolve_hypothesis_manifest,
)

from scripts.hypothesis_runtime_window_import.common import (
    _runtime_source_row_symbol as _runtime_source_row_symbol,
    _execution_signed_qty as _execution_signed_qty,
    _execution_row_has_fill as _execution_row_has_fill,
    _source_authority_order_event_row as _source_authority_order_event_row,
    _manifest_strategy_family_for_resolution as _manifest_strategy_family_for_resolution,
    _parse_dt as _parse_dt,
    _parse_dt_or_none as _parse_dt_or_none,
    _as_mapping as _as_mapping,
    _as_sequence as _as_sequence,
    _parse_target_metadata as _parse_target_metadata,
    _decimal_or_none as _decimal_or_none,
    _text_or_none as _text_or_none,
    _row_payloads as _row_payloads,
    _first_decimal as _first_decimal,
    _first_positive_decimal as _first_positive_decimal,
    _first_text as _first_text,
    _direct_text as _direct_text,
    _bool_value as _bool_value,
    _direct_bool as _direct_bool,
    _text_values as _text_values,
    _first_bool as _first_bool,
    _position_snapshot_open_position_count as _position_snapshot_open_position_count,
    _flat_start_position_snapshot_authority as _flat_start_position_snapshot_authority,
    _runtime_ledger_equity_denominator_from_rows as _runtime_ledger_equity_denominator_from_rows,
    _json_default as _json_default,
    _stable_payload_digest as _stable_payload_digest,
    _runtime_source_lineage_hash as _runtime_source_lineage_hash,
    _attach_source_lineage_context as _attach_source_lineage_context,
    _decimal_ceil_cent as _decimal_ceil_cent,
    _row_has_alpaca_us_equity_order_source as _row_has_alpaca_us_equity_order_source,
    _alpaca_2026_equity_fee_schedule_cost as _alpaca_2026_equity_fee_schedule_cost,
    _alpaca_2026_equity_fee_schedule_hash as _alpaca_2026_equity_fee_schedule_hash,
    _cost_basis_is_alpaca_fee_schedule as _cost_basis_is_alpaca_fee_schedule,
    _first_payload_digest as _first_payload_digest,
    _first_lineage_digest as _first_lineage_digest,
    _merge_count_mappings as _merge_count_mappings,
    _source_identifier_values as _source_identifier_values,
    _source_offset_values as _source_offset_values,
    _with_canonical_runtime_source_refs as _with_canonical_runtime_source_refs,
    _nonnegative_int as _nonnegative_int,
    _metadata_text_list as _metadata_text_list,
    _runtime_ledger_tca_ref_texts as _runtime_ledger_tca_ref_texts,
    _runtime_ledger_execution_tca_metric_refs as _runtime_ledger_execution_tca_metric_refs,
    _metadata_symbol_list as _metadata_symbol_list,
    _target_metadata_source_symbols as _target_metadata_source_symbols,
    _runtime_ledger_target_metadata_artifact_refs as _runtime_ledger_target_metadata_artifact_refs,
    _metadata_nonnegative_int_or_none as _metadata_nonnegative_int_or_none,
    _runtime_window_source_kind_is_informational as _runtime_window_source_kind_is_informational,
    _source_collection_target_authorization_blockers as _source_collection_target_authorization_blockers,
    _source_kind_allows_runtime_ledger_materialization as _source_kind_allows_runtime_ledger_materialization,
    _runtime_ledger_event_type as _runtime_ledger_event_type,
    _runtime_ledger_row_time as _runtime_ledger_row_time,
    _parse_artifact_window_datetime as _parse_artifact_window_datetime,
    _window_weekday_count as _window_weekday_count,
    _runtime_ledger_artifact_candidate_ids as _runtime_ledger_artifact_candidate_ids,
)
from scripts.hypothesis_runtime_window_import.constants import (
    _LINEAGE_CONTEXT_KEYS as _LINEAGE_CONTEXT_KEYS,
    _AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS as _AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS,
    EXECUTION_ELIGIBLE_DECISION_STATUSES as EXECUTION_ELIGIBLE_DECISION_STATUSES,
    POST_COST_BASIS_RUNTIME_LEDGER as POST_COST_BASIS_RUNTIME_LEDGER,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION as POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    RUNTIME_LEDGER_ARTIFACT_SCHEMAS as RUNTIME_LEDGER_ARTIFACT_SCHEMAS,
    RUNTIME_LEDGER_BUCKET_SCHEMAS as RUNTIME_LEDGER_BUCKET_SCHEMAS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS as EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS as EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER as RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_CARRY_IN_LOOKBACK as RUNTIME_LEDGER_CARRY_IN_LOOKBACK,
    RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD as RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD,
    RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS as RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS,
    RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS as RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER as RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER as RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER,
    CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX as CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX,
    CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND as CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER as RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    EXECUTION_TCA_MISSING_BLOCKER as EXECUTION_TCA_MISSING_BLOCKER,
    _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS as _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS,
    _RUNTIME_LEDGER_DECISION_EVENTS as _RUNTIME_LEDGER_DECISION_EVENTS,
    _RUNTIME_LEDGER_FILL_EVENTS as _RUNTIME_LEDGER_FILL_EVENTS,
    _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS as _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS,
    ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER as ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER as ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER as ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER,
    ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER as ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER as ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    EXECUTION_ECONOMICS_MISSING_BLOCKER as EXECUTION_ECONOMICS_MISSING_BLOCKER,
    ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER as ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER,
    ORDER_FEED_FILL_DELTA_MISSING_BLOCKER as ORDER_FEED_FILL_DELTA_MISSING_BLOCKER,
    _EXECUTION_TCA_REF_KEYS as _EXECUTION_TCA_REF_KEYS,
    _SOURCE_WINDOW_REF_KEYS as _SOURCE_WINDOW_REF_KEYS,
    _EXECUTION_ORDER_EVENT_REF_KEYS as _EXECUTION_ORDER_EVENT_REF_KEYS,
    _RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS as _RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS,
    _RUNTIME_LIFECYCLE_IDENTIFIER_KEYS as _RUNTIME_LIFECYCLE_IDENTIFIER_KEYS,
    ALPACA_2026_EQUITY_SEC_FEE_RATE as ALPACA_2026_EQUITY_SEC_FEE_RATE,
    ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE as ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE,
    ALPACA_2026_EQUITY_TAF_CAP as ALPACA_2026_EQUITY_TAF_CAP,
    ALPACA_2026_FEE_SCHEDULE_REVISED_ON as ALPACA_2026_FEE_SCHEDULE_REVISED_ON,
    _CENT as _CENT,
    _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS as _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS,
    SOURCE_LINEAGE_CANDIDATE_KEYS as SOURCE_LINEAGE_CANDIDATE_KEYS,
    SOURCE_LINEAGE_HYPOTHESIS_KEYS as SOURCE_LINEAGE_HYPOTHESIS_KEYS,
    SOURCE_DECISION_MODE_MISSING_PARTITION as SOURCE_DECISION_MODE_MISSING_PARTITION,
)
from scripts.hypothesis_runtime_window_import.runtime_ledger_authority import (
    _promotion_grade_runtime_ledger_authority_marker_present as _promotion_grade_runtime_ledger_authority_marker_present,
    runtime_ledger_promotion_source_authority_blockers as runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_promotion_source_authority_present as runtime_ledger_promotion_source_authority_present,
    _runtime_ledger_bucket_payload as _runtime_ledger_bucket_payload,
    _mapping_hash_count as _mapping_hash_count,
    _positive_count_mapping_present as _positive_count_mapping_present,
    _runtime_ledger_explicit_costs_present as _runtime_ledger_explicit_costs_present,
    _runtime_ledger_bucket_profit_proof_blockers as _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present as _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_row_from_bucket as _runtime_ledger_tca_row_from_bucket,
    _append_runtime_ledger_tca_row_blocker as _append_runtime_ledger_tca_row_blocker,
    _with_runtime_ledger_source_authority_context as _with_runtime_ledger_source_authority_context,
)
from scripts.hypothesis_runtime_window_import.runtime_observation import (
    _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts as _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts,
    _runtime_ledger_target_metadata_blockers as _runtime_ledger_target_metadata_blockers,
    _runtime_window_import_proof_hygiene_blockers as _runtime_window_import_proof_hygiene_blockers,
    _runtime_ledger_profit_proof_present as _runtime_ledger_profit_proof_present,
    _runtime_observation_authority_payload as _runtime_observation_authority_payload,
    _runtime_ledger_tca_materialization_metadata as _runtime_ledger_tca_materialization_metadata,
    _runtime_ledger_tca_rows_from_observed_buckets as _runtime_ledger_tca_rows_from_observed_buckets,
    _runtime_observation_payload_with_observed_runtime_ledger_materialization as _runtime_observation_payload_with_observed_runtime_ledger_materialization,
    _runtime_window_import_audit_summary as _runtime_window_import_audit_summary,
)
from scripts.hypothesis_runtime_window_import.source_decisions import (
    _source_decision_priority_payloads as _source_decision_priority_payloads,
    _source_decision_mode as _source_decision_mode,
    _source_decision_profit_proof_flag as _source_decision_profit_proof_flag,
    _source_decision_target_notional_sizing_audit as _source_decision_target_notional_sizing_audit,
    _source_decision_target_notional_sizing_summary as _source_decision_target_notional_sizing_summary,
    _source_row_is_paper_route_probe_exit as _source_row_is_paper_route_probe_exit,
    _source_decision_identifier_values as _source_decision_identifier_values,
    _paper_route_probe_exit_identifiers as _paper_route_probe_exit_identifiers,
    _source_row_is_paper_route_probe_exit_or_linked as _source_row_is_paper_route_probe_exit_or_linked,
    _source_decision_mode_counts as _source_decision_mode_counts,
    _source_decision_mode_lookup as _source_decision_mode_lookup,
    _source_decision_mode_partition_key as _source_decision_mode_partition_key,
    _partition_runtime_source_rows_by_decision_mode as _partition_runtime_source_rows_by_decision_mode,
    _source_decision_rows_profit_proof_eligible as _source_decision_rows_profit_proof_eligible,
    _source_row_matches_lineage as _source_row_matches_lineage,
    _source_row_lineage_missing_or_matches as _source_row_lineage_missing_or_matches,
    _source_row_time_before as _source_row_time_before,
    _source_row_time_after_window as _source_row_time_after_window,
    _runtime_open_qtys_by_symbol_from_execution_rows as _runtime_open_qtys_by_symbol_from_execution_rows,
    _source_decision_action_offsets_open_qty as _source_decision_action_offsets_open_qty,
    _source_row_decision_ids as _source_row_decision_ids,
    _source_row_execution_ids as _source_row_execution_ids,
    _mark_post_window_closeout_source_row as _mark_post_window_closeout_source_row,
    _filter_source_rows_for_runtime_window as _filter_source_rows_for_runtime_window,
)
from scripts.hypothesis_runtime_window_import.source_windows import (
    _unique_source_window_rows as _unique_source_window_rows,
    _source_window_status_counts as _source_window_status_counts,
    _source_window_classification_counts as _source_window_classification_counts,
    _source_window_gap_count as _source_window_gap_count,
    _source_window_gap_ranges as _source_window_gap_ranges,
    _decision_lifecycle_query_row as _decision_lifecycle_query_row,
    _decision_lifecycle_query_row_has_time as _decision_lifecycle_query_row_has_time,
    _execution_query_row as _execution_query_row,
    _execution_query_row_has_time as _execution_query_row_has_time,
    _execution_query_row_has_tca_ref as _execution_query_row_has_tca_ref,
    _source_window_query_context as _source_window_query_context,
    _order_lifecycle_query_row as _order_lifecycle_query_row,
    _order_lifecycle_query_row_has_time as _order_lifecycle_query_row_has_time,
)

from scripts.hypothesis_runtime_window_import.execution_costs import (
    _runtime_execution_cost_amount as _runtime_execution_cost_amount,
    _runtime_execution_cost_basis as _runtime_execution_cost_basis,
    _strategy_name_candidates as _strategy_name_candidates,
)
from scripts.hypothesis_runtime_window_import.lifecycle_rows import (
    _execution_id_by_order_id as _execution_id_by_order_id,
    _execution_side_by_order_id as _execution_side_by_order_id,
    _fill_quantity_basis as _fill_quantity_basis,
    _order_feed_fill_delta_blockers as _order_feed_fill_delta_blockers,
    _order_feed_fill_lifecycle_blockers as _order_feed_fill_lifecycle_blockers,
    _runtime_lifecycle_identifier_values as _runtime_lifecycle_identifier_values,
    _runtime_lifecycle_ledger_row as _runtime_lifecycle_ledger_row,
    _runtime_lifecycle_strategy_identifier_values as _runtime_lifecycle_strategy_identifier_values,
    _runtime_order_id as _runtime_order_id,
    _source_order_feed_payload_delta_fill as _source_order_feed_payload_delta_fill,
    _strategy_relevant_unlinked_fill_lifecycle_rows as _strategy_relevant_unlinked_fill_lifecycle_rows,
    _with_linked_execution_id as _with_linked_execution_id,
)
from scripts.hypothesis_runtime_window_import.source_row_filters import (
    _active_carry_in_ledger_rows as _active_carry_in_ledger_rows,
    _adjust_carry_in_lot_row as _adjust_carry_in_lot_row,
    _event_sourced_fill_economics_order_ids as _event_sourced_fill_economics_order_ids,
    _execution_fill_economics_order_ids as _execution_fill_economics_order_ids,
    _execution_tca_order_ids as _execution_tca_order_ids,
    _filter_carry_in_source_rows_for_active_lots as _filter_carry_in_source_rows_for_active_lots,
    _flat_start_position_snapshot_from_cursor as _flat_start_position_snapshot_from_cursor,
    _ledger_row_decimal as _ledger_row_decimal,
    _ledger_row_decision_id as _ledger_row_decision_id,
    _ledger_row_event_type as _ledger_row_event_type,
    _ledger_row_order_id as _ledger_row_order_id,
    _ledger_row_position_key as _ledger_row_position_key,
    _ledger_row_side_sign as _ledger_row_side_sign,
    _ledger_row_symbol as _ledger_row_symbol,
    _ledger_row_text as _ledger_row_text,
    _ledger_row_time as _ledger_row_time,
    _ledger_row_value as _ledger_row_value,
    _required_order_lifecycle_source_row_count as _required_order_lifecycle_source_row_count,
    _runtime_decision_rows_before_bucket as _runtime_decision_rows_before_bucket,
    _runtime_decision_rows_for_bucket as _runtime_decision_rows_for_bucket,
    _runtime_order_rows_for_bucket as _runtime_order_rows_for_bucket,
    _runtime_source_decision_ids as _runtime_source_decision_ids,
    _runtime_source_row_before_bucket as _runtime_source_row_before_bucket,
    _runtime_source_row_in_bucket as _runtime_source_row_in_bucket,
    _runtime_unlinked_order_rows_for_bucket as _runtime_unlinked_order_rows_for_bucket,
    _source_backed_fill_lifecycle_order_ids as _source_backed_fill_lifecycle_order_ids,
    _source_backed_fill_lifecycle_rows as _source_backed_fill_lifecycle_rows,
    _source_backed_order_lifecycle_rows as _source_backed_order_lifecycle_rows,
    _source_backed_submitted_lifecycle_order_ids as _source_backed_submitted_lifecycle_order_ids,
)
from scripts.hypothesis_runtime_window_import.source_activity_context import (
    _runtime_execution_ledger_fill_from_row as _runtime_execution_ledger_fill_from_row,
    _runtime_source_context_for_bucket as _runtime_source_context_for_bucket,
    _source_activity_diagnostics_blockers as _source_activity_diagnostics_blockers,
)
from scripts.hypothesis_runtime_window_import.realized_pnl import (
    _build_realized_strategy_pnl_rows as _build_realized_strategy_pnl_rows,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import observed runtime windows into strategy hypothesis governance tables.",
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--candidate-id", default="")
    parser.add_argument("--hypothesis-id", required=True)
    parser.add_argument("--observed-stage", required=True, choices=("paper", "live"))
    parser.add_argument("--strategy-family", default="")
    parser.add_argument("--source-dsn", default="")
    parser.add_argument("--source-dsn-env", default="DB_DSN")
    parser.add_argument("--target-dsn", default="")
    parser.add_argument(
        "--target-dsn-env",
        default="",
        help=(
            "Optional environment variable for the database where imported runtime "
            "governance rows are persisted. Defaults to DB_DSN via SessionLocal."
        ),
    )
    parser.add_argument("--strategy-name", required=True)
    parser.add_argument("--account-label", required=True)
    parser.add_argument("--source-account-label", default="")
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--bucket-minutes", type=int, default=30)
    parser.add_argument("--sample-minutes", type=int, default=5)
    parser.add_argument("--source-manifest-ref", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--dataset-snapshot-ref", default="")
    parser.add_argument("--artifact-ref", action="append", default=[])
    parser.add_argument(
        "--target-metadata-json",
        default="",
        help=(
            "JSON object copied from the candidate-board runtime-window target. "
            "Used for evidence-collection-only paper probation handoffs."
        ),
    )
    parser.add_argument("--delay-adjusted-depth-stress-report-ref", default="")
    parser.add_argument("--dependency-quorum-decision", default="")
    parser.add_argument("--continuity-ok", default="")
    parser.add_argument("--drift-ok", default="")
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help=(
            "Run source, execution, TCA, and runtime-ledger proof diagnostics "
            "without writing imported governance rows."
        ),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _target_persistence_dsn(args: argparse.Namespace) -> str:
    direct_dsn = str(getattr(args, "target_dsn", "") or "").strip()
    if direct_dsn:
        return direct_dsn
    target_dsn_env = str(getattr(args, "target_dsn_env", "") or "").strip()
    if not target_dsn_env:
        return ""
    dsn = os.getenv(target_dsn_env, "").strip()
    if not dsn:
        raise RuntimeError(f"target_dsn_not_configured:{target_dsn_env}")
    return dsn


@contextmanager
def _persistence_session(args: argparse.Namespace) -> Iterator[Session]:
    target_dsn = _target_persistence_dsn(args)
    if not target_dsn:
        with SessionLocal() as session:
            yield session
        return
    engine = create_engine(
        _sqlalchemy_dsn(target_dsn),
        pool_pre_ping=True,
        future=True,
    )
    TargetSessionLocal = sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with TargetSessionLocal() as session:
            yield session
    finally:
        engine.dispose()


def _flag(value: str) -> bool:
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


def _load_json_artifact(ref: str) -> dict[str, Any]:
    text = ref.strip()
    if not text:
        return {}
    path = Path(text)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return _as_mapping(payload)


def _runtime_ledger_artifact_schema(payload: Mapping[str, Any]) -> str | None:
    return _text_or_none(
        payload.get("schema_version") or payload.get("ledger_schema_version")
    )


def _runtime_ledger_artifact_rows(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    if _runtime_ledger_artifact_schema(payload) not in RUNTIME_LEDGER_ARTIFACT_SCHEMAS:
        return []
    defaults = {
        key: value
        for key in (
            "account_label",
            "strategy_id",
            "strategy_name",
            "execution_policy_hash",
            "execution_policy_sha256",
            "cost_model_hash",
            "cost_model_sha256",
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
        )
        if (value := payload.get(key)) is not None
    }
    for key in ("runtime_ledger_rows", "ledger_rows", "rows", "events"):
        raw_rows = payload.get(key)
        if not isinstance(raw_rows, list):
            continue
        rows: list[dict[str, Any]] = []
        for raw_row in raw_rows:
            row = _as_mapping(raw_row)
            if row:
                rows.append({**defaults, **row})
        if rows:
            return rows
    return []


def _runtime_ledger_activity_times(
    rows: list[dict[str, Any]],
) -> tuple[list[datetime], list[datetime]]:
    decision_times: list[datetime] = []
    execution_times: list[datetime] = []
    for row in rows:
        event_time = _runtime_ledger_row_time(row)
        if event_time is None:
            continue
        event_type = _runtime_ledger_event_type(row)
        if event_type in _RUNTIME_LEDGER_DECISION_EVENTS:
            decision_times.append(event_time)
        elif event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            execution_times.append(event_time)
    return decision_times, execution_times


def _runtime_ledger_artifact_window_metadata(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    full_window = _as_mapping(payload.get("full_window"))
    start = _parse_artifact_window_datetime(
        payload.get("window_start")
        or payload.get("bucket_started_at")
        or payload.get("started_at")
        or payload.get("start")
        or full_window.get("start_date")
    )
    end = _parse_artifact_window_datetime(
        payload.get("window_end")
        or payload.get("bucket_ended_at")
        or payload.get("ended_at")
        or payload.get("end")
        or full_window.get("end_date"),
        date_end=True,
    )
    if start is None or end is None:
        row_times = [
            row_time
            for row in rows
            if (row_time := _runtime_ledger_row_time(row)) is not None
        ]
        if row_times:
            start = min(row_times) if start is None else start
            end = max(row_times) + timedelta(microseconds=1) if end is None else end
    if start is None or end is None or end <= start:
        return {}
    return {
        "runtime_ledger_artifact_window_start": start.isoformat(),
        "runtime_ledger_artifact_window_end": end.isoformat(),
        "runtime_ledger_artifact_window_weekday_count": _window_weekday_count(
            start=start,
            end=end,
        ),
    }


def _runtime_ledger_tca_rows_from_artifacts(
    *,
    artifact_refs: list[str],
    bucket_ranges: list[tuple[datetime, datetime, int]],
) -> tuple[list[datetime], list[datetime], list[dict[str, object]], dict[str, Any]]:
    ledger_rows: list[dict[str, Any]] = []
    tca_rows: list[dict[str, object]] = []
    loaded_refs: list[str] = []
    ignored_refs: list[str] = []
    artifact_candidates: list[str] = []
    artifact_window_metadata: list[dict[str, Any]] = []
    artifact_schema_versions: list[str] = []
    for ref in artifact_refs:
        payload = _load_json_artifact(ref)
        if not payload:
            continue
        if schema_version := _runtime_ledger_artifact_schema(payload):
            artifact_schema_versions.append(schema_version)
        rows = _runtime_ledger_artifact_rows(payload)
        if not rows:
            if _runtime_ledger_artifact_schema(payload) is not None:
                ignored_refs.append(ref)
            continue
        loaded_refs.append(ref)
        ledger_rows.extend(rows)
        artifact_candidates.extend(
            _runtime_ledger_artifact_candidate_ids(payload=payload, rows=rows)
        )
        if metadata := _runtime_ledger_artifact_window_metadata(
            payload=payload,
            rows=rows,
        ):
            artifact_window_metadata.append(metadata)
    decision_times, execution_times = _runtime_ledger_activity_times(ledger_rows)
    runtime_bucket_ranges = [(start, end) for start, end, _ in bucket_ranges]
    if ledger_rows and runtime_bucket_ranges:
        for bucket in build_runtime_ledger_buckets(
            ledger_rows,
            bucket_ranges=runtime_bucket_ranges,
            require_order_lifecycle=True,
        ):
            if (
                bucket.fill_count <= 0
                and bucket.decision_count <= 0
                and bucket.submitted_order_count <= 0
                and bucket.cancelled_order_count <= 0
                and bucket.rejected_order_count <= 0
                and bucket.unfilled_order_count <= 0
            ):
                continue
            tca_rows.append(_runtime_ledger_tca_row_from_bucket(bucket=bucket))
    metadata = {
        "runtime_ledger_artifact_refs": loaded_refs,
        "runtime_ledger_ignored_artifact_refs": ignored_refs,
        "runtime_ledger_artifact_row_count": len(ledger_rows),
        "runtime_ledger_artifact_fill_count": sum(
            1
            for row in ledger_rows
            if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
        ),
        "runtime_ledger_artifact_tca_row_count": len(tca_rows),
    }
    unique_artifact_candidates = sorted(dict.fromkeys(artifact_candidates))
    if unique_artifact_candidates:
        metadata["runtime_ledger_artifact_candidate_ids"] = unique_artifact_candidates
    if len(unique_artifact_candidates) == 1:
        metadata["runtime_ledger_artifact_candidate_id"] = unique_artifact_candidates[0]
    elif loaded_refs:
        _append_runtime_ledger_tca_row_blocker(
            tca_rows=tca_rows,
            blocker=(
                "runtime_ledger_artifact_candidate_id_missing"
                if not unique_artifact_candidates
                else "runtime_ledger_artifact_candidate_id_ambiguous"
            ),
        )
    if len(artifact_window_metadata) == 1:
        metadata.update(artifact_window_metadata[0])
    if loaded_refs:
        _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts(tca_rows)
        metadata["runtime_ledger_artifact_schema_versions"] = sorted(
            dict.fromkeys(artifact_schema_versions)
        )
        metadata["runtime_ledger_artifact_authority_class"] = (
            EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS
        )
        metadata["runtime_ledger_artifact_authority_blockers"] = list(
            EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS
        )
    return decision_times, execution_times, tca_rows, metadata


def _runtime_ledger_bucket_payload_from_row(
    row: StrategyRuntimeLedgerBucket,
) -> dict[str, object]:
    payload_json = _as_mapping(row.payload_json)
    payload = {
        "run_id": row.run_id,
        "candidate_id": row.candidate_id,
        "hypothesis_id": row.hypothesis_id,
        "observed_stage": row.observed_stage,
        "bucket_started_at": row.bucket_started_at.isoformat(),
        "bucket_ended_at": row.bucket_ended_at.isoformat(),
        "account_label": row.account_label,
        "strategy_id": row.runtime_strategy_name,
        "runtime_strategy_name": row.runtime_strategy_name,
        "strategy_family": row.strategy_family,
        "fill_count": row.fill_count,
        "decision_count": row.decision_count,
        "submitted_order_count": row.submitted_order_count,
        "cancelled_order_count": row.cancelled_order_count,
        "rejected_order_count": row.rejected_order_count,
        "unfilled_order_count": row.unfilled_order_count,
        "closed_trade_count": row.closed_trade_count,
        "open_position_count": row.open_position_count,
        "filled_notional": str(row.filled_notional),
        "gross_strategy_pnl": str(row.gross_strategy_pnl),
        "cost_amount": str(row.cost_amount),
        "net_strategy_pnl_after_costs": str(row.net_strategy_pnl_after_costs),
        "post_cost_expectancy_bps": (
            str(row.post_cost_expectancy_bps)
            if row.post_cost_expectancy_bps is not None
            else None
        ),
        "execution_policy_hash_counts": row.execution_policy_hash_counts or {},
        "cost_model_hash_counts": row.cost_model_hash_counts or {},
        "lineage_hash_counts": row.lineage_hash_counts or {},
        "blockers": row.blockers_json or [],
        "ledger_schema_version": row.ledger_schema_version,
        "pnl_basis": row.pnl_basis,
    }
    return {**payload_json, **payload}


def _runtime_ledger_tca_row_from_payload(
    *,
    payload: Mapping[str, object],
) -> dict[str, object]:
    bucket_started_at = _parse_dt_or_none(payload.get("bucket_started_at"))
    bucket_ended_at = _parse_dt_or_none(payload.get("bucket_ended_at"))
    computed_at = (
        bucket_ended_at - timedelta(microseconds=1)
        if bucket_ended_at is not None
        else bucket_started_at
    )
    filled_notional = _decimal_or_none(payload.get("filled_notional"))
    cost_amount = _decimal_or_none(payload.get("cost_amount"))
    proof_blockers = _runtime_ledger_bucket_profit_proof_blockers(payload)
    runtime_ledger_blockers = list(
        dict.fromkeys(
            [
                *_metadata_text_list(payload.get("blockers")),
                *proof_blockers,
            ]
        )
    )
    bucket_payload = {
        **dict(payload),
        "runtime_ledger_readback_source": "strategy_runtime_ledger_buckets",
    }
    if proof_blockers:
        bucket_payload["runtime_ledger_profit_proof_blockers"] = proof_blockers
        bucket_payload["blockers"] = runtime_ledger_blockers
    return {
        "computed_at": computed_at or datetime.now(timezone.utc),
        "abs_slippage_bps": (
            (cost_amount / filled_notional) * Decimal("10000")
            if cost_amount is not None
            and filled_notional is not None
            and filled_notional > 0
            else None
        ),
        "post_cost_expectancy_bps": _decimal_or_none(
            payload.get("post_cost_expectancy_bps")
        ),
        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
        "post_cost_promotion_eligible": _runtime_ledger_bucket_profit_proof_present(
            payload
        ),
        "realized_gross_pnl": _decimal_or_none(payload.get("gross_strategy_pnl")),
        "realized_net_pnl": _decimal_or_none(
            payload.get("net_strategy_pnl_after_costs")
        ),
        "turnover_notional": filled_notional,
        "runtime_ledger_blockers": runtime_ledger_blockers,
        "runtime_ledger_cost_basis_counts": payload.get("cost_basis_counts") or {},
        "runtime_ledger_pnl_basis": payload.get("pnl_basis"),
        "runtime_ledger_bucket": bucket_payload,
    }


def _runtime_ledger_bucket_metadata(
    *,
    prefix: str,
    payloads: Sequence[Mapping[str, object]],
    tca_rows: Sequence[Mapping[str, object]],
) -> dict[str, Any]:
    candidate_ids = sorted(
        {
            candidate_id
            for payload in payloads
            if (candidate_id := _text_or_none(payload.get("candidate_id"))) is not None
        }
    )
    proof_blockers = sorted(
        dict.fromkeys(
            blocker
            for payload in payloads
            for blocker in _runtime_ledger_bucket_profit_proof_blockers(payload)
        )
    )
    source_bucket_ids = sorted(
        {
            bucket_id
            for payload in payloads
            if (
                bucket_id := _text_or_none(
                    payload.get("source_runtime_ledger_bucket_id") or payload.get("id")
                )
            )
            is not None
        }
    )
    metadata: dict[str, Any] = {
        f"runtime_ledger_{prefix}_bucket_count": len(payloads),
        f"runtime_ledger_{prefix}_bucket_run_ids": sorted(
            {
                run_id
                for payload in payloads
                if (run_id := _text_or_none(payload.get("run_id"))) is not None
            }
        ),
        f"runtime_ledger_{prefix}_bucket_fill_count": sum(
            _nonnegative_int(payload.get("fill_count")) for payload in payloads
        ),
        f"runtime_ledger_{prefix}_bucket_tca_row_count": len(tca_rows),
        f"runtime_ledger_{prefix}_bucket_profit_proof_count": sum(
            1
            for payload in payloads
            if _runtime_ledger_bucket_profit_proof_present(payload)
        ),
        f"runtime_ledger_{prefix}_bucket_profit_proof_blockers": proof_blockers,
    }
    if candidate_ids:
        metadata[f"runtime_ledger_{prefix}_bucket_candidate_ids"] = candidate_ids
    if len(candidate_ids) == 1:
        metadata[f"runtime_ledger_{prefix}_bucket_candidate_id"] = candidate_ids[0]
    if source_bucket_ids:
        metadata[f"runtime_ledger_{prefix}_bucket_ids"] = source_bucket_ids
        metadata[f"runtime_ledger_{prefix}_bucket_refs"] = [
            f"postgres:strategy_runtime_ledger_buckets:{bucket_id}"
            for bucket_id in source_bucket_ids
        ]
    return metadata


def _runtime_ledger_tca_rows_from_durable_buckets(
    *,
    session: Session,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_names: list[str],
    account_label: str,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[dict[str, object]], dict[str, Any]]:
    query = select(StrategyRuntimeLedgerBucket).where(
        StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id,
        StrategyRuntimeLedgerBucket.observed_stage == observed_stage,
        StrategyRuntimeLedgerBucket.bucket_started_at < window_end,
        StrategyRuntimeLedgerBucket.bucket_ended_at > window_start,
    )
    if candidate_id:
        query = query.where(StrategyRuntimeLedgerBucket.candidate_id == candidate_id)
    if account_label:
        query = query.where(StrategyRuntimeLedgerBucket.account_label == account_label)
    if strategy_names:
        query = query.where(
            StrategyRuntimeLedgerBucket.runtime_strategy_name.in_(strategy_names)
        )
    rows = list(
        session.execute(
            query.order_by(
                StrategyRuntimeLedgerBucket.bucket_ended_at.asc(),
                StrategyRuntimeLedgerBucket.created_at.asc(),
            ).limit(500)
        )
        .scalars()
        .all()
    )
    payloads = [_runtime_ledger_bucket_payload_from_row(row) for row in rows]
    tca_rows = [
        _runtime_ledger_tca_row_from_payload(payload=payload) for payload in payloads
    ]
    metadata = _runtime_ledger_bucket_metadata(
        prefix="durable",
        payloads=payloads,
        tca_rows=tca_rows,
    )
    return tca_rows, metadata


_SOURCE_RUNTIME_LEDGER_COLUMNS = (
    "id",
    "run_id",
    "candidate_id",
    "hypothesis_id",
    "observed_stage",
    "bucket_started_at",
    "bucket_ended_at",
    "account_label",
    "runtime_strategy_name",
    "strategy_family",
    "fill_count",
    "decision_count",
    "submitted_order_count",
    "cancelled_order_count",
    "rejected_order_count",
    "unfilled_order_count",
    "closed_trade_count",
    "open_position_count",
    "filled_notional",
    "gross_strategy_pnl",
    "cost_amount",
    "net_strategy_pnl_after_costs",
    "post_cost_expectancy_bps",
    "execution_policy_hash_counts",
    "cost_model_hash_counts",
    "lineage_hash_counts",
    "blockers_json",
    "ledger_schema_version",
    "pnl_basis",
    "payload_json",
)


def _source_runtime_ledger_payload_from_row(
    row: Sequence[object],
) -> dict[str, object]:
    payload = dict(zip(_SOURCE_RUNTIME_LEDGER_COLUMNS, row, strict=True))
    payload_json = {
        key: value
        for key, value in _as_mapping(payload.get("payload_json")).items()
        if key != "payload_json"
    }
    if source_bucket_id := _text_or_none(payload.get("id")):
        source_bucket_ref = (
            f"postgres:strategy_runtime_ledger_buckets:{source_bucket_id}"
        )
        source_refs = _metadata_text_list(payload_json.get("source_refs"))
        if source_bucket_ref not in source_refs:
            source_refs.append(source_bucket_ref)
        source_row_counts = {
            str(key): _nonnegative_int(value)
            for key, value in _as_mapping(payload_json.get("source_row_counts")).items()
        }
        source_row_counts["strategy_runtime_ledger_buckets"] = max(
            1,
            source_row_counts.get("strategy_runtime_ledger_buckets", 0),
        )
        payload_json["source_refs"] = source_refs
        payload_json["source_row_counts"] = source_row_counts
        payload_json["source_runtime_ledger_bucket_id"] = source_bucket_id
        payload_json["source_runtime_ledger_bucket_ref"] = source_bucket_ref
    row_payload = {
        key: value for key, value in payload.items() if key != "payload_json"
    }
    started_at = _parse_dt_or_none(payload.get("bucket_started_at"))
    ended_at = _parse_dt_or_none(payload.get("bucket_ended_at"))
    return {
        **payload_json,
        **row_payload,
        "bucket_started_at": started_at.isoformat()
        if started_at is not None
        else payload.get("bucket_started_at"),
        "bucket_ended_at": ended_at.isoformat()
        if ended_at is not None
        else payload.get("bucket_ended_at"),
        "strategy_id": payload.get("runtime_strategy_name"),
        "execution_policy_hash_counts": _as_mapping(
            payload.get("execution_policy_hash_counts")
        ),
        "cost_model_hash_counts": _as_mapping(payload.get("cost_model_hash_counts")),
        "lineage_hash_counts": _as_mapping(payload.get("lineage_hash_counts")),
        "blockers": _metadata_text_list(payload.get("blockers_json")),
    }


def _runtime_ledger_tca_rows_from_source_dsn(
    *,
    dsn: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
) -> tuple[list[dict[str, object]], dict[str, Any]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    where_clauses = [
        "hypothesis_id = %s",
        "observed_stage = %s",
        "bucket_started_at < %s",
        "bucket_ended_at > %s",
    ]
    params: list[object] = [hypothesis_id, observed_stage, window_end, window_start]
    if candidate_id:
        where_clauses.append("candidate_id = %s")
        params.append(candidate_id)
    if account_label:
        where_clauses.append("account_label = %s")
        params.append(account_label)
    where_clauses.append("runtime_strategy_name = any(%s)")
    params.append(strategy_names)
    empty_metadata = _runtime_ledger_bucket_metadata(
        prefix="source",
        payloads=[],
        tca_rows=[],
    )
    try:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    select {", ".join(_SOURCE_RUNTIME_LEDGER_COLUMNS)}
                    from strategy_runtime_ledger_buckets
                    where {" and ".join(where_clauses)}
                    order by bucket_ended_at asc, created_at asc
                    limit 500
                    """,
                    tuple(params),
                )
                rows = cur.fetchall()
    except (
        psycopg.OperationalError,
        psycopg.errors.UndefinedTable,
        psycopg.errors.UndefinedColumn,
    ) as exc:
        return [], {
            **empty_metadata,
            "runtime_ledger_source_bucket_unavailable": type(exc).__name__,
        }
    payloads = [_source_runtime_ledger_payload_from_row(row) for row in rows]
    tca_rows = [
        _runtime_ledger_tca_row_from_payload(payload=payload) for payload in payloads
    ]
    materialized_account_label = str(target_account_label or "").strip()
    if materialized_account_label and materialized_account_label != account_label:
        tca_rows = _retarget_runtime_ledger_tca_rows(
            tca_rows,
            target_account_label=materialized_account_label,
            source_account_label=account_label,
        )
    return tca_rows, _runtime_ledger_bucket_metadata(
        prefix="source",
        payloads=payloads,
        tca_rows=tca_rows,
    )


def _retarget_source_rows_for_materialization(
    rows: Sequence[Mapping[str, object]],
    *,
    target_account_label: str,
    source_account_label: str,
) -> list[dict[str, object]]:
    if not target_account_label or target_account_label == source_account_label:
        return [dict(row) for row in rows]
    retargeted: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        source_row_account_label = (
            _first_text(payload, "account_label", "alpaca_account_label")
            or source_account_label
        )
        payload.setdefault("source_row_account_label", source_row_account_label)
        payload["source_account_label"] = source_account_label
        payload["account_label"] = target_account_label
        retargeted.append(payload)
    return retargeted


def _retarget_runtime_ledger_tca_rows(
    rows: Sequence[Mapping[str, object]],
    *,
    target_account_label: str,
    source_account_label: str,
) -> list[dict[str, object]]:
    if not target_account_label or target_account_label == source_account_label:
        return [dict(row) for row in rows]
    retargeted: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        source_row_account_label = (
            _first_text(payload, "account_label", "alpaca_account_label")
            or source_account_label
        )
        payload.setdefault("source_row_account_label", source_row_account_label)
        payload["source_account_label"] = source_account_label
        if "account_label" in payload:
            payload["account_label"] = target_account_label
        bucket = _as_mapping(payload.get("runtime_ledger_bucket"))
        if bucket:
            source_bucket_label = (
                _text_or_none(bucket.get("source_account_label"))
                or source_account_label
            )
            payload["runtime_ledger_bucket"] = {
                **bucket,
                "account_label": target_account_label,
                "source_account_label": source_bucket_label,
            }
        retargeted.append(payload)
    return retargeted


def _query_timestamps(
    *,
    dsn: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
    symbols: Sequence[str] | None = None,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
    require_source_lineage: bool = False,
    allow_authoritative_runtime_ledger_materialization: bool = False,
    source_activity_diagnostics: dict[str, Any] | None = None,
) -> tuple[list[datetime], list[datetime], list[dict[str, object]]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    source_account_label = account_label
    materialized_account_label = (
        str(target_account_label or "").strip() or source_account_label
    )
    # Source DB queries must stay on the account that produced the real activity.
    # Rows are retargeted below when the governance bucket should be materialized
    # under a distinct account label (for example a paper/live-paper source account
    # feeding the TORGHUT_SIM proof ledger).
    source_query_account_label = source_account_label
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    execution_rows: list[dict[str, object]] = []
    decision_lifecycle_rows: list[dict[str, object]] = []
    order_lifecycle_rows: list[dict[str, object]] = []
    unlinked_order_lifecycle_rows: list[dict[str, object]] = []
    carry_in_execution_rows: list[dict[str, object]] = []
    carry_in_decision_lifecycle_rows: list[dict[str, object]] = []
    carry_in_order_lifecycle_rows: list[dict[str, object]] = []
    flat_start_position_snapshot: dict[str, object] | None = None
    carry_in_window_start = window_start - RUNTIME_LEDGER_CARRY_IN_LOOKBACK
    source_activity_window_end = (
        window_end + RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD
        if allow_authoritative_runtime_ledger_materialization
        else window_end
    )
    symbol_filter = _metadata_symbol_list(symbols or ())
    if source_activity_diagnostics is not None:
        source_activity_diagnostics.update(
            {
                "strategy_name_candidates": strategy_names,
                "account_label": materialized_account_label,
                "source_account_label": source_account_label,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "source_activity_window_end": source_activity_window_end.isoformat(),
                "carry_in_window_start": carry_in_window_start.isoformat(),
                "carry_in_window_end": window_start.isoformat(),
                "source_activity_symbol_filter": symbol_filter,
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "source_lineage_required": require_source_lineage,
                "authoritative_runtime_ledger_materialization_allowed": (
                    allow_authoritative_runtime_ledger_materialization
                ),
            }
        )
    decision_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)" if symbol_filter else ""
    )
    execution_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(e.symbol) = any(%s)"
        if symbol_filter
        else ""
    )
    order_event_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(coalesce(oe.symbol, e.symbol, d.symbol)) = any(%s)"
        if symbol_filter
        else ""
    )
    unlinked_order_event_symbol_clause = (
        "\n                  and upper(oe.symbol) = any(%s)" if symbol_filter else ""
    )
    decision_symbol_params: tuple[object, ...] = (
        (symbol_filter,) if symbol_filter else ()
    )
    execution_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    order_event_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                select
                    d.id,
                    d.created_at,
                    d.symbol,
                    d.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    d.decision_json
                from trade_decisions d
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and d.status = any(%s)
                  and d.created_at >= %s
                  and d.created_at < %s
                  {decision_symbol_clause}
                order by d.created_at
                """,
                (
                    strategy_names,
                    source_query_account_label,
                    list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                    window_start,
                    source_activity_window_end,
                    *decision_symbol_params,
                ),
            )
            decision_lifecycle_rows = [
                _decision_lifecycle_query_row(row)
                for row in cur.fetchall()
                if _decision_lifecycle_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["decision_rows_before_lineage_filter"] = (
                    len(decision_lifecycle_rows)
                )
            cur.execute(
                f"""
                select
                    e.id,
                    d.id,
                    d.created_at,
                    coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                    ) as execution_event_at,
                    e.created_at,
                    e.symbol,
                    e.side,
                    e.filled_qty,
                    e.avg_fill_price,
                    t.shortfall_notional,
                    e.execution_audit_json,
                    e.raw_order,
                    e.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    d.decision_json,
                    e.alpaca_order_id,
                    e.client_order_id,
                    e.status,
                    t.id
                from executions e
                join trade_decisions d on d.id = e.trade_decision_id
                join strategies s on s.id = d.strategy_id
                left join execution_tca_metrics t on t.execution_id = e.id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and e.alpaca_account_label = %s
                  and coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                      ) >= %s
                  and coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                      ) < %s
                  {execution_symbol_clause}
                order by coalesce(
                    e.order_feed_last_event_ts,
                    e.last_update_at,
                    e.updated_at,
                    e.created_at
                )
                """,
                (
                    strategy_names,
                    source_query_account_label,
                    source_query_account_label,
                    window_start,
                    source_activity_window_end,
                    *execution_symbol_params,
                ),
            )
            execution_rows = [
                _execution_query_row(row)
                for row in cur.fetchall()
                if _execution_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["execution_rows_before_lineage_filter"] = (
                    len(execution_rows)
                )
                source_activity_diagnostics[
                    "fill_execution_rows_before_lineage_filter"
                ] = sum(1 for row in execution_rows if _execution_row_has_fill(row))
                source_activity_diagnostics[
                    "execution_tca_rows_before_lineage_filter"
                ] = sum(
                    1 for row in execution_rows if _execution_query_row_has_tca_ref(row)
                )
            cur.execute(
                f"""
                select
                    oe.id,
                    coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
                    e.id,
                    coalesce(oe.event_ts, oe.created_at),
                    oe.symbol,
                    oe.alpaca_account_label,
                    s.name,
                    d.decision_hash,
                    d.decision_json,
                    oe.alpaca_order_id,
                    oe.client_order_id,
                    oe.event_type,
                    oe.status,
                    e.side,
                    oe.qty,
                    oe.filled_qty,
                    oe.filled_qty_delta,
                    oe.avg_fill_price,
                    oe.filled_notional_delta,
                    oe.fill_quantity_basis,
                    oe.event_fingerprint,
                    oe.source_topic,
                    oe.source_partition,
                    oe.source_offset,
                    oe.source_window_id,
                    oe.raw_event,
                    e.execution_audit_json,
                    e.raw_order,
                    sw.status,
                    sw.status_reason,
                    sw.consumed_count,
                    sw.inserted_count,
                    sw.duplicate_count,
                    sw.malformed_count,
                    sw.missing_payload_count,
                    sw.missing_identity_count,
                    sw.out_of_scope_account_count,
                    sw.unlinked_execution_count,
                    sw.unlinked_decision_count,
                    sw.failed_unhandled_count,
                    sw.dropped_count,
                    sw.gap_count,
                    sw.gap_ranges
                from execution_order_events oe
                left join order_feed_source_windows sw on sw.id = oe.source_window_id
                left join lateral (
                    select matched.*
                    from (
                        select
                            array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
                            count(*) as match_count
                        from executions e_match
                        where e_match.alpaca_account_label = %s
                          and (
                                (
                                    oe.execution_id is not null
                                    and e_match.id = oe.execution_id
                                )
                                or (
                                    nullif(oe.alpaca_order_id, '') is not null
                                    and e_match.alpaca_order_id = oe.alpaca_order_id
                                )
                                or (
                                    nullif(oe.client_order_id, '') is not null
                                    and e_match.client_order_id = oe.client_order_id
                                )
                              )
                    ) exact_match
                    join executions matched on matched.id = exact_match.ids[1]
                    where exact_match.match_count = 1
                ) e on true
                left join lateral (
                    select matched.*
                    from (
                        select
                            array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
                            count(*) as match_count
                        from trade_decisions d_match
                        where d_match.alpaca_account_label = %s
                          and nullif(oe.client_order_id, '') is not null
                          and d_match.decision_hash = oe.client_order_id
                    ) exact_decision_match
                    join trade_decisions matched on matched.id = exact_decision_match.ids[1]
                    where exact_decision_match.match_count = 1
                ) d_by_client on true
                join trade_decisions d
                  on d.id = coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id)
                join strategies s on s.id = d.strategy_id
                where s.name = any(%s)
                  and d.alpaca_account_label = %s
                  and oe.alpaca_account_label = %s
                  and coalesce(oe.event_ts, oe.created_at) >= %s
                  and coalesce(oe.event_ts, oe.created_at) < %s
                  {order_event_symbol_clause}
                order by coalesce(oe.event_ts, oe.created_at), oe.created_at
                """,
                (
                    source_query_account_label,
                    source_query_account_label,
                    strategy_names,
                    source_query_account_label,
                    source_account_label,
                    window_start,
                    source_activity_window_end,
                    *order_event_symbol_params,
                ),
            )
            order_lifecycle_rows = [
                _order_lifecycle_query_row(row)
                for row in cur.fetchall()
                if _order_lifecycle_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics[
                    "order_lifecycle_rows_before_lineage_filter"
                ] = len(order_lifecycle_rows)
                source_activity_diagnostics[
                    "fill_order_lifecycle_rows_before_lineage_filter"
                ] = sum(
                    1
                    for row in order_lifecycle_rows
                    if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
                )
            (
                decision_lifecycle_rows,
                execution_rows,
                order_lifecycle_rows,
                post_window_closeout_diagnostics,
            ) = _filter_source_rows_for_runtime_window(
                decision_rows=decision_lifecycle_rows,
                execution_rows=execution_rows,
                order_lifecycle_rows=order_lifecycle_rows,
                window_end=window_end,
                closeout_end=source_activity_window_end,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                require_source_lineage=require_source_lineage,
            )
            if source_activity_diagnostics is not None:
                source_activity_diagnostics.update(post_window_closeout_diagnostics)
                source_activity_diagnostics["decision_rows_after_lineage_filter"] = len(
                    decision_lifecycle_rows
                )
                source_activity_diagnostics["execution_rows_after_lineage_filter"] = (
                    len(execution_rows)
                )
                source_activity_diagnostics[
                    "fill_execution_rows_after_lineage_filter"
                ] = sum(1 for row in execution_rows if _execution_row_has_fill(row))
                source_activity_diagnostics[
                    "execution_tca_rows_after_lineage_filter"
                ] = sum(
                    1 for row in execution_rows if _execution_query_row_has_tca_ref(row)
                )
                source_activity_diagnostics[
                    "order_lifecycle_rows_after_lineage_filter"
                ] = len(order_lifecycle_rows)
                source_activity_diagnostics[
                    "fill_order_lifecycle_rows_after_lineage_filter"
                ] = sum(
                    1
                    for row in order_lifecycle_rows
                    if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
                )
            decision_lifecycle_rows = _attach_source_lineage_context(
                decision_lifecycle_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            execution_rows = _attach_source_lineage_context(
                execution_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            order_lifecycle_rows = _attach_source_lineage_context(
                order_lifecycle_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            decisions = []
            for row in decision_lifecycle_rows:
                computed_at = row.get("computed_at")
                if isinstance(computed_at, datetime):
                    decisions.append(computed_at)
            executions = []
            for row in execution_rows:
                execution_event_at = row.get("execution_event_at")
                if isinstance(execution_event_at, datetime):
                    executions.append(execution_event_at)
            if allow_authoritative_runtime_ledger_materialization:
                cur.execute(
                    f"""
                    select
                        d.id,
                        d.created_at,
                        d.symbol,
                        d.alpaca_account_label,
                        s.name,
                        d.decision_hash,
                        d.decision_json
                    from trade_decisions d
                    join strategies s on s.id = d.strategy_id
                    where s.name = any(%s)
                      and d.alpaca_account_label = %s
                      and d.status = any(%s)
                      and d.created_at >= %s
                      and d.created_at < %s
                      {decision_symbol_clause}
                    order by d.created_at
                    """,
                    (
                        strategy_names,
                        source_query_account_label,
                        list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                        carry_in_window_start,
                        window_start,
                        *decision_symbol_params,
                    ),
                )
                carry_in_decision_lifecycle_rows = [
                    _decision_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _decision_lifecycle_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_decision_rows_before_lineage_filter"
                    ] = len(carry_in_decision_lifecycle_rows)
                carry_in_decision_lifecycle_rows = [
                    row
                    for row in carry_in_decision_lifecycle_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_decision_rows_after_lineage_filter"
                    ] = len(carry_in_decision_lifecycle_rows)
                carry_in_decision_lifecycle_rows = _attach_source_lineage_context(
                    carry_in_decision_lifecycle_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
                cur.execute(
                    f"""
                    select
                        e.id,
                        d.id,
                        d.created_at,
                        coalesce(
                            e.order_feed_last_event_ts,
                            e.last_update_at,
                            e.updated_at,
                            e.created_at
                        ) as execution_event_at,
                        e.created_at,
                        e.symbol,
                        e.side,
                        e.filled_qty,
                        e.avg_fill_price,
                        t.shortfall_notional,
                        e.execution_audit_json,
                        e.raw_order,
                        e.alpaca_account_label,
                        s.name,
                        d.decision_hash,
                        d.decision_json,
                        e.alpaca_order_id,
                        e.client_order_id,
                        e.status,
                        t.id
                    from executions e
                    join trade_decisions d on d.id = e.trade_decision_id
                    join strategies s on s.id = d.strategy_id
                    left join execution_tca_metrics t on t.execution_id = e.id
                    where s.name = any(%s)
                      and d.alpaca_account_label = %s
                      and e.alpaca_account_label = %s
                      and coalesce(
                            e.order_feed_last_event_ts,
                            e.last_update_at,
                            e.updated_at,
                            e.created_at
                          ) >= %s
                      and coalesce(
                            e.order_feed_last_event_ts,
                            e.last_update_at,
                            e.updated_at,
                            e.created_at
                          ) < %s
                      {execution_symbol_clause}
                    order by coalesce(
                        e.order_feed_last_event_ts,
                        e.last_update_at,
                        e.updated_at,
                        e.created_at
                    )
                    """,
                    (
                        strategy_names,
                        source_query_account_label,
                        source_query_account_label,
                        carry_in_window_start,
                        window_start,
                        *execution_symbol_params,
                    ),
                )
                carry_in_execution_rows = [
                    _execution_query_row(row)
                    for row in cur.fetchall()
                    if _execution_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_execution_rows_before_lineage_filter"
                    ] = len(carry_in_execution_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_execution_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_row_has_fill(row)
                    )
                    source_activity_diagnostics[
                        "carry_in_execution_tca_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_query_row_has_tca_ref(row)
                    )
                carry_in_execution_rows = [
                    row
                    for row in carry_in_execution_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_execution_rows_after_lineage_filter"
                    ] = len(carry_in_execution_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_execution_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_row_has_fill(row)
                    )
                    source_activity_diagnostics[
                        "carry_in_execution_tca_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_query_row_has_tca_ref(row)
                    )
                carry_in_execution_rows = _attach_source_lineage_context(
                    carry_in_execution_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
                cur.execute(
                    f"""
                    select
                        oe.id,
                        coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
                        e.id,
                        coalesce(oe.event_ts, oe.created_at),
                        oe.symbol,
                        oe.alpaca_account_label,
                        s.name,
                        d.decision_hash,
                        d.decision_json,
                        oe.alpaca_order_id,
                        oe.client_order_id,
                        oe.event_type,
                        oe.status,
                        e.side,
                        oe.qty,
                        oe.filled_qty,
                        oe.filled_qty_delta,
                        oe.avg_fill_price,
                        oe.filled_notional_delta,
                        oe.fill_quantity_basis,
                        oe.event_fingerprint,
                        oe.source_topic,
                        oe.source_partition,
                        oe.source_offset,
                        oe.source_window_id,
                        oe.raw_event,
                        e.execution_audit_json,
                        e.raw_order,
                        sw.status,
                        sw.status_reason,
                        sw.consumed_count,
                        sw.inserted_count,
                        sw.duplicate_count,
                        sw.malformed_count,
                        sw.missing_payload_count,
                        sw.missing_identity_count,
                        sw.out_of_scope_account_count,
                        sw.unlinked_execution_count,
                        sw.unlinked_decision_count,
                        sw.failed_unhandled_count,
                        sw.dropped_count,
                        sw.gap_count,
                        sw.gap_ranges
                    from execution_order_events oe
                    left join order_feed_source_windows sw on sw.id = oe.source_window_id
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
                                count(*) as match_count
                            from executions e_match
                            where e_match.alpaca_account_label = %s
                              and (
                                    (
                                        oe.execution_id is not null
                                        and e_match.id = oe.execution_id
                                    )
                                    or (
                                        nullif(oe.alpaca_order_id, '') is not null
                                        and e_match.alpaca_order_id = oe.alpaca_order_id
                                    )
                                    or (
                                        nullif(oe.client_order_id, '') is not null
                                        and e_match.client_order_id = oe.client_order_id
                                    )
                                  )
                        ) exact_match
                        join executions matched on matched.id = exact_match.ids[1]
                        where exact_match.match_count = 1
                    ) e on true
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
                                count(*) as match_count
                            from trade_decisions d_match
                            where d_match.alpaca_account_label = %s
                              and nullif(oe.client_order_id, '') is not null
                              and d_match.decision_hash = oe.client_order_id
                        ) exact_decision_match
                        join trade_decisions matched on matched.id = exact_decision_match.ids[1]
                        where exact_decision_match.match_count = 1
                    ) d_by_client on true
                    join trade_decisions d
                      on d.id = coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id)
                    join strategies s on s.id = d.strategy_id
                    where s.name = any(%s)
                      and d.alpaca_account_label = %s
                      and oe.alpaca_account_label = %s
                      and coalesce(oe.event_ts, oe.created_at) >= %s
                      and coalesce(oe.event_ts, oe.created_at) < %s
                      {order_event_symbol_clause}
                    order by coalesce(oe.event_ts, oe.created_at), oe.created_at
                    """,
                    (
                        source_query_account_label,
                        source_query_account_label,
                        strategy_names,
                        source_query_account_label,
                        source_account_label,
                        carry_in_window_start,
                        window_start,
                        *order_event_symbol_params,
                    ),
                )
                carry_in_order_lifecycle_rows = [
                    _order_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _order_lifecycle_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_order_lifecycle_rows_before_lineage_filter"
                    ] = len(carry_in_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_order_lifecycle_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_order_lifecycle_rows
                        if _runtime_ledger_event_type(row)
                        in _RUNTIME_LEDGER_FILL_EVENTS
                    )
                carry_in_order_lifecycle_rows = [
                    row
                    for row in carry_in_order_lifecycle_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_order_lifecycle_rows_after_lineage_filter"
                    ] = len(carry_in_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_order_lifecycle_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_order_lifecycle_rows
                        if _runtime_ledger_event_type(row)
                        in _RUNTIME_LEDGER_FILL_EVENTS
                    )
                carry_in_order_lifecycle_rows = _attach_source_lineage_context(
                    carry_in_order_lifecycle_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
            if symbol_filter:
                cur.execute(
                    f"""
                    select
                        oe.id,
                        coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id),
                        e.id,
                        coalesce(oe.event_ts, oe.created_at),
                        oe.symbol,
                        oe.alpaca_account_label,
                        null,
                        null,
                        null,
                        oe.alpaca_order_id,
                        oe.client_order_id,
                        oe.event_type,
                        oe.status,
                        e.side,
                        oe.qty,
                        oe.filled_qty,
                        oe.filled_qty_delta,
                        oe.avg_fill_price,
                        oe.filled_notional_delta,
                        oe.fill_quantity_basis,
                        oe.event_fingerprint,
                        oe.source_topic,
                        oe.source_partition,
                        oe.source_offset,
                        oe.source_window_id,
                        oe.raw_event,
                        e.execution_audit_json,
                        e.raw_order,
                        sw.status,
                        sw.status_reason,
                        sw.consumed_count,
                        sw.inserted_count,
                        sw.duplicate_count,
                        sw.malformed_count,
                        sw.missing_payload_count,
                        sw.missing_identity_count,
                        sw.out_of_scope_account_count,
                        sw.unlinked_execution_count,
                        sw.unlinked_decision_count,
                        sw.failed_unhandled_count,
                        sw.dropped_count,
                        sw.gap_count,
                        sw.gap_ranges
                    from execution_order_events oe
                    left join order_feed_source_windows sw on sw.id = oe.source_window_id
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(e_match.id order by e_match.created_at, e_match.id) as ids,
                                count(*) as match_count
                            from executions e_match
                            where e_match.alpaca_account_label = %s
                              and (
                                    (
                                        oe.execution_id is not null
                                        and e_match.id = oe.execution_id
                                    )
                                    or (
                                        nullif(oe.alpaca_order_id, '') is not null
                                        and e_match.alpaca_order_id = oe.alpaca_order_id
                                    )
                                    or (
                                        nullif(oe.client_order_id, '') is not null
                                        and e_match.client_order_id = oe.client_order_id
                                    )
                                  )
                        ) exact_match
                        join executions matched on matched.id = exact_match.ids[1]
                        where exact_match.match_count = 1
                    ) e on true
                    left join lateral (
                        select matched.*
                        from (
                            select
                                array_agg(d_match.id order by d_match.created_at, d_match.id) as ids,
                                count(*) as match_count
                            from trade_decisions d_match
                            where d_match.alpaca_account_label = %s
                              and nullif(oe.client_order_id, '') is not null
                              and d_match.decision_hash = oe.client_order_id
                        ) exact_decision_match
                        join trade_decisions matched on matched.id = exact_decision_match.ids[1]
                        where exact_decision_match.match_count = 1
                    ) d_by_client on true
                    where oe.alpaca_account_label = %s
                      and coalesce(oe.event_ts, oe.created_at) >= %s
                      and coalesce(oe.event_ts, oe.created_at) < %s
                      and (
                            e.id is null
                            or coalesce(oe.trade_decision_id, e.trade_decision_id, d_by_client.id) is null
                          )
                      and (
                            lower(coalesce(oe.event_type, oe.status, '')) in (
                                'fill', 'filled', 'partial_fill', 'partially_filled'
                            )
                            or coalesce(oe.filled_qty, 0) > 0
                          )
                      {unlinked_order_event_symbol_clause}
                    order by coalesce(oe.event_ts, oe.created_at), oe.created_at
                    """,
                    (
                        source_query_account_label,
                        source_query_account_label,
                        source_account_label,
                        window_start,
                        window_end,
                        *([symbol_filter] if symbol_filter else []),
                    ),
                )
                unlinked_order_lifecycle_rows = [
                    _order_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _order_lifecycle_query_row_has_time(row)
                ]
                strategy_unlinked_order_lifecycle_rows = (
                    _strategy_relevant_unlinked_fill_lifecycle_rows(
                        execution_rows=execution_rows,
                        order_lifecycle_rows=order_lifecycle_rows,
                        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                    )
                )
                strategy_unlinked_ids = set(
                    _source_identifier_values(
                        strategy_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                )
                unattributed_unlinked_order_lifecycle_rows = [
                    row
                    for row in unlinked_order_lifecycle_rows
                    if not (
                        set(
                            _source_identifier_values(
                                [row],
                                "execution_order_event_id",
                                "event_fingerprint",
                            )
                        )
                        & strategy_unlinked_ids
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "order_feed_unlinked_fill_lifecycle_count"
                    ] = len(unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unlinked_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                    source_activity_diagnostics[
                        "order_feed_unlinked_strategy_fill_lifecycle_count"
                    ] = len(strategy_unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unlinked_strategy_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        strategy_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                    source_activity_diagnostics[
                        "order_feed_unattributed_fill_lifecycle_count"
                    ] = len(unattributed_unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unattributed_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        unattributed_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                unlinked_order_lifecycle_rows = strategy_unlinked_order_lifecycle_rows
            if source_activity_diagnostics is not None:
                lifecycle_blockers = _order_feed_fill_lifecycle_blockers(
                    execution_rows=execution_rows,
                    order_lifecycle_rows=order_lifecycle_rows,
                    unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
                )
                source_activity_diagnostics["order_feed_fill_lifecycle_blockers"] = (
                    lifecycle_blockers
                )
            if allow_authoritative_runtime_ledger_materialization:
                try:
                    flat_start_position_snapshot = (
                        _flat_start_position_snapshot_from_cursor(
                            cur,
                            account_label=source_query_account_label,
                            window_start=window_start,
                        )
                    )
                except Exception as exc:
                    flat_start_position_snapshot = None
                    if source_activity_diagnostics is not None:
                        source_activity_diagnostics[
                            "flat_start_position_snapshot_query_error"
                        ] = type(exc).__name__
                if source_activity_diagnostics is not None:
                    flat_start_authority = _flat_start_position_snapshot_authority(
                        flat_start_position_snapshot
                    )
                    source_activity_diagnostics[
                        "flat_start_position_snapshot_present"
                    ] = flat_start_position_snapshot is not None
                    if flat_start_position_snapshot is not None:
                        source_activity_diagnostics.update(
                            {
                                "flat_start_position_snapshot_id": (
                                    flat_start_position_snapshot.get("snapshot_id")
                                ),
                                "flat_start_position_snapshot_as_of": (
                                    flat_start_position_snapshot.get("snapshot_as_of")
                                ),
                                "flat_start_position_snapshot_source": (
                                    flat_start_position_snapshot.get("snapshot_source")
                                ),
                                "flat_start_position_snapshot_offset_seconds": (
                                    flat_start_position_snapshot.get(
                                        "snapshot_offset_seconds"
                                    )
                                ),
                                "flat_start_position_snapshot_flat": (
                                    flat_start_position_snapshot.get("flat")
                                ),
                                "flat_start_position_snapshot_position_count": (
                                    flat_start_position_snapshot.get("position_count")
                                ),
                                "flat_start_position_snapshot_blockers": (
                                    flat_start_position_snapshot.get("blockers")
                                ),
                            }
                        )
                    if flat_start_authority is not None:
                        source_activity_diagnostics.update(flat_start_authority)
    decision_lifecycle_rows = _retarget_source_rows_for_materialization(
        decision_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    execution_rows = _retarget_source_rows_for_materialization(
        execution_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    order_lifecycle_rows = _retarget_source_rows_for_materialization(
        order_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_decision_lifecycle_rows = _retarget_source_rows_for_materialization(
        carry_in_decision_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_execution_rows = _retarget_source_rows_for_materialization(
        carry_in_execution_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_order_lifecycle_rows = _retarget_source_rows_for_materialization(
        carry_in_order_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    tca_rows = _retarget_runtime_ledger_tca_rows(
        tca_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    tca_rows.extend(
        _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
            flat_start_position_snapshot=flat_start_position_snapshot,
            allow_authoritative_runtime_ledger_materialization=(
                allow_authoritative_runtime_ledger_materialization
            ),
        )
    )
    return decisions, executions, tca_rows


def _source_activity_missing_summary(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: list[str],
    account_label: str,
    source_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
    source_manifest_ref: str,
    source_kind: str,
    dataset_snapshot_ref: str | None,
    source_activity_symbols: Sequence[str] | None = None,
    target_metadata: Mapping[str, Any] | None = None,
    proof_hygiene_blockers: Sequence[str] = (),
    source_activity_diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = _as_mapping(target_metadata)
    symbol_filter = _metadata_symbol_list(source_activity_symbols or ())
    diagnostics = _as_mapping(source_activity_diagnostics)
    diagnostic_blockers = _source_activity_diagnostics_blockers(diagnostics)
    blocker = {
        "blocker": "runtime_window_source_activity_missing",
        "hypothesis_id": hypothesis_id,
        "candidate_id": candidate_id or None,
        "strategy_name": strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": account_label,
        "source_account_label": source_account_label or account_label,
        "source_activity_symbol_filter": symbol_filter,
        "diagnostic_blockers": diagnostic_blockers,
        "source_activity_diagnostics": diagnostics,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "remediation": (
            "Run live-paper replay or route repair until the source database contains "
            "execution-eligible trade_decisions, executions, and source-backed runtime-ledger rows for this target "
            "before importing promotion evidence."
        ),
    }
    proof_blockers = [blocker]
    for reason in proof_hygiene_blockers:
        proof_blockers.append(
            {
                "blocker": reason,
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id or None,
                "observed_stage": observed_stage,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "remediation": (
                    "Provide explicit runtime-window target metadata and health-gate "
                    "inputs before treating this import as proof-grade evidence."
                ),
            }
        )
    return {
        "status": "skipped",
        "proof_status": "blocked",
        "proof_blockers": proof_blockers,
        "run_id": run_id,
        "candidate_id": candidate_id or None,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "window_count": 0,
        "market_session_samples": 0,
        "decision_count": 0,
        "trade_count": 0,
        "order_count": 0,
        "avg_abs_slippage_bps": "0",
        "avg_post_cost_expectancy_bps": "0",
        "promotion_allowed": False,
        "promotion_blocking_reasons": list(
            dict.fromkeys(
                [
                    "runtime_window_source_activity_missing",
                    *diagnostic_blockers,
                ]
            )
        ),
        "source_activity_diagnostics": diagnostics,
        "runtime_observation": {
            "authoritative": False,
            "observed_stage": observed_stage,
            "evidence_provenance": (
                "paper_runtime_observed"
                if observed_stage == "paper"
                else "live_runtime_observed"
            ),
            "source_kind": source_kind
            or (
                "simulation_paper_runtime"
                if observed_stage == "paper"
                else "live_runtime"
            ),
            "source_manifest_ref": source_manifest_ref or None,
            "strategy_name": strategy_name,
            "strategy_name_candidates": strategy_names,
            "account_label": account_label,
            "source_account_label": source_account_label or account_label,
            "source_activity_symbol_filter": symbol_filter,
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "target_metadata": metadata,
            "source_activity_diagnostics": diagnostics,
            "source_activity_diagnostic_blockers": diagnostic_blockers,
            "skip_reason": "runtime_window_source_activity_missing",
        },
    }


def main() -> int:
    args = _parse_args()
    source_dsn = args.source_dsn.strip() or os.getenv(args.source_dsn_env, "").strip()
    source_account_label = (
        str(getattr(args, "source_account_label", "") or "").strip()
        or args.account_label
    )
    artifact_refs = [
        str(item).strip()
        for item in getattr(args, "artifact_ref", [])
        if str(item).strip()
    ]
    window_start = _parse_dt(args.window_start)
    window_end = _parse_dt(args.window_end)
    source_kind = args.source_kind.strip() or (
        "simulation_paper_runtime" if args.observed_stage == "paper" else "live_runtime"
    )
    manifest_strategy_family = _manifest_strategy_family_for_resolution(
        hypothesis_id=args.hypothesis_id,
        strategy_family=args.strategy_family,
        source_kind=source_kind,
        source_manifest_ref=args.source_manifest_ref,
    )
    _, manifest = resolve_hypothesis_manifest(
        hypothesis_id=args.hypothesis_id,
        strategy_family=manifest_strategy_family,
        source_manifest_ref=args.source_manifest_ref.strip() or None,
    )
    target_metadata = _parse_target_metadata(
        str(getattr(args, "target_metadata_json", "") or "")
    )
    strategy_names = _strategy_name_candidates(
        args.strategy_name,
        _text_or_none(target_metadata.get("runtime_strategy_name")),
        _text_or_none(target_metadata.get("strategy_name")),
        *_metadata_text_list(target_metadata.get("strategy_lookup_names")),
        getattr(manifest, "strategy_id", None),
    )
    source_activity_symbols = _target_metadata_source_symbols(target_metadata)
    allow_authoritative_runtime_ledger_materialization = (
        _source_kind_allows_runtime_ledger_materialization(
            source_kind=source_kind,
            target_metadata=target_metadata,
        )
    )
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    source_activity_diagnostics: dict[str, Any] = {
        "strategy_name_candidates": strategy_names,
        "account_label": args.account_label,
        "source_account_label": source_account_label,
        "source_dsn_env": str(getattr(args, "source_dsn_env", "") or "").strip(),
        "target_dsn_env": str(getattr(args, "target_dsn_env", "") or "").strip(),
        "target_dsn_configured": bool(_target_persistence_dsn(args)),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "source_activity_symbol_filter": source_activity_symbols,
        "candidate_id": args.candidate_id.strip() or None,
        "hypothesis_id": args.hypothesis_id,
        "source_kind": source_kind,
    }
    if source_dsn:
        decisions, executions, tca_rows = _query_timestamps(
            dsn=source_dsn,
            strategy_names=strategy_names,
            account_label=source_account_label,
            target_account_label=args.account_label,
            window_start=window_start,
            window_end=window_end,
            symbols=source_activity_symbols,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            require_source_lineage=allow_authoritative_runtime_ledger_materialization,
            allow_authoritative_runtime_ledger_materialization=(
                allow_authoritative_runtime_ledger_materialization
            ),
            source_activity_diagnostics=source_activity_diagnostics,
        )
    bucket_ranges: list[tuple[datetime, datetime, int]] = []
    runtime_ledger_artifact_metadata: dict[str, Any] = {
        "runtime_ledger_artifact_refs": [],
        "runtime_ledger_ignored_artifact_refs": [],
        "runtime_ledger_artifact_row_count": 0,
        "runtime_ledger_artifact_fill_count": 0,
        "runtime_ledger_artifact_tca_row_count": 0,
    }
    runtime_ledger_durable_metadata: dict[str, Any] = {
        "runtime_ledger_durable_bucket_count": 0,
        "runtime_ledger_durable_bucket_run_ids": [],
        "runtime_ledger_durable_bucket_fill_count": 0,
        "runtime_ledger_durable_bucket_tca_row_count": 0,
        "runtime_ledger_durable_bucket_profit_proof_count": 0,
    }
    runtime_ledger_source_metadata: dict[str, Any] = {
        "runtime_ledger_source_bucket_count": 0,
        "runtime_ledger_source_bucket_run_ids": [],
        "runtime_ledger_source_bucket_fill_count": 0,
        "runtime_ledger_source_bucket_tca_row_count": 0,
        "runtime_ledger_source_bucket_profit_proof_count": 0,
    }
    if source_dsn:
        source_runtime_ledger_tca_rows, runtime_ledger_source_metadata = (
            _runtime_ledger_tca_rows_from_source_dsn(
                dsn=source_dsn,
                candidate_id=args.candidate_id.strip() or None,
                hypothesis_id=args.hypothesis_id,
                observed_stage=args.observed_stage,
                strategy_names=strategy_names,
                account_label=source_account_label,
                target_account_label=args.account_label,
                window_start=window_start,
                window_end=window_end,
            )
        )
        tca_rows.extend(source_runtime_ledger_tca_rows)
        source_activity_diagnostics.update(runtime_ledger_source_metadata)
    if artifact_refs:
        bucket_ranges = build_regular_session_buckets(
            window_start=window_start,
            window_end=window_end,
            bucket_minutes=args.bucket_minutes,
            sample_minutes=args.sample_minutes,
        )
        (
            runtime_ledger_decisions,
            runtime_ledger_executions,
            runtime_ledger_tca_rows,
            runtime_ledger_artifact_metadata,
        ) = _runtime_ledger_tca_rows_from_artifacts(
            artifact_refs=artifact_refs,
            bucket_ranges=bucket_ranges,
        )
        decisions.extend(runtime_ledger_decisions)
        executions.extend(runtime_ledger_executions)
        tca_rows.extend(runtime_ledger_tca_rows)
    if (
        not source_dsn
        and not runtime_ledger_artifact_metadata["runtime_ledger_artifact_refs"]
    ):
        with _persistence_session(args) as session:
            durable_runtime_ledger_tca_rows, runtime_ledger_durable_metadata = (
                _runtime_ledger_tca_rows_from_durable_buckets(
                    session=session,
                    candidate_id=args.candidate_id.strip() or None,
                    hypothesis_id=args.hypothesis_id,
                    observed_stage=args.observed_stage,
                    strategy_names=strategy_names,
                    account_label=args.account_label,
                    window_start=window_start,
                    window_end=window_end,
                )
            )
        tca_rows.extend(durable_runtime_ledger_tca_rows)
    if (
        not source_dsn
        and not runtime_ledger_artifact_metadata["runtime_ledger_artifact_refs"]
        and not runtime_ledger_durable_metadata["runtime_ledger_durable_bucket_count"]
    ):
        raise RuntimeError("source_dsn_not_configured")
    dataset_snapshot_ref = (
        str(getattr(args, "dataset_snapshot_ref", "") or "").strip() or None
    )
    runtime_ledger_target_metadata_blockers = list(
        dict.fromkeys(
            [
                *_runtime_ledger_target_metadata_blockers(
                    target_metadata=target_metadata,
                    runtime_ledger_artifact_metadata=runtime_ledger_artifact_metadata,
                    window_start=window_start,
                    window_end=window_end,
                ),
                *_runtime_window_import_proof_hygiene_blockers(
                    source_kind=source_kind,
                    target_metadata=target_metadata,
                    dependency_quorum_decision=args.dependency_quorum_decision,
                    continuity_ok=args.continuity_ok,
                    drift_ok=args.drift_ok,
                ),
            ]
        )
    )
    if not decisions and not executions and not tca_rows:
        summary = _source_activity_missing_summary(
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip(),
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_name=args.strategy_name,
            strategy_names=strategy_names,
            account_label=args.account_label,
            source_account_label=source_account_label,
            window_start=window_start,
            window_end=window_end,
            source_manifest_ref=args.source_manifest_ref.strip(),
            source_kind=args.source_kind.strip(),
            dataset_snapshot_ref=dataset_snapshot_ref,
            source_activity_symbols=source_activity_symbols,
            target_metadata=target_metadata,
            proof_hygiene_blockers=runtime_ledger_target_metadata_blockers,
            source_activity_diagnostics={
                **source_activity_diagnostics,
                **runtime_ledger_artifact_metadata,
                **runtime_ledger_durable_metadata,
                **runtime_ledger_source_metadata,
            },
        )
        if getattr(args, "audit_only", False):
            summary = {**summary, "audit_only": True, "would_persist": False}
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(summary)
        return 0
    delay_depth_report_ref = str(
        getattr(args, "delay_adjusted_depth_stress_report_ref", "") or ""
    ).strip()
    delay_depth_report = _load_json_artifact(delay_depth_report_ref)
    if delay_depth_report_ref:
        artifact_refs.append(delay_depth_report_ref)
    if not bucket_ranges:
        bucket_ranges = build_regular_session_buckets(
            window_start=window_start,
            window_end=window_end,
            bucket_minutes=args.bucket_minutes,
            sample_minutes=args.sample_minutes,
        )
    buckets = build_observed_runtime_buckets(
        bucket_ranges=bucket_ranges,
        decision_times=decisions,
        execution_times=executions,
        tca_rows=tca_rows,
        continuity_ok=_flag(args.continuity_ok),
        drift_ok=_flag(args.drift_ok),
        dependency_quorum_decision=args.dependency_quorum_decision.strip() or "missing",
    )
    evidence_provenance = (
        "paper_runtime_observed"
        if args.observed_stage == "paper"
        else "live_runtime_observed"
    )
    runtime_observation_payload = {
        **_runtime_observation_authority_payload(
            source_kind=source_kind,
            tca_rows=tca_rows,
        ),
        **_runtime_ledger_tca_materialization_metadata(tca_rows),
        "observed_stage": args.observed_stage,
        "evidence_provenance": evidence_provenance,
        "source_kind": source_kind,
        "source_manifest_ref": args.source_manifest_ref.strip() or None,
        "strategy_name": args.strategy_name,
        "strategy_name_candidates": strategy_names,
        "account_label": args.account_label,
        "source_account_label": source_account_label,
        "source_activity_symbol_filter": source_activity_symbols,
        "source_activity_diagnostics": {
            **source_activity_diagnostics,
            **runtime_ledger_artifact_metadata,
            **runtime_ledger_durable_metadata,
            **runtime_ledger_source_metadata,
        },
        "source_activity_diagnostic_blockers": _source_activity_diagnostics_blockers(
            {
                **source_activity_diagnostics,
                **runtime_ledger_artifact_metadata,
                **runtime_ledger_durable_metadata,
                **runtime_ledger_source_metadata,
            }
        ),
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "artifact_refs": artifact_refs,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "target_metadata": target_metadata,
        "runtime_ledger_target_metadata_blockers": runtime_ledger_target_metadata_blockers,
        **runtime_ledger_artifact_metadata,
        **runtime_ledger_durable_metadata,
        **runtime_ledger_source_metadata,
    }
    if delay_depth_report_ref:
        runtime_observation_payload.update(
            {
                "delay_adjusted_depth_stress_artifact_ref": delay_depth_report_ref,
                "delay_adjusted_depth_stress_report": delay_depth_report,
                "delay_adjusted_depth_stress_checks_total": max(
                    _nonnegative_int(delay_depth_report.get("stress_case_count")),
                    _nonnegative_int(delay_depth_report.get("case_count")),
                    _nonnegative_int(delay_depth_report.get("trading_day_count")),
                )
                if delay_depth_report
                else 0,
                "delay_adjusted_depth_stress_passed": delay_depth_report.get("passed")
                if delay_depth_report
                else False,
                "delay_adjusted_depth_stress_checked_at": (
                    delay_depth_report.get("generated_at")
                    or delay_depth_report.get("checked_at")
                )
                if delay_depth_report
                else None,
            }
        )
    runtime_observation_payload = (
        _runtime_observation_payload_with_observed_runtime_ledger_materialization(
            source_kind=source_kind,
            runtime_observation_payload=runtime_observation_payload,
            buckets=buckets,
        )
    )
    if getattr(args, "audit_only", False):
        summary = _runtime_window_import_audit_summary(
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_name=args.strategy_name,
            strategy_names=strategy_names,
            account_label=args.account_label,
            source_account_label=source_account_label,
            window_start=window_start,
            window_end=window_end,
            source_kind=source_kind,
            source_manifest_ref=args.source_manifest_ref.strip() or None,
            dataset_snapshot_ref=dataset_snapshot_ref,
            decisions=decisions,
            executions=executions,
            tca_rows=tca_rows,
            buckets=buckets,
            runtime_observation_payload=runtime_observation_payload,
            runtime_ledger_target_metadata_blockers=runtime_ledger_target_metadata_blockers,
        )
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print(summary)
        return 0
    with _persistence_session(args) as session:
        summary = persist_observed_runtime_windows(
            session=session,
            run_id=args.run_id,
            candidate_id=args.candidate_id.strip() or None,
            hypothesis_id=args.hypothesis_id,
            observed_stage=args.observed_stage,
            strategy_family=args.strategy_family.strip() or manifest.strategy_family,
            source_manifest_ref=args.source_manifest_ref.strip() or None,
            buckets=buckets,
            slippage_budget_bps=manifest.max_allowed_slippage_bps,
            runtime_observation_payload=runtime_observation_payload,
        )
        session.commit()
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

__all__ = [
    "annotations",
    "argparse",
    "contextmanager",
    "replace",
    "hashlib",
    "json",
    "os",
    "date",
    "datetime",
    "time",
    "timedelta",
    "timezone",
    "ROUND_CEILING",
    "Decimal",
    "Path",
    "Any",
    "Iterator",
    "Mapping",
    "Sequence",
    "cast",
    "psycopg",
    "create_engine",
    "select",
    "Session",
    "sessionmaker",
    "SessionLocal",
    "StrategyRuntimeLedgerBucket",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "POST_COST_PNL_BASIS",
    "RuntimeLedgerFill",
    "RuntimeLedgerBucket",
    "build_runtime_ledger_buckets",
    "_base_runtime_ledger_promotion_source_authority_blockers",
    "cost_basis_counts_have_non_promotion_grade_costs",
    "is_non_promotion_grade_runtime_cost_basis",
    "SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER",
    "SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER",
    "normalize_source_decision_mode",
    "source_decision_mode_counts_have_non_profit_proof_modes",
    "source_decision_mode_counts_have_profit_proof_modes",
    "source_decision_mode_is_profit_proof_eligible",
    "build_observed_runtime_buckets",
    "build_regular_session_buckets",
    "persist_observed_runtime_windows",
    "resolve_hypothesis_manifest",
    "EXECUTION_ELIGIBLE_DECISION_STATUSES",
    "POST_COST_BASIS_RUNTIME_LEDGER",
    "POST_COST_BASIS_EXECUTION_RECONSTRUCTION",
    "RUNTIME_LEDGER_ARTIFACT_SCHEMAS",
    "RUNTIME_LEDGER_BUCKET_SCHEMAS",
    "EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS",
    "EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RUNTIME_LEDGER_CARRY_IN_LOOKBACK",
    "RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD",
    "RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS",
    "RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER",
    "EXECUTION_TCA_MISSING_BLOCKER",
    "_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS",
    "_RUNTIME_LEDGER_DECISION_EVENTS",
    "_RUNTIME_LEDGER_FILL_EVENTS",
    "_RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS",
    "ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER",
    "ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER",
    "ORDER_FEED_LIFECYCLE_MISSING_BLOCKER",
    "EXECUTION_ECONOMICS_MISSING_BLOCKER",
    "ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER",
    "ORDER_FEED_FILL_DELTA_MISSING_BLOCKER",
    "_EXECUTION_TCA_REF_KEYS",
    "_SOURCE_WINDOW_REF_KEYS",
    "_EXECUTION_ORDER_EVENT_REF_KEYS",
    "_RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS",
    "_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS",
    "ALPACA_2026_EQUITY_SEC_FEE_RATE",
    "ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE",
    "ALPACA_2026_EQUITY_TAF_CAP",
    "ALPACA_2026_FEE_SCHEDULE_REVISED_ON",
    "_CENT",
    "_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS",
    "SOURCE_LINEAGE_CANDIDATE_KEYS",
    "SOURCE_LINEAGE_HYPOTHESIS_KEYS",
    "SOURCE_DECISION_MODE_MISSING_PARTITION",
    "_parse_args",
    "_sqlalchemy_dsn",
    "_target_persistence_dsn",
    "_persistence_session",
    "_flag",
    "_parse_dt",
    "_parse_dt_or_none",
    "_as_mapping",
    "_as_sequence",
    "_parse_target_metadata",
    "_decimal_or_none",
    "_text_or_none",
    "_promotion_grade_runtime_ledger_authority_marker_present",
    "runtime_ledger_promotion_source_authority_blockers",
    "runtime_ledger_promotion_source_authority_present",
    "_row_payloads",
    "_first_decimal",
    "_first_positive_decimal",
    "_first_text",
    "_direct_text",
    "_bool_value",
    "_direct_bool",
    "_text_values",
    "_first_bool",
    "_position_snapshot_open_position_count",
    "_flat_start_position_snapshot_authority",
    "_source_decision_priority_payloads",
    "_source_decision_mode",
    "_source_decision_profit_proof_flag",
    "_source_decision_target_notional_sizing_audit",
    "_source_decision_target_notional_sizing_summary",
    "_source_row_is_paper_route_probe_exit",
    "_source_decision_identifier_values",
    "_paper_route_probe_exit_identifiers",
    "_source_row_is_paper_route_probe_exit_or_linked",
    "_source_decision_mode_counts",
    "_source_decision_mode_lookup",
    "_source_decision_mode_partition_key",
    "_partition_runtime_source_rows_by_decision_mode",
    "_source_decision_rows_profit_proof_eligible",
    "_source_row_matches_lineage",
    "_source_row_lineage_missing_or_matches",
    "_source_row_time_before",
    "_source_row_time_after_window",
    "_runtime_open_qtys_by_symbol_from_execution_rows",
    "_source_decision_action_offsets_open_qty",
    "_source_row_decision_ids",
    "_source_row_execution_ids",
    "_mark_post_window_closeout_source_row",
    "_filter_source_rows_for_runtime_window",
    "_runtime_ledger_equity_denominator_from_rows",
    "_json_default",
    "_stable_payload_digest",
    "_runtime_source_lineage_hash",
    "_attach_source_lineage_context",
    "_decimal_ceil_cent",
    "_row_has_alpaca_us_equity_order_source",
    "_alpaca_2026_equity_fee_schedule_cost",
    "_alpaca_2026_equity_fee_schedule_hash",
    "_cost_basis_is_alpaca_fee_schedule",
    "_first_payload_digest",
    "_LINEAGE_CONTEXT_KEYS",
    "_first_lineage_digest",
    "_runtime_ledger_bucket_payload",
    "_mapping_hash_count",
    "_positive_count_mapping_present",
    "_runtime_ledger_explicit_costs_present",
    "_runtime_ledger_bucket_profit_proof_blockers",
    "_runtime_ledger_bucket_profit_proof_present",
    "_runtime_ledger_tca_row_from_bucket",
    "_append_runtime_ledger_tca_row_blocker",
    "_with_runtime_ledger_source_authority_context",
    "_merge_count_mappings",
    "_source_identifier_values",
    "_source_offset_values",
    "_with_canonical_runtime_source_refs",
    "_unique_source_window_rows",
    "_source_window_status_counts",
    "_source_window_classification_counts",
    "_source_window_gap_count",
    "_source_window_gap_ranges",
    "_decision_lifecycle_query_row",
    "_decision_lifecycle_query_row_has_time",
    "_execution_query_row",
    "_execution_query_row_has_time",
    "_execution_query_row_has_tca_ref",
    "_source_window_query_context",
    "_order_lifecycle_query_row",
    "_order_lifecycle_query_row_has_time",
    "_mark_runtime_ledger_tca_rows_as_exact_replay_artifacts",
    "_nonnegative_int",
    "_metadata_text_list",
    "_runtime_ledger_tca_ref_texts",
    "_runtime_ledger_execution_tca_metric_refs",
    "_metadata_symbol_list",
    "_target_metadata_source_symbols",
    "_runtime_ledger_target_metadata_artifact_refs",
    "_metadata_nonnegative_int_or_none",
    "_runtime_ledger_target_metadata_blockers",
    "_runtime_window_source_kind_is_informational",
    "_AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS",
    "_source_collection_target_authorization_blockers",
    "_source_kind_allows_runtime_ledger_materialization",
    "_runtime_window_import_proof_hygiene_blockers",
    "_runtime_ledger_profit_proof_present",
    "_runtime_observation_authority_payload",
    "_runtime_ledger_tca_materialization_metadata",
    "_runtime_ledger_tca_rows_from_observed_buckets",
    "_runtime_observation_payload_with_observed_runtime_ledger_materialization",
    "_runtime_window_import_audit_summary",
    "_strategy_name_candidates",
    "_execution_signed_qty",
    "_runtime_execution_cost_amount",
    "_runtime_execution_cost_basis",
    "_runtime_lifecycle_ledger_row",
    "_runtime_order_id",
    "_execution_id_by_order_id",
    "_execution_side_by_order_id",
    "_with_linked_execution_id",
    "_execution_row_has_fill",
    "_runtime_lifecycle_identifier_values",
    "_runtime_lifecycle_strategy_identifier_values",
    "_strategy_relevant_unlinked_fill_lifecycle_rows",
    "_order_feed_fill_lifecycle_blockers",
    "_source_authority_order_event_row",
    "_fill_quantity_basis",
    "_source_order_feed_payload_delta_fill",
    "_order_feed_fill_delta_blockers",
    "_runtime_source_row_symbol",
    "_runtime_source_row_in_bucket",
    "_runtime_source_row_before_bucket",
    "_runtime_source_decision_ids",
    "_ledger_row_value",
    "_ledger_row_text",
    "_ledger_row_decimal",
    "_ledger_row_time",
    "_ledger_row_event_type",
    "_ledger_row_order_id",
    "_ledger_row_decision_id",
    "_ledger_row_symbol",
    "_ledger_row_position_key",
    "_ledger_row_side_sign",
    "_adjust_carry_in_lot_row",
    "_active_carry_in_ledger_rows",
    "_filter_carry_in_source_rows_for_active_lots",
    "_flat_start_position_snapshot_from_cursor",
    "_runtime_order_rows_for_bucket",
    "_runtime_decision_rows_for_bucket",
    "_runtime_decision_rows_before_bucket",
    "_runtime_unlinked_order_rows_for_bucket",
    "_event_sourced_fill_economics_order_ids",
    "_source_backed_fill_lifecycle_rows",
    "_source_backed_order_lifecycle_rows",
    "_required_order_lifecycle_source_row_count",
    "_source_backed_fill_lifecycle_order_ids",
    "_source_backed_submitted_lifecycle_order_ids",
    "_execution_fill_economics_order_ids",
    "_execution_tca_order_ids",
    "_runtime_source_context_for_bucket",
    "_source_activity_diagnostics_blockers",
    "_runtime_execution_ledger_fill_from_row",
    "_build_realized_strategy_pnl_rows",
    "_load_json_artifact",
    "_runtime_ledger_artifact_schema",
    "_runtime_ledger_artifact_rows",
    "_runtime_ledger_event_type",
    "_runtime_ledger_row_time",
    "_runtime_ledger_activity_times",
    "_parse_artifact_window_datetime",
    "_runtime_ledger_artifact_window_metadata",
    "_window_weekday_count",
    "_runtime_ledger_artifact_candidate_ids",
    "_runtime_ledger_tca_rows_from_artifacts",
    "_runtime_ledger_bucket_payload_from_row",
    "_runtime_ledger_tca_row_from_payload",
    "_runtime_ledger_bucket_metadata",
    "_runtime_ledger_tca_rows_from_durable_buckets",
    "_SOURCE_RUNTIME_LEDGER_COLUMNS",
    "_source_runtime_ledger_payload_from_row",
    "_runtime_ledger_tca_rows_from_source_dsn",
    "_retarget_source_rows_for_materialization",
    "_retarget_runtime_ledger_tca_rows",
    "_query_timestamps",
    "_source_activity_missing_summary",
    "_manifest_strategy_family_for_resolution",
    "main",
]
