#!/usr/bin/env python3
"""Import observed paper/live runtime windows into doc29 governance tables."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence

import psycopg
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import StrategyRuntimeLedgerBucket
from app.trading.runtime_ledger import (
    build_runtime_ledger_buckets,
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

from scripts.hypothesis_runtime_window_import.cli_parsing import (
    _load_json_artifact,
)

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


__all__ = [
    "_runtime_ledger_artifact_schema",
    "_runtime_ledger_artifact_rows",
    "_runtime_ledger_activity_times",
    "_runtime_ledger_artifact_window_metadata",
    "_runtime_ledger_tca_rows_from_artifacts",
    "_runtime_ledger_bucket_payload_from_row",
    "_runtime_ledger_tca_row_from_payload",
    "_runtime_ledger_bucket_metadata",
    "_runtime_ledger_tca_rows_from_durable_buckets",
    "_source_runtime_ledger_payload_from_row",
    "_runtime_ledger_tca_rows_from_source_dsn",
    "_retarget_source_rows_for_materialization",
    "_retarget_runtime_ledger_tca_rows",
]
