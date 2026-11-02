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
    _runtime_source_row_symbol,
    _execution_signed_qty,
    _execution_row_has_fill,
    _source_authority_order_event_row,
    _manifest_strategy_family_for_resolution,
    _parse_dt,
    _parse_dt_or_none,
    _as_mapping,
    _as_sequence,
    _parse_target_metadata,
    _decimal_or_none,
    _text_or_none,
    _row_payloads,
    _first_decimal,
    _first_positive_decimal,
    _first_text,
    _direct_text,
    _bool_value,
    _direct_bool,
    _text_values,
    _first_bool,
    _position_snapshot_open_position_count,
    _flat_start_position_snapshot_authority,
    _runtime_ledger_equity_denominator_from_rows,
    _json_default,
    _stable_payload_digest,
    _runtime_source_lineage_hash,
    _attach_source_lineage_context,
    _row_has_alpaca_us_equity_order_source,
    _alpaca_2026_equity_fee_schedule_cost,
    _alpaca_2026_equity_fee_schedule_hash,
    _cost_basis_is_alpaca_fee_schedule,
    _first_payload_digest,
    _first_lineage_digest,
    _merge_count_mappings,
    _source_identifier_values,
    _source_offset_values,
    _with_canonical_runtime_source_refs,
    _nonnegative_int,
    _metadata_text_list,
    _runtime_ledger_tca_ref_texts,
    _runtime_ledger_execution_tca_metric_refs,
    _metadata_symbol_list,
    _target_metadata_source_symbols,
    _runtime_ledger_target_metadata_artifact_refs,
    _metadata_nonnegative_int_or_none,
    _runtime_window_source_kind_is_informational,
    _source_collection_target_authorization_blockers,
    _source_kind_allows_runtime_ledger_materialization,
    _runtime_ledger_event_type,
    _runtime_ledger_row_time,
    _parse_artifact_window_datetime,
    _window_weekday_count,
    _runtime_ledger_artifact_candidate_ids,
)
from scripts.hypothesis_runtime_window_import.constants import (
    _LINEAGE_CONTEXT_KEYS,
    _AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS,
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    POST_COST_BASIS_RUNTIME_LEDGER,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    RUNTIME_LEDGER_ARTIFACT_SCHEMAS,
    RUNTIME_LEDGER_BUCKET_SCHEMAS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_CARRY_IN_LOOKBACK,
    RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD,
    RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS,
    RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER,
    CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX,
    CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    EXECUTION_TCA_MISSING_BLOCKER,
    _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS,
    _RUNTIME_LEDGER_DECISION_EVENTS,
    _RUNTIME_LEDGER_FILL_EVENTS,
    _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS,
    ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER,
    ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    EXECUTION_ECONOMICS_MISSING_BLOCKER,
    ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER,
    ORDER_FEED_FILL_DELTA_MISSING_BLOCKER,
    _EXECUTION_TCA_REF_KEYS,
    _SOURCE_WINDOW_REF_KEYS,
    _EXECUTION_ORDER_EVENT_REF_KEYS,
    _RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS,
    _RUNTIME_LIFECYCLE_IDENTIFIER_KEYS,
    _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS,
    SOURCE_LINEAGE_CANDIDATE_KEYS,
    SOURCE_LINEAGE_HYPOTHESIS_KEYS,
    SOURCE_DECISION_MODE_MISSING_PARTITION,
)
from scripts.hypothesis_runtime_window_import.runtime_ledger_authority import (
    _promotion_grade_runtime_ledger_authority_marker_present,
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_promotion_source_authority_present,
    _runtime_ledger_bucket_payload,
    _mapping_hash_count,
    _positive_count_mapping_present,
    _runtime_ledger_explicit_costs_present,
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_row_from_bucket,
    _append_runtime_ledger_tca_row_blocker,
    _with_runtime_ledger_source_authority_context,
)
from scripts.hypothesis_runtime_window_import.runtime_observation import (
    _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts,
    _runtime_ledger_target_metadata_blockers,
    _runtime_window_import_proof_hygiene_blockers,
    _runtime_ledger_profit_proof_present,
    _runtime_observation_authority_payload,
    _runtime_ledger_tca_materialization_metadata,
    _runtime_ledger_tca_rows_from_observed_buckets,
    _runtime_observation_payload_with_observed_runtime_ledger_materialization,
    _runtime_window_import_audit_summary,
)
from scripts.hypothesis_runtime_window_import.source_decisions import (
    _source_decision_priority_payloads,
    _source_decision_mode,
    _source_decision_profit_proof_flag,
    _source_decision_target_notional_sizing_audit,
    _source_decision_target_notional_sizing_summary,
    _source_row_is_paper_route_probe_exit,
    _source_decision_identifier_values,
    _paper_route_probe_exit_identifiers,
    _source_row_is_paper_route_probe_exit_or_linked,
    _source_decision_mode_counts,
    _source_decision_mode_lookup,
    _source_decision_mode_partition_key,
    _partition_runtime_source_rows_by_decision_mode,
    _source_decision_rows_profit_proof_eligible,
    _source_row_matches_lineage,
    _source_row_lineage_missing_or_matches,
    _source_row_time_before,
    _source_row_time_after_window,
    _runtime_open_qtys_by_symbol_from_execution_rows,
    _source_decision_action_offsets_open_qty,
    _source_row_decision_ids,
    _source_row_execution_ids,
    _mark_post_window_closeout_source_row,
    _filter_source_rows_for_runtime_window,
)
from scripts.hypothesis_runtime_window_import.source_windows import (
    _unique_source_window_rows,
    _source_window_status_counts,
    _source_window_classification_counts,
    _source_window_gap_count,
    _source_window_gap_ranges,
    _decision_lifecycle_query_row,
    _decision_lifecycle_query_row_has_time,
    _execution_query_row,
    _execution_query_row_has_time,
    _execution_query_row_has_tca_ref,
    _source_window_query_context,
    _order_lifecycle_query_row,
    _order_lifecycle_query_row_has_time,
)

