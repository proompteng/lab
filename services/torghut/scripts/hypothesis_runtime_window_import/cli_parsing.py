#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
from typing import Any, Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import SessionLocal

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


__all__ = [
    "_parse_args",
    "_sqlalchemy_dsn",
    "_target_persistence_dsn",
    "_persistence_session",
    "_flag",
    "_load_json_artifact",
]