from scripts.hypothesis_runtime_window_import.execution_costs import (
    _runtime_execution_cost_amount,
    _runtime_execution_cost_basis,
    _strategy_name_candidates,
)
from scripts.hypothesis_runtime_window_import.lifecycle_rows import (
    _execution_id_by_order_id,
    _execution_side_by_order_id,
    _fill_quantity_basis,
    _order_feed_fill_delta_blockers,
    _order_feed_fill_lifecycle_blockers,
    _runtime_lifecycle_identifier_values,
    _runtime_lifecycle_ledger_row,
    _runtime_lifecycle_strategy_identifier_values,
    _runtime_order_id,
    _source_order_feed_payload_delta_fill,
    _strategy_relevant_unlinked_fill_lifecycle_rows,
    _with_linked_execution_id,
)
from scripts.hypothesis_runtime_window_import.source_row_filters import (
    _active_carry_in_ledger_rows,
    _adjust_carry_in_lot_row,
    _event_sourced_fill_economics_order_ids,
    _execution_fill_economics_order_ids,
    _execution_tca_order_ids,
    _filter_carry_in_source_rows_for_active_lots,
    _flat_start_position_snapshot_from_cursor,
    _ledger_row_decimal,
    _ledger_row_decision_id,
    _ledger_row_event_type,
    _ledger_row_order_id,
    _ledger_row_position_key,
    _ledger_row_side_sign,
    _ledger_row_symbol,
    _ledger_row_text,
    _ledger_row_time,
    _ledger_row_value,
    _required_order_lifecycle_source_row_count,
    _runtime_decision_rows_before_bucket,
    _runtime_decision_rows_for_bucket,
    _runtime_order_rows_for_bucket,
    _runtime_source_decision_ids,
    _runtime_source_row_before_bucket,
    _runtime_source_row_in_bucket,
    _runtime_unlinked_order_rows_for_bucket,
    _source_backed_fill_lifecycle_order_ids,
    _source_backed_fill_lifecycle_rows,
    _source_backed_order_lifecycle_rows,
    _source_backed_submitted_lifecycle_order_ids,
)
from scripts.hypothesis_runtime_window_import.source_activity_context import (
    _runtime_execution_ledger_fill_from_row,
    _runtime_source_context_for_bucket,
    _source_activity_diagnostics_blockers,
)
from scripts.hypothesis_runtime_window_import.realized_pnl import (
    _build_realized_strategy_pnl_rows,
)

from scripts.hypothesis_runtime_window_import.cli_parsing import (
    _parse_args,
    _persistence_session as _cli_persistence_session,
    _sqlalchemy_dsn,
    _target_persistence_dsn,
    _flag,
    _load_json_artifact,
)

from scripts.hypothesis_runtime_window_import.row_materialization import (
    _runtime_ledger_artifact_schema,
    _runtime_ledger_artifact_rows,
    _runtime_ledger_activity_times,
    _runtime_ledger_artifact_window_metadata,
    _runtime_ledger_tca_rows_from_artifacts,
    _runtime_ledger_bucket_payload_from_row,
    _runtime_ledger_tca_row_from_payload,
    _runtime_ledger_bucket_metadata,
    _runtime_ledger_tca_rows_from_durable_buckets,
    _source_runtime_ledger_payload_from_row,
    _runtime_ledger_tca_rows_from_source_dsn,
    _retarget_source_rows_for_materialization,
    _retarget_runtime_ledger_tca_rows,
)

from scripts.hypothesis_runtime_window_import.source_activity_summary import (
    _source_activity_missing_summary,
)
from scripts.hypothesis_runtime_window_import.source_activity_queries import (
    _query_timestamps,
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


@contextmanager
def _persistence_session(args: argparse.Namespace) -> Iterator[Session]:
    with _cli_persistence_session(args) as session:
        yield session


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
    "Any",
    "CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX",
    "CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND",
    "Decimal",
    "EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS",
    "EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "EXECUTION_ECONOMICS_MISSING_BLOCKER",
    "EXECUTION_ELIGIBLE_DECISION_STATUSES",
    "EXECUTION_TCA_MISSING_BLOCKER",
    "Iterator",
    "Mapping",
    "ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER",
    "ORDER_FEED_FILL_DELTA_MISSING_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER",
    "ORDER_FEED_LIFECYCLE_MISSING_BLOCKER",
    "ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER",
    "POST_COST_BASIS_EXECUTION_RECONSTRUCTION",
    "POST_COST_BASIS_RUNTIME_LEDGER",
    "POST_COST_PNL_BASIS",
    "Path",
    "ROUND_CEILING",
    "RUNTIME_LEDGER_ARTIFACT_SCHEMAS",
    "RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_BUCKET_SCHEMAS",
    "RUNTIME_LEDGER_CARRY_IN_LOOKBACK",
    "RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS",
    "RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS",
    "RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RuntimeLedgerBucket",
    "RuntimeLedgerFill",
    "SOURCE_DECISION_MODE_MISSING_PARTITION",
    "SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER",
    "SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER",
    "SOURCE_LINEAGE_CANDIDATE_KEYS",
    "SOURCE_LINEAGE_HYPOTHESIS_KEYS",
    "Sequence",
    "Session",
    "SessionLocal",
    "StrategyRuntimeLedgerBucket",
    "_AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS",
    "_EXECUTION_ORDER_EVENT_REF_KEYS",
    "_EXECUTION_TCA_REF_KEYS",
    "_LINEAGE_CONTEXT_KEYS",
    "_RUNTIME_LEDGER_DECISION_EVENTS",
    "_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS",
    "_RUNTIME_LEDGER_FILL_EVENTS",
    "_RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS",
    "_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS",
    "_RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS",
    "_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS",
    "_SOURCE_RUNTIME_LEDGER_COLUMNS",
    "_SOURCE_WINDOW_REF_KEYS",
    "_active_carry_in_ledger_rows",
    "_adjust_carry_in_lot_row",
    "_alpaca_2026_equity_fee_schedule_cost",
    "_alpaca_2026_equity_fee_schedule_hash",
    "_append_runtime_ledger_tca_row_blocker",
    "_as_mapping",
    "_as_sequence",
    "_attach_source_lineage_context",
    "_base_runtime_ledger_promotion_source_authority_blockers",
    "_bool_value",
    "_build_realized_strategy_pnl_rows",
    "_cost_basis_is_alpaca_fee_schedule",
    "_decimal_or_none",
    "_decision_lifecycle_query_row",
    "_decision_lifecycle_query_row_has_time",
    "_direct_bool",
    "_direct_text",
    "_event_sourced_fill_economics_order_ids",
    "_execution_fill_economics_order_ids",
    "_execution_id_by_order_id",
    "_execution_query_row",
    "_execution_query_row_has_tca_ref",
    "_execution_query_row_has_time",
    "_execution_row_has_fill",
    "_execution_side_by_order_id",
    "_execution_signed_qty",
    "_execution_tca_order_ids",
    "_fill_quantity_basis",
    "_filter_carry_in_source_rows_for_active_lots",
    "_filter_source_rows_for_runtime_window",
    "_first_bool",
    "_first_decimal",
    "_first_lineage_digest",
    "_first_payload_digest",
    "_first_positive_decimal",
    "_first_text",
    "_flag",
    "_flat_start_position_snapshot_authority",
    "_flat_start_position_snapshot_from_cursor",
    "_json_default",
    "_ledger_row_decimal",
    "_ledger_row_decision_id",
    "_ledger_row_event_type",
    "_ledger_row_order_id",
    "_ledger_row_position_key",
    "_ledger_row_side_sign",
    "_ledger_row_symbol",
    "_ledger_row_text",
    "_ledger_row_time",
    "_ledger_row_value",
    "_load_json_artifact",
    "_manifest_strategy_family_for_resolution",
    "_mapping_hash_count",
    "_mark_post_window_closeout_source_row",
    "_mark_runtime_ledger_tca_rows_as_exact_replay_artifacts",
    "_merge_count_mappings",
    "_metadata_nonnegative_int_or_none",
    "_metadata_symbol_list",
    "_metadata_text_list",
    "_nonnegative_int",
    "_order_feed_fill_delta_blockers",
    "_order_feed_fill_lifecycle_blockers",
    "_order_lifecycle_query_row",
    "_order_lifecycle_query_row_has_time",
    "_paper_route_probe_exit_identifiers",
    "_parse_args",
    "_parse_artifact_window_datetime",
    "_parse_dt",
    "_parse_dt_or_none",
    "_parse_target_metadata",
    "_partition_runtime_source_rows_by_decision_mode",
    "_persistence_session",
    "_position_snapshot_open_position_count",
    "_positive_count_mapping_present",
    "_promotion_grade_runtime_ledger_authority_marker_present",
    "_query_timestamps",
    "_required_order_lifecycle_source_row_count",
    "_retarget_runtime_ledger_tca_rows",
    "_retarget_source_rows_for_materialization",
    "_row_has_alpaca_us_equity_order_source",
    "_row_payloads",
    "_runtime_decision_rows_before_bucket",
    "_runtime_decision_rows_for_bucket",
    "_runtime_execution_cost_amount",
    "_runtime_execution_cost_basis",
    "_runtime_execution_ledger_fill_from_row",
    "_runtime_ledger_activity_times",
    "_runtime_ledger_artifact_candidate_ids",
    "_runtime_ledger_artifact_rows",
    "_runtime_ledger_artifact_schema",
    "_runtime_ledger_artifact_window_metadata",
    "_runtime_ledger_bucket_metadata",
    "_runtime_ledger_bucket_payload",
    "_runtime_ledger_bucket_payload_from_row",
    "_runtime_ledger_bucket_profit_proof_blockers",
    "_runtime_ledger_bucket_profit_proof_present",
    "_runtime_ledger_equity_denominator_from_rows",
    "_runtime_ledger_event_type",
    "_runtime_ledger_execution_tca_metric_refs",
    "_runtime_ledger_explicit_costs_present",
    "_runtime_ledger_profit_proof_present",
    "_runtime_ledger_row_time",
    "_runtime_ledger_target_metadata_artifact_refs",
    "_runtime_ledger_target_metadata_blockers",
    "_runtime_ledger_tca_materialization_metadata",
    "_runtime_ledger_tca_ref_texts",
    "_runtime_ledger_tca_row_from_bucket",
    "_runtime_ledger_tca_row_from_payload",
    "_runtime_ledger_tca_rows_from_artifacts",
    "_runtime_ledger_tca_rows_from_durable_buckets",
    "_runtime_ledger_tca_rows_from_observed_buckets",
    "_runtime_ledger_tca_rows_from_source_dsn",
    "_runtime_lifecycle_identifier_values",
    "_runtime_lifecycle_ledger_row",
    "_runtime_lifecycle_strategy_identifier_values",
    "_runtime_observation_authority_payload",
    "_runtime_observation_payload_with_observed_runtime_ledger_materialization",
    "_runtime_open_qtys_by_symbol_from_execution_rows",
    "_runtime_order_id",
    "_runtime_order_rows_for_bucket",
    "_runtime_source_context_for_bucket",
    "_runtime_source_decision_ids",
    "_runtime_source_lineage_hash",
    "_runtime_source_row_before_bucket",
    "_runtime_source_row_in_bucket",
    "_runtime_source_row_symbol",
    "_runtime_unlinked_order_rows_for_bucket",
    "_runtime_window_import_audit_summary",
    "_runtime_window_import_proof_hygiene_blockers",
    "_runtime_window_source_kind_is_informational",
    "_source_activity_diagnostics_blockers",
    "_source_activity_missing_summary",
    "_source_authority_order_event_row",
    "_source_backed_fill_lifecycle_order_ids",
    "_source_backed_fill_lifecycle_rows",
    "_source_backed_order_lifecycle_rows",
    "_source_backed_submitted_lifecycle_order_ids",
    "_source_collection_target_authorization_blockers",
    "_source_decision_action_offsets_open_qty",
    "_source_decision_identifier_values",
    "_source_decision_mode",
    "_source_decision_mode_counts",
    "_source_decision_mode_lookup",
    "_source_decision_mode_partition_key",
    "_source_decision_priority_payloads",
    "_source_decision_profit_proof_flag",
    "_source_decision_rows_profit_proof_eligible",
    "_source_decision_target_notional_sizing_audit",
    "_source_decision_target_notional_sizing_summary",
    "_source_identifier_values",
    "_source_kind_allows_runtime_ledger_materialization",
    "_source_offset_values",
    "_source_order_feed_payload_delta_fill",
    "_source_row_decision_ids",
    "_source_row_execution_ids",
    "_source_row_is_paper_route_probe_exit",
    "_source_row_is_paper_route_probe_exit_or_linked",
    "_source_row_lineage_missing_or_matches",
    "_source_row_matches_lineage",
    "_source_row_time_after_window",
    "_source_row_time_before",
    "_source_runtime_ledger_payload_from_row",
    "_source_window_classification_counts",
    "_source_window_gap_count",
    "_source_window_gap_ranges",
    "_source_window_query_context",
    "_source_window_status_counts",
    "_sqlalchemy_dsn",
    "_stable_payload_digest",
    "_strategy_name_candidates",
    "_strategy_relevant_unlinked_fill_lifecycle_rows",
    "_target_metadata_source_symbols",
    "_target_persistence_dsn",
    "_text_or_none",
    "_text_values",
    "_unique_source_window_rows",
    "_window_weekday_count",
    "_with_canonical_runtime_source_refs",
    "_with_linked_execution_id",
    "_with_runtime_ledger_source_authority_context",
    "argparse",
    "build_observed_runtime_buckets",
    "build_regular_session_buckets",
    "build_runtime_ledger_buckets",
    "cast",
    "contextmanager",
    "cost_basis_counts_have_non_promotion_grade_costs",
    "create_engine",
    "date",
    "datetime",
    "hashlib",
    "is_non_promotion_grade_runtime_cost_basis",
    "json",
    "main",
    "normalize_source_decision_mode",
    "os",
    "persist_observed_runtime_windows",
    "psycopg",
    "replace",
    "resolve_hypothesis_manifest",
    "runtime_ledger_promotion_source_authority_blockers",
    "runtime_ledger_promotion_source_authority_present",
    "select",
    "sessionmaker",
    "source_decision_mode_counts_have_non_profit_proof_modes",
    "source_decision_mode_counts_have_profit_proof_modes",
    "source_decision_mode_is_profit_proof_eligible",
    "time",
    "timedelta",
    "timezone",
]
