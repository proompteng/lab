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


def _strategy_name_candidates(*values: str | None) -> list[str]:
    candidates: list[str] = []
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        variants = [
            raw,
            raw.split("@", 1)[0],
            raw.replace("_", "-"),
            raw.split("@", 1)[0].replace("_", "-"),
        ]
        for variant in variants:
            normalized = variant.strip()
            if normalized and normalized not in candidates:
                candidates.append(normalized)
    return candidates


def _runtime_execution_cost_amount(
    row: Mapping[str, object],
    *,
    filled_notional: Decimal,
    side: Any = None,
    filled_qty: Decimal | None = None,
) -> Decimal | None:
    explicit_cost = _first_decimal(
        row,
        "cost_amount",
        "explicit_cost",
        "commission",
        "fees",
        "fee_amount",
        "broker_fee",
    )
    if explicit_cost is not None:
        return explicit_cost
    fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
        row,
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if fee_schedule_cost is not None:
        return fee_schedule_cost[0]
    total_cost_bps = _first_decimal(
        row,
        "total_cost_bps",
        "estimated_total_cost_bps",
        "explicit_cost_bps",
        "execution_total_cost_bps",
    )
    if total_cost_bps is None or total_cost_bps < 0 or filled_notional <= 0:
        return None
    return filled_notional * total_cost_bps / Decimal("10000")


def _runtime_execution_cost_basis(
    row: Mapping[str, object],
    *,
    cost_amount: Decimal | None,
    side: Any = None,
    filled_qty: Decimal | None = None,
    filled_notional: Decimal | None = None,
) -> str | None:
    cost_basis = _first_text(
        row,
        "cost_basis",
        "cost_source",
        "fee_basis",
        "commission_basis",
        "broker_fee_basis",
    )
    if cost_basis is not None:
        return cost_basis
    if filled_notional is not None:
        fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
            row,
            side=side,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if fee_schedule_cost is not None and cost_amount == fee_schedule_cost[0]:
            return fee_schedule_cost[1]
    if (
        cost_amount is not None
        and _first_decimal(
            row,
            "total_cost_bps",
            "estimated_total_cost_bps",
            "explicit_cost_bps",
            "execution_total_cost_bps",
        )
        is not None
    ):
        return "decision_impact_assumptions_total_cost_bps"
    return None


def _runtime_lifecycle_ledger_row(
    row: Mapping[str, object],
    *,
    event_type: str,
    require_complete_fill: bool = False,
) -> dict[str, object] | None:
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    if event_time is None:
        return None
    symbol = _first_text(row, "symbol", "order_symbol")
    ledger_row: dict[str, object] = {
        "executed_at": event_time,
        "event_type": event_type,
        "account_label": _first_text(row, "account_label", "alpaca_account_label"),
        "strategy_id": _first_text(row, "strategy_id", "strategy_name"),
        "symbol": symbol.strip().upper() if symbol is not None else None,
        "decision_id": _first_text(
            row,
            "decision_id",
            "trade_decision_id",
            "decision_hash",
        ),
        "order_id": _first_text(
            row,
            "order_id",
            "alpaca_order_id",
            "client_order_id",
            "execution_correlation_id",
        ),
        "execution_policy_hash": _first_text(
            row,
            "execution_policy_hash",
            "execution_policy_sha256",
            "policy_hash",
        )
        or _first_payload_digest(
            row,
            "execution_policy",
            "execution_policy_context",
            "execution_advisor",
            "_execution_advice_provenance",
        ),
        "cost_model_hash": _first_text(
            row,
            "cost_model_hash",
            "fee_model_hash",
            "cost_model_sha256",
        )
        or _first_payload_digest(
            row,
            "cost_model",
            "cost_model_config",
            "transaction_cost_model",
            "fee_model",
            "fees_model",
        ),
        "lineage_hash": _first_text(
            row,
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_lineage_hash",
            "candidate_evaluation_key",
            "event_fingerprint",
        )
        or _first_lineage_digest(row),
        "replay_data_hash": _first_text(
            row,
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
            "source_offset",
        ),
    }
    if _source_authority_order_event_row(row):
        ledger_row["source"] = "execution_order_event"
        ledger_row["source_materialization"] = "execution_order_events"
        ledger_row["authority_class"] = "runtime_order_feed_execution_source"
        for key in (
            "execution_order_event_id",
            "execution_id",
            "source_topic",
            "source_partition",
            "source_offset",
            "source_window_id",
        ):
            if row.get(key) is not None:
                ledger_row[key] = row[key]
    if event_type in _RUNTIME_LEDGER_FILL_EVENTS:
        side = _first_text(row, "side", "action", "order_side")
        source_authority_order_event = _source_authority_order_event_row(row)
        fill_quantity_basis = _fill_quantity_basis(row)
        filled_qty_delta = _first_positive_decimal(
            row,
            "filled_qty_delta",
            "fill_qty_delta",
            "delta_filled_qty",
        )
        filled_qty = _first_positive_decimal(
            row,
            "filled_qty",
            "filled_quantity",
            "qty",
            "quantity",
        )
        avg_fill_price = _first_positive_decimal(
            row,
            "avg_fill_price",
            "filled_avg_price",
            "filled_average_price",
            "average_fill_price",
            "fill_price",
            "filled_price",
            "price",
        )
        source_order_feed_delta_fill = (
            _source_order_feed_payload_delta_fill(row, event_type=event_type)
            if source_authority_order_event and fill_quantity_basis is None
            else None
        )
        if (
            source_authority_order_event
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is not None
        ):
            filled_qty = filled_qty_delta
        filled_notional_delta = _first_positive_decimal(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
        )
        filled_notional = _first_positive_decimal(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
            "filled_notional",
            "notional",
            "fill_notional",
        )
        if source_order_feed_delta_fill is not None:
            delta_qty, delta_price, delta_side = source_order_feed_delta_fill
            side = side or delta_side
            fill_quantity_basis = "delta"
            filled_qty_delta = delta_qty
            filled_qty = delta_qty
            avg_fill_price = delta_price
            filled_notional_delta = delta_qty * delta_price
            filled_notional = filled_notional_delta
        elif source_authority_order_event and fill_quantity_basis not in {
            "delta",
            "cumulative_to_delta",
        }:
            filled_qty = None
            filled_notional = None
        elif (
            source_authority_order_event
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is None
        ):
            filled_qty = None
            filled_notional = None
        if (
            filled_notional is None
            and filled_qty is not None
            and avg_fill_price is not None
        ):
            filled_notional = filled_qty * avg_fill_price
        cost_amount = (
            _runtime_execution_cost_amount(
                row,
                filled_notional=filled_notional,
                side=side,
                filled_qty=filled_qty,
            )
            if filled_notional is not None
            else None
        )
        cost_basis = _runtime_execution_cost_basis(
            row,
            cost_amount=cost_amount,
            side=side,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if require_complete_fill and (
            side is None
            or filled_qty is None
            or filled_qty <= 0
            or avg_fill_price is None
            or avg_fill_price <= 0
            or filled_notional is None
            or filled_notional <= 0
            or cost_amount is None
            or cost_amount < 0
            or cost_basis is None
        ):
            return None
        if side is not None:
            ledger_row["side"] = side
        if filled_qty is not None:
            ledger_row["filled_qty"] = filled_qty
        if avg_fill_price is not None:
            ledger_row["avg_fill_price"] = avg_fill_price
        if filled_notional is not None:
            ledger_row["filled_notional"] = filled_notional
        if filled_qty_delta is not None:
            ledger_row["filled_qty_delta"] = filled_qty_delta
        if filled_notional_delta is not None:
            ledger_row["filled_notional_delta"] = filled_notional_delta
        if fill_quantity_basis is not None:
            ledger_row["fill_quantity_basis"] = fill_quantity_basis
        if cost_amount is not None:
            ledger_row["cost_amount"] = cost_amount
        if cost_basis is not None:
            ledger_row["cost_basis"] = cost_basis
        if _cost_basis_is_alpaca_fee_schedule(cost_basis):
            ledger_row["cost_model_hash"] = _alpaca_2026_equity_fee_schedule_hash()
    return ledger_row


def _runtime_order_id(row: Mapping[str, object]) -> str | None:
    return _first_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )


def _execution_id_by_order_id(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    ids_by_order_id: dict[str, set[str]] = {}
    for row in rows:
        order_id = _runtime_order_id(row)
        execution_id = _first_text(row, "execution_id")
        if order_id is None or execution_id is None:
            continue
        ids_by_order_id.setdefault(order_id, set()).add(execution_id)
    return {
        order_id: next(iter(execution_ids))
        for order_id, execution_ids in ids_by_order_id.items()
        if len(execution_ids) == 1
    }


def _execution_side_by_order_id(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    sides_by_order_id: dict[str, set[str]] = {}
    for row in rows:
        order_id = _runtime_order_id(row)
        side = _first_text(row, "side", "order_side")
        if order_id is None or side is None:
            continue
        sides_by_order_id.setdefault(order_id, set()).add(side)
    return {
        order_id: next(iter(sides))
        for order_id, sides in sides_by_order_id.items()
        if len(sides) == 1
    }


def _with_linked_execution_id(
    row: Mapping[str, object],
    *,
    execution_id_by_order_id: Mapping[str, str],
    execution_side_by_order_id: Mapping[str, str] | None = None,
) -> dict[str, object]:
    payload = dict(row)
    order_id = _runtime_order_id(payload)
    if (
        _first_text(payload, "execution_id") is None
        and order_id is not None
        and (execution_id := execution_id_by_order_id.get(order_id))
    ):
        payload["execution_id"] = execution_id
    if (
        _first_text(payload, "side", "order_side") is None
        and order_id is not None
        and execution_side_by_order_id is not None
        and (side := execution_side_by_order_id.get(order_id))
    ):
        payload["side"] = side
    return payload


def _runtime_lifecycle_identifier_values(row: Mapping[str, object]) -> set[str]:
    values = _text_values(row, *_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS)
    return {value for value in values if value}


def _runtime_lifecycle_strategy_identifier_values(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        identifiers.update(_runtime_lifecycle_identifier_values(row))
    return identifiers


def _strategy_relevant_unlinked_fill_lifecycle_rows(
    *,
    execution_rows: Sequence[Mapping[str, object]],
    order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    unlinked_order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
) -> list[dict[str, object]]:
    strategy_identifiers = _runtime_lifecycle_strategy_identifier_values(
        [
            *execution_rows,
            *(order_lifecycle_rows or ()),
        ]
    )
    lineage_filter_present = candidate_id is not None or hypothesis_id is not None
    relevant_rows: list[dict[str, object]] = []
    for row in unlinked_order_lifecycle_rows or ():
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if lineage_filter_present and _source_row_matches_lineage(
            normalized,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=True,
        ):
            relevant_rows.append(normalized)
            continue
        if (
            strategy_identifiers
            and _runtime_lifecycle_identifier_values(normalized) & strategy_identifiers
        ):
            relevant_rows.append(normalized)
    return relevant_rows


def _order_feed_fill_lifecycle_blockers(
    *,
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> list[str]:
    expected_order_ids: set[str] = set()
    missing_execution_order_id = False
    for row in execution_rows:
        if not _execution_row_has_fill(row):
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            missing_execution_order_id = True
            continue
        expected_order_ids.add(order_id)

    if not expected_order_ids and not missing_execution_order_id:
        return []

    observed_fill_order_ids: set[str] = set()
    for row in order_lifecycle_rows or []:
        normalized = {str(key): value for key, value in row.items()}
        event_type = _runtime_ledger_event_type(normalized)
        if event_type not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            continue
        observed_fill_order_ids.add(order_id)

    blockers: list[str] = []
    if _strategy_relevant_unlinked_fill_lifecycle_rows(
        execution_rows=execution_rows,
        order_lifecycle_rows=order_lifecycle_rows,
        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
    ):
        blockers.append(ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER)
    if missing_execution_order_id:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER)
    if not observed_fill_order_ids:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER)
    elif expected_order_ids - observed_fill_order_ids:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER)
    return blockers


def _fill_quantity_basis(row: Mapping[str, object]) -> str | None:
    raw = _first_text(row, "fill_quantity_basis", "quantity_basis")
    if raw is None:
        return None
    normalized = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"delta", "fill_delta", "filled_delta"}:
        return "delta"
    if normalized in {"cumulative_to_delta", "cumulative_delta", "cum_to_delta"}:
        return "cumulative_to_delta"
    if normalized in {"cumulative", "cum"}:
        return "cumulative"
    if normalized in {"unknown", "cumulative_non_increasing"}:
        return normalized
    return normalized or None


def _source_order_feed_payload_delta_fill(
    row: Mapping[str, object], *, event_type: str
) -> tuple[Decimal, Decimal, str | None] | None:
    if (
        _runtime_ledger_event_type({"event_type": event_type})
        not in _RUNTIME_LEDGER_FILL_EVENTS
    ):
        return None
    raw_event = _as_mapping(row.get("raw_event"))
    if not raw_event:
        return None

    payload_candidates: list[Mapping[str, object]] = []
    for key in ("payload", "data"):
        payload = _as_mapping(raw_event.get(key))
        if payload:
            payload_candidates.append(payload)
    if _as_mapping(raw_event.get("order")):
        payload_candidates.append(raw_event)

    for payload in payload_candidates:
        payload_event = _runtime_ledger_event_type(
            {
                "event_type": _direct_text(payload, "event", "event_type")
                or event_type,
                "status": _direct_text(payload, "status"),
            }
        )
        if payload_event not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        qty = _decimal_or_none(payload.get("qty"))
        price = _decimal_or_none(payload.get("price"))
        if qty is None or qty <= 0 or price is None or price <= 0:
            continue
        order = _as_mapping(payload.get("order"))
        side = _direct_text(payload, "side", "order_side") or _direct_text(
            order, "side"
        )
        return qty, price, side
    return None


def _order_feed_fill_delta_blockers(row: Mapping[str, object]) -> list[str]:
    if not _source_authority_order_event_row(row):
        return []
    if _source_order_feed_payload_delta_fill(
        row, event_type=_runtime_ledger_event_type(row)
    ):
        return []
    basis = _fill_quantity_basis(row)
    if basis not in {"delta", "cumulative_to_delta"}:
        return [ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER]
    if (
        _first_positive_decimal(
            row,
            "filled_qty_delta",
            "fill_qty_delta",
            "delta_filled_qty",
        )
        is None
    ):
        return [ORDER_FEED_FILL_DELTA_MISSING_BLOCKER]
    return []


def _runtime_source_row_in_bucket(
    row: Mapping[str, object],
    *,
    bucket: RuntimeLedgerBucket,
) -> bool:
    row_symbol = _runtime_source_row_symbol(row)
    if (
        bucket.symbol is not None
        and row_symbol is not None
        and row_symbol != bucket.symbol
    ):
        return False
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    return (
        event_time is None
        or bucket.bucket_started_at <= event_time < bucket.bucket_ended_at
    )


def _runtime_source_row_before_bucket(
    row: Mapping[str, object],
    *,
    bucket: RuntimeLedgerBucket,
) -> bool:
    row_symbol = _runtime_source_row_symbol(row)
    if (
        bucket.symbol is not None
        and row_symbol is not None
        and row_symbol != bucket.symbol
    ):
        return False
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    return event_time is not None and event_time < bucket.bucket_started_at


def _runtime_source_decision_ids(rows: Sequence[Mapping[str, object]]) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        for key in ("trade_decision_id", "decision_id", "decision_hash"):
            value = _text_or_none(row.get(key))
            if value is not None:
                identifiers.add(value)
    return identifiers


def _ledger_row_value(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> object | None:
    if isinstance(row, Mapping):
        for key in keys:
            if key in row:
                return row.get(key)
        return None
    for key in keys:
        value = getattr(row, key, None)
        if value is not None:
            return value
    return None


def _ledger_row_text(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> str | None:
    for key in keys:
        value = _ledger_row_value(row, key)
        if (text := _text_or_none(value)) is not None:
            return text
    return None


def _ledger_row_decimal(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> Decimal | None:
    for key in keys:
        value = _ledger_row_value(row, key)
        if (parsed := _decimal_or_none(value)) is not None:
            return parsed
    return None


def _ledger_row_time(row: RuntimeLedgerFill | Mapping[str, object]) -> datetime | None:
    if isinstance(row, Mapping):
        return _runtime_ledger_row_time({str(key): value for key, value in row.items()})
    value = getattr(row, "executed_at", None)
    return value if isinstance(value, datetime) else None


def _ledger_row_event_type(row: RuntimeLedgerFill | Mapping[str, object]) -> str:
    if isinstance(row, Mapping):
        return _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
    return str(getattr(row, "event_type", "") or "").strip().lower()


def _ledger_row_order_id(row: RuntimeLedgerFill | Mapping[str, object]) -> str | None:
    return _ledger_row_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )


def _ledger_row_decision_id(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> str | None:
    return _ledger_row_text(row, "decision_id", "trade_decision_id", "decision_hash")


def _ledger_row_symbol(row: RuntimeLedgerFill | Mapping[str, object]) -> str | None:
    symbol = _ledger_row_text(row, "symbol", "ticker")
    return symbol.upper() if symbol is not None else None


def _ledger_row_position_key(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> tuple[str | None, str | None, str | None]:
    return (
        _ledger_row_text(row, "account_label", "alpaca_account_label"),
        _ledger_row_text(row, "strategy_id", "strategy_name"),
        _ledger_row_symbol(row),
    )


def _ledger_row_side_sign(row: RuntimeLedgerFill | Mapping[str, object]) -> Decimal:
    side = (_ledger_row_text(row, "side", "order_side") or "").strip().lower()
    if side in {"buy", "long", "b"}:
        return Decimal("1")
    if side in {"sell", "short", "s"}:
        return Decimal("-1")
    return Decimal("0")


def _adjust_carry_in_lot_row(
    row: RuntimeLedgerFill | Mapping[str, object],
    *,
    remaining_qty: Decimal,
    original_qty: Decimal,
) -> RuntimeLedgerFill | dict[str, object]:
    ratio = remaining_qty / original_qty if original_qty > 0 else Decimal("1")
    price = _ledger_row_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    filled_notional = remaining_qty * price if price is not None else None
    cost_amount = _ledger_row_decimal(row, "cost_amount")
    adjusted_cost = cost_amount * ratio if cost_amount is not None else None
    if isinstance(row, RuntimeLedgerFill):
        return replace(
            row,
            filled_qty=remaining_qty,
            filled_notional=filled_notional,
            cost_amount=adjusted_cost,
        )
    adjusted = dict(row)
    adjusted["filled_qty"] = remaining_qty
    if "filled_qty_delta" in adjusted:
        adjusted["filled_qty_delta"] = remaining_qty
    if filled_notional is not None:
        adjusted["filled_notional"] = filled_notional
        if "filled_notional_delta" in adjusted:
            adjusted["filled_notional_delta"] = filled_notional
    if adjusted_cost is not None:
        adjusted["cost_amount"] = adjusted_cost
    return adjusted


def _active_carry_in_ledger_rows(
    rows: Sequence[RuntimeLedgerFill | Mapping[str, object]],
    *,
    bucket_start: datetime,
) -> tuple[list[RuntimeLedgerFill | dict[str, object]], set[str], set[str]]:
    lots_by_key: dict[
        tuple[str | None, str | None, str | None],
        list[dict[str, object]],
    ] = {}
    for row in sorted(
        rows,
        key=lambda item: (
            _ledger_row_time(item) or bucket_start,
            _ledger_row_order_id(item) or "",
        ),
    ):
        event_time = _ledger_row_time(row)
        if event_time is None or event_time >= bucket_start:
            continue
        if _ledger_row_event_type(row) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        side_sign = _ledger_row_side_sign(row)
        if side_sign == 0:
            continue
        qty = _ledger_row_decimal(
            row, "filled_qty", "filled_quantity", "qty", "quantity"
        )
        price = _ledger_row_decimal(
            row,
            "avg_fill_price",
            "filled_avg_price",
            "filled_average_price",
            "average_fill_price",
            "fill_price",
            "filled_price",
        )
        if qty is None or qty <= 0 or price is None or price <= 0:
            continue
        key = _ledger_row_position_key(row)
        lots = lots_by_key.setdefault(key, [])
        remaining_qty = qty
        for lot in list(lots):
            if remaining_qty <= 0:
                break
            if cast(Decimal, lot["side_sign"]) == side_sign:
                continue
            lot_qty = cast(Decimal, lot["remaining_qty"])
            close_qty = min(remaining_qty, lot_qty)
            lot["remaining_qty"] = lot_qty - close_qty
            remaining_qty -= close_qty
            if cast(Decimal, lot["remaining_qty"]) <= 0:
                lots.remove(lot)
        if remaining_qty > 0:
            lots.append(
                {
                    "row": row,
                    "side_sign": side_sign,
                    "remaining_qty": remaining_qty,
                    "original_qty": qty,
                }
            )

    active_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    active_order_ids: set[str] = set()
    active_decision_ids: set[str] = set()
    for lots in lots_by_key.values():
        for lot in lots:
            remaining_qty = cast(Decimal, lot["remaining_qty"])
            original_qty = cast(Decimal, lot["original_qty"])
            if remaining_qty <= 0 or original_qty <= 0:
                continue
            row = cast(RuntimeLedgerFill | Mapping[str, object], lot["row"])
            adjusted = _adjust_carry_in_lot_row(
                row,
                remaining_qty=remaining_qty,
                original_qty=original_qty,
            )
            active_rows.append(adjusted)
            if (order_id := _ledger_row_order_id(adjusted)) is not None:
                active_order_ids.add(order_id)
            if (decision_id := _ledger_row_decision_id(adjusted)) is not None:
                active_decision_ids.add(decision_id)
    linked_lifecycle_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    for row in rows:
        event_time = _ledger_row_time(row)
        if event_time is None or event_time >= bucket_start:
            continue
        if _ledger_row_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        order_id = _ledger_row_order_id(row)
        decision_id = _ledger_row_decision_id(row)
        if (order_id is not None and order_id in active_order_ids) or (
            decision_id is not None and decision_id in active_decision_ids
        ):
            linked_lifecycle_rows.append(dict(row) if isinstance(row, Mapping) else row)
    return [*linked_lifecycle_rows, *active_rows], active_order_ids, active_decision_ids


def _filter_carry_in_source_rows_for_active_lots(
    rows: list[dict[str, object]] | None,
    *,
    active_order_ids: set[str],
    active_decision_ids: set[str],
) -> list[dict[str, object]] | None:
    if not rows or (not active_order_ids and not active_decision_ids):
        return None
    filtered = [
        row
        for row in rows
        if (
            (order_id := _runtime_order_id(row)) is not None
            and order_id in active_order_ids
        )
        or bool(_runtime_source_decision_ids([row]) & active_decision_ids)
    ]
    return filtered or None


def _flat_start_position_snapshot_from_cursor(
    cur: Any,
    *,
    account_label: str,
    window_start: datetime,
) -> dict[str, object] | None:
    window_start_utc = (
        window_start.astimezone(timezone.utc)
        if window_start.tzinfo is not None
        else window_start.replace(tzinfo=timezone.utc)
    )
    cur.execute(
        """
        with before_snapshot as (
            select
                id::text,
                as_of,
                positions,
                'latest_before_window_start' as snapshot_source
            from position_snapshots
            where alpaca_account_label = %s
              and as_of <= %s
            order by as_of desc
            limit 1
        ),
        after_snapshot as (
            select
                id::text,
                as_of,
                positions,
                'first_after_window_start' as snapshot_source
            from position_snapshots
            where alpaca_account_label = %s
              and as_of > %s
              and as_of <= %s
            order by as_of asc
            limit 1
        )
        select id, as_of, positions, snapshot_source, 0 as snapshot_priority
        from before_snapshot
        union all
        select id, as_of, positions, snapshot_source, 1 as snapshot_priority
        from after_snapshot
        order by snapshot_priority
        limit 1
        """,
        (
            account_label,
            window_start_utc,
            account_label,
            window_start_utc,
            window_start_utc
            + timedelta(
                seconds=RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS
            ),
        ),
    )
    rows = list(cur.fetchall())
    if not rows:
        return None
    snapshot_id, snapshot_as_of, positions, snapshot_source, _snapshot_priority = rows[
        0
    ]
    parsed_as_of = _parse_dt_or_none(snapshot_as_of)
    if parsed_as_of is None:
        return None
    offset_seconds = int((parsed_as_of - window_start_utc).total_seconds())
    blockers: list[str] = []
    if offset_seconds < -RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS:
        blockers.append("runtime_ledger_flat_start_position_snapshot_stale")
    position_count = _position_snapshot_open_position_count(positions)
    if position_count is None:
        blockers.append("runtime_ledger_flat_start_position_snapshot_positions_invalid")
        position_count = 0
    if position_count > 0:
        blockers.append("runtime_ledger_flat_start_position_snapshot_not_flat")
    return {
        "schema_version": "torghut.runtime-ledger-flat-start-position-snapshot.v1",
        "scope": "account_position_snapshot_at_runtime_window_start",
        "account_label": account_label,
        "snapshot_id": str(snapshot_id),
        "snapshot_as_of": parsed_as_of.isoformat(),
        "snapshot_source": str(snapshot_source or "position_snapshots"),
        "snapshot_offset_seconds": offset_seconds,
        "flat": position_count == 0 and not blockers,
        "position_count": position_count,
        "blockers": blockers,
    }


def _runtime_order_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    bucket_execution_order_ids = {
        order_id
        for row in execution_rows
        if _runtime_source_row_in_bucket(row, bucket=bucket)
        and _execution_row_has_fill(row)
        and (order_id := _runtime_order_id(row)) is not None
    }
    bucket_fill_order_ids = {
        order_id
        for row in order_lifecycle_rows or []
        if _runtime_source_row_in_bucket(row, bucket=bucket)
        and _runtime_ledger_event_type({str(key): value for key, value in row.items()})
        in _RUNTIME_LEDGER_FILL_EVENTS
        and (order_id := _runtime_order_id(row)) is not None
    }
    bucket_order_ids = bucket_execution_order_ids | bucket_fill_order_ids
    rows: list[dict[str, object]] = []
    for row in order_lifecycle_rows or []:
        if not _runtime_source_row_in_bucket(row, bucket=bucket):
            continue
        order_id = _runtime_order_id(row)
        if bucket_order_ids and order_id not in bucket_order_ids:
            continue
        rows.append(dict(row))
    return rows


def _runtime_decision_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    decision_lifecycle_rows: list[dict[str, object]] | None,
    source_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    decision_ids = _runtime_source_decision_ids(source_rows)
    rows: list[dict[str, object]] = []
    for row in decision_lifecycle_rows or []:
        if not _runtime_source_row_in_bucket(row, bucket=bucket):
            continue
        row_ids = _runtime_source_decision_ids([row])
        if decision_ids and not (row_ids & decision_ids):
            continue
        rows.append(dict(row))
    return rows


def _runtime_decision_rows_before_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    decision_lifecycle_rows: list[dict[str, object]] | None,
    source_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    decision_ids = _runtime_source_decision_ids(source_rows)
    rows: list[dict[str, object]] = []
    for row in decision_lifecycle_rows or []:
        if not _runtime_source_row_before_bucket(row, bucket=bucket):
            continue
        row_ids = _runtime_source_decision_ids([row])
        if decision_ids and not (row_ids & decision_ids):
            continue
        rows.append(dict(row))
    return rows


def _runtime_unlinked_order_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None,
    bucket_order_ids: set[str],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for row in unlinked_order_lifecycle_rows or []:
        if _runtime_source_row_in_bucket(row, bucket=bucket):
            rows.append(dict(row))
            continue
        row_symbol = _runtime_source_row_symbol(row)
        if (
            bucket.symbol is not None
            and row_symbol is not None
            and row_symbol != bucket.symbol
        ):
            continue
        order_id = _runtime_order_id(row)
        if order_id is not None and order_id in bucket_order_ids:
            rows.append(dict(row))
    return rows


def _event_sourced_fill_economics_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if (
            _runtime_lifecycle_ledger_row(
                normalized,
                event_type=_runtime_ledger_event_type(normalized),
                require_complete_fill=True,
            )
            is None
        ):
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids


def _source_backed_fill_lifecycle_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    source_backed_rows: list[dict[str, object]] = []
    for row in rows:
        normalized = _with_canonical_runtime_source_refs(row)
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if _runtime_order_id(normalized) is None:
            continue
        if not _source_identifier_values(
            [normalized],
            *_EXECUTION_ORDER_EVENT_REF_KEYS,
        ):
            continue
        if not _source_identifier_values([normalized], *_SOURCE_WINDOW_REF_KEYS):
            continue
        if not _source_offset_values([normalized]):
            continue
        source_backed_rows.append(dict(normalized))
    return source_backed_rows


def _source_backed_order_lifecycle_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    source_backed_rows: list[dict[str, object]] = []
    for row in rows:
        normalized = _with_canonical_runtime_source_refs(row)
        if (
            _runtime_ledger_event_type(normalized)
            not in _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS
        ):
            continue
        if _runtime_order_id(normalized) is None:
            continue
        if not _source_identifier_values(
            [normalized],
            *_EXECUTION_ORDER_EVENT_REF_KEYS,
        ):
            continue
        if not _source_identifier_values([normalized], *_SOURCE_WINDOW_REF_KEYS):
            continue
        if not _source_offset_values([normalized]):
            continue
        source_backed_rows.append(dict(normalized))
    return source_backed_rows


def _required_order_lifecycle_source_row_count(
    rows: Sequence[Mapping[str, object]],
    *,
    expected_order_ids: set[str],
) -> int:
    if not expected_order_ids:
        return 0
    count = 0
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if (
            _runtime_ledger_event_type(normalized)
            not in _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS
        ):
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is None or order_id not in expected_order_ids:
            continue
        count += 1
    return max(count, len(expected_order_ids))


def _source_backed_fill_lifecycle_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    return {
        order_id
        for row in _source_backed_fill_lifecycle_rows(rows)
        if (order_id := _runtime_order_id(row)) is not None
    }


def _source_backed_submitted_lifecycle_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in _source_backed_order_lifecycle_rows(rows):
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) != "order_submitted":
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids


def _execution_fill_economics_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        if not _execution_row_has_fill(row):
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            continue
        filled_notional = _first_positive_decimal(
            row, "filled_notional", "notional", "turnover_notional"
        ) or Decimal("0")
        if filled_notional <= 0:
            price = _first_positive_decimal(
                row,
                "avg_fill_price",
                "filled_avg_price",
                "filled_average_price",
                "average_fill_price",
                "fill_price",
                "filled_price",
            )
            qty = _first_positive_decimal(
                row, "filled_qty", "filled_quantity", "qty", "quantity"
            )
            if price is None or qty is None or price <= 0 or qty <= 0:
                continue
            filled_notional = price * qty
        cost_amount = _runtime_execution_cost_amount(
            row,
            filled_notional=filled_notional,
            side=_first_text(row, "side", "order_side") or "",
            filled_qty=(
                _first_positive_decimal(
                    row, "filled_qty", "filled_quantity", "qty", "quantity"
                )
                or Decimal("0")
            ),
        )
        cost_basis = _runtime_execution_cost_basis(
            row,
            cost_amount=cost_amount,
            side=_first_text(row, "side", "order_side") or "",
            filled_qty=(
                _first_positive_decimal(
                    row, "filled_qty", "filled_quantity", "qty", "quantity"
                )
                or Decimal("0")
            ),
            filled_notional=filled_notional,
        )
        if cost_amount is not None and cost_amount >= 0 and cost_basis is not None:
            order_ids.add(order_id)
    return order_ids


def _execution_tca_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        if not _execution_row_has_fill(row):
            continue
        if (
            _first_text(
                row,
                "execution_tca_metric_id",
                "execution_tca_metric_ref",
                "execution_tca_id",
                "tca_metric_id",
                "tca_id",
            )
            is None
        ):
            continue
        order_id = _runtime_order_id(row)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids


def _runtime_source_context_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    execution_rows: list[dict[str, object]],
    decision_lifecycle_rows: list[dict[str, object]] | None,
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    target_order_rows = _runtime_order_rows_for_bucket(
        bucket=bucket,
        execution_rows=execution_rows,
        order_lifecycle_rows=order_lifecycle_rows,
    )
    bucket_carry_in_order_rows = [
        dict(row)
        for row in carry_in_order_lifecycle_rows or []
        if _runtime_source_row_before_bucket(row, bucket=bucket)
    ]
    bucket_order_rows = [*bucket_carry_in_order_rows, *target_order_rows]
    bucket_order_ids = {
        order_id
        for row in bucket_order_rows
        if (order_id := _runtime_order_id(row)) is not None
    }
    target_execution_rows = [
        dict(row)
        for row in execution_rows
        if _execution_row_has_fill(row)
        and (
            _runtime_source_row_in_bucket(row, bucket=bucket)
            or (
                (order_id := _runtime_order_id(row)) is not None
                and order_id in bucket_order_ids
            )
        )
    ]
    bucket_carry_in_execution_rows = [
        dict(row)
        for row in carry_in_execution_rows or []
        if _execution_row_has_fill(row)
        and _runtime_source_row_before_bucket(row, bucket=bucket)
    ]
    bucket_execution_rows = [*bucket_carry_in_execution_rows, *target_execution_rows]
    target_decision_rows = _runtime_decision_rows_for_bucket(
        bucket=bucket,
        decision_lifecycle_rows=decision_lifecycle_rows,
        source_rows=[*bucket_execution_rows, *bucket_order_rows],
    )
    carry_in_decision_rows = _runtime_decision_rows_before_bucket(
        bucket=bucket,
        decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
        source_rows=[*bucket_execution_rows, *bucket_order_rows],
    )
    bucket_decision_rows = [*carry_in_decision_rows, *target_decision_rows]
    bucket_unlinked_order_rows = _runtime_unlinked_order_rows_for_bucket(
        bucket=bucket,
        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
        bucket_order_ids=bucket_order_ids,
    )
    source_rows = [*bucket_execution_rows, *bucket_decision_rows, *bucket_order_rows]
    source_backed_fill_lifecycle_rows = _source_backed_fill_lifecycle_rows(
        bucket_order_rows
    )
    source_backed_order_lifecycle_rows = _source_backed_order_lifecycle_rows(
        bucket_order_rows
    )
    expected_execution_fill_order_ids = set()
    for row in bucket_execution_rows:
        if (
            _execution_row_has_fill(row)
            and (order_id := _runtime_order_id(row)) is not None
        ):
            expected_execution_fill_order_ids.add(order_id)
    for row in bucket_order_rows:
        if (order_id := _runtime_order_id(row)) is not None:
            expected_execution_fill_order_ids.add(order_id)
    source_backed_fill_lifecycle_order_ids = _source_backed_fill_lifecycle_order_ids(
        source_backed_fill_lifecycle_rows
    )
    source_backed_submitted_lifecycle_order_ids = (
        _source_backed_submitted_lifecycle_order_ids(source_backed_order_lifecycle_rows)
    )
    event_sourced_fill_order_ids = _event_sourced_fill_economics_order_ids(
        source_backed_fill_lifecycle_rows
    )
    execution_fill_order_ids = _execution_fill_economics_order_ids(
        bucket_execution_rows
    )
    execution_tca_order_ids = _execution_tca_order_ids(bucket_execution_rows)
    execution_tca_required = any(
        _execution_row_has_fill(row)
        and any(
            key in row
            for key in (
                "execution_tca_metric_id",
                "execution_tca_metric_ref",
                "execution_tca_id",
                "tca_metric_id",
                "tca_id",
            )
        )
        for row in bucket_execution_rows
    )
    order_feed_fill_economics_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(event_sourced_fill_order_ids)
    execution_fill_economics_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(execution_fill_order_ids)
    execution_tca_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(execution_tca_order_ids)
    execution_tca_satisfied = (not execution_tca_required) or execution_tca_complete
    source_backed_fill_lifecycle_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(
        source_backed_fill_lifecycle_order_ids
    )
    source_backed_submitted_lifecycle_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(
        source_backed_submitted_lifecycle_order_ids
    )
    source_backed_order_lifecycle_complete = (
        source_backed_fill_lifecycle_complete
        and source_backed_submitted_lifecycle_complete
    )
    source_authority_lifecycle_rows = (
        source_backed_order_lifecycle_rows
        if source_backed_order_lifecycle_complete
        else source_backed_fill_lifecycle_rows
    )
    source_authority_lifecycle_times = [
        event_time
        for row in source_authority_lifecycle_rows
        if (
            event_time := _runtime_ledger_row_time(
                {str(key): value for key, value in row.items()}
            )
        )
        is not None
    ]
    source_window_ids = _source_identifier_values(
        source_authority_lifecycle_rows,
        *_SOURCE_WINDOW_REF_KEYS,
    )
    required_order_lifecycle_source_row_count = (
        _required_order_lifecycle_source_row_count(
            bucket_order_rows,
            expected_order_ids=expected_execution_fill_order_ids,
        )
    )
    execution_tca_metric_ids = _source_identifier_values(
        bucket_execution_rows,
        "execution_tca_metric_id",
        "execution_tca_metric_ref",
        "execution_tca_id",
        "tca_metric_id",
        "tca_id",
    )
    source_row_counts = {
        "trade_decisions": len(bucket_decision_rows),
        "executions": len(bucket_execution_rows),
        "execution_order_events": required_order_lifecycle_source_row_count,
    }
    if execution_tca_metric_ids:
        source_row_counts["execution_tca_metrics"] = len(execution_tca_metric_ids)
    if source_window_ids:
        source_row_counts["order_feed_source_windows"] = len(source_window_ids)
    elif required_order_lifecycle_source_row_count > 0:
        source_row_counts["order_feed_source_windows"] = 1
    source_refs = [
        ref
        for table, ref in (
            ("trade_decisions", "postgres:trade_decisions"),
            ("executions", "postgres:executions"),
            ("execution_tca_metrics", "postgres:execution_tca_metrics"),
            ("execution_order_events", "postgres:execution_order_events"),
            ("order_feed_source_windows", "postgres:order_feed_source_windows"),
        )
        if source_row_counts.get(table, 0) > 0
    ]
    source_materialization = None
    authority_class = None
    authority_reason = None
    source_offsets = _source_offset_values(source_authority_lifecycle_rows)
    source_window_status_counts = _source_window_status_counts(
        source_authority_lifecycle_rows
    )
    source_window_classification_counts = _source_window_classification_counts(
        source_authority_lifecycle_rows
    )
    source_window_gap_count = _source_window_gap_count(source_authority_lifecycle_rows)
    source_window_gap_ranges = _source_window_gap_ranges(
        source_authority_lifecycle_rows
    )
    execution_order_event_ids = _source_identifier_values(
        source_authority_lifecycle_rows,
        *_EXECUTION_ORDER_EVENT_REF_KEYS,
    )
    if source_offsets and execution_order_event_ids:
        if order_feed_fill_economics_complete and execution_tca_satisfied:
            source_materialization = "execution_order_events"
            authority_class = "runtime_order_feed_execution_source"
            authority_reason = "event_sourced_runtime_ledger_profit_proof"
        elif (
            execution_fill_economics_complete
            and execution_tca_satisfied
            and source_backed_order_lifecycle_complete
        ):
            source_materialization = "source_execution_lifecycle"
            authority_class = "source_execution_lifecycle_materialized_runtime_ledger"
            authority_reason = "source_execution_lifecycle_materialized_runtime_ledger"
    return {
        "execution_rows": bucket_execution_rows,
        "decision_rows": bucket_decision_rows,
        "order_rows": bucket_order_rows,
        "unlinked_order_rows": bucket_unlinked_order_rows,
        "source_rows": source_rows,
        "source_window_ids": source_window_ids,
        "source_window_start": (
            min(source_authority_lifecycle_times)
            if source_authority_lifecycle_times
            else bucket.bucket_started_at
        ),
        "source_window_end": (
            max(source_authority_lifecycle_times) + timedelta(microseconds=1)
            if source_authority_lifecycle_times
            else bucket.bucket_ended_at
        ),
        "source_row_counts": source_row_counts,
        "source_refs": source_refs,
        "trade_decision_ids": _source_identifier_values(
            source_rows,
            "trade_decision_id",
            "decision_id",
            "decision_hash",
        ),
        "execution_ids": _source_identifier_values(
            [*bucket_execution_rows, *bucket_order_rows],
            "execution_id",
        ),
        "execution_tca_metric_ids": execution_tca_metric_ids,
        "execution_order_event_ids": execution_order_event_ids,
        "source_window_status_counts": source_window_status_counts,
        "source_window_classification_counts": source_window_classification_counts,
        "source_window_gap_count": source_window_gap_count,
        "source_window_gap_ranges": source_window_gap_ranges,
        "source_offsets": source_offsets,
        "source_materialization": source_materialization,
        "authority_class": authority_class,
        "authority_reason": authority_reason,
        "order_feed_lifecycle_complete": source_backed_order_lifecycle_complete,
        "fill_economics_complete": (
            (order_feed_fill_economics_complete or execution_fill_economics_complete)
            and execution_tca_satisfied
        ),
        "execution_tca_required": execution_tca_required,
        "execution_tca_complete": execution_tca_complete,
        "order_feed_fill_lifecycle_blockers": _order_feed_fill_lifecycle_blockers(
            execution_rows=bucket_execution_rows,
            order_lifecycle_rows=bucket_order_rows,
            unlinked_order_lifecycle_rows=bucket_unlinked_order_rows,
        ),
        "source_account_labels": sorted(
            {
                str(row.get("source_account_label") or "").strip()
                for row in source_rows
                if str(row.get("source_account_label") or "").strip()
            }
        ),
        "source_decision_mode_counts": _source_decision_mode_counts(source_rows),
        "source_decision_profit_proof_eligible": (
            _source_decision_rows_profit_proof_eligible(source_rows)
        ),
        "paper_route_target_notional_sizing": (
            _source_decision_target_notional_sizing_summary(source_rows)
        ),
        "equity_denominator": _runtime_ledger_equity_denominator_from_rows(source_rows),
    }


def _source_activity_diagnostics_blockers(
    diagnostics: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []

    def add(blocker: str) -> None:
        if blocker not in blockers:
            blockers.append(blocker)

    if _text_or_none(diagnostics.get("runtime_ledger_source_bucket_unavailable")):
        add("runtime_ledger_source_bucket_unavailable")

    decision_query_count = _nonnegative_int(
        diagnostics.get("decision_rows_before_lineage_filter")
    )
    execution_query_count = _nonnegative_int(
        diagnostics.get("execution_rows_before_lineage_filter")
    )
    order_query_count = _nonnegative_int(
        diagnostics.get("order_lifecycle_rows_before_lineage_filter")
    )
    decision_lineage_count = _nonnegative_int(
        diagnostics.get("decision_rows_after_lineage_filter")
    )
    execution_lineage_count = _nonnegative_int(
        diagnostics.get("execution_rows_after_lineage_filter")
    )
    execution_tca_lineage_count = _nonnegative_int(
        diagnostics.get("execution_tca_rows_after_lineage_filter")
    )
    source_bucket_count = _nonnegative_int(
        diagnostics.get("runtime_ledger_source_bucket_count")
    )
    source_bucket_profit_proof_count = _nonnegative_int(
        diagnostics.get("runtime_ledger_source_bucket_profit_proof_count")
    )
    unlinked_fill_lifecycle_count = _nonnegative_int(
        diagnostics.get("order_feed_unlinked_fill_lifecycle_count")
    )
    if "order_feed_unlinked_strategy_fill_lifecycle_count" in diagnostics:
        strategy_unlinked_fill_lifecycle_count = _nonnegative_int(
            diagnostics.get("order_feed_unlinked_strategy_fill_lifecycle_count")
        )
    else:
        strategy_unlinked_fill_lifecycle_count = unlinked_fill_lifecycle_count

    if (decision_query_count or execution_query_count or order_query_count) and not (
        decision_lineage_count or execution_lineage_count
    ):
        add("source_lineage_filter_excluded_activity")
    elif not (
        decision_query_count
        or execution_query_count
        or order_query_count
        or source_bucket_count
    ):
        add("strategy_account_symbol_window_source_activity_missing")

    if decision_lineage_count > 0 and execution_lineage_count <= 0:
        add("execution_rows_missing_for_matched_decisions")
    if execution_lineage_count > 0 and order_query_count <= 0:
        add(ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER)
    if execution_lineage_count > 0 and execution_tca_lineage_count <= 0:
        add("execution_tca_rows_missing")
    if strategy_unlinked_fill_lifecycle_count > 0:
        add(ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER)
    if source_bucket_count <= 0:
        add("runtime_ledger_source_bucket_missing")
    elif source_bucket_profit_proof_count <= 0:
        add("runtime_ledger_source_bucket_profit_proof_missing")

    for blocker in _metadata_text_list(
        diagnostics.get("runtime_ledger_source_bucket_profit_proof_blockers")
    ):
        add(blocker)

    for blocker in _metadata_text_list(
        diagnostics.get("order_feed_fill_lifecycle_blockers")
    ):
        add(blocker)

    return blockers


def _runtime_execution_ledger_fill_from_row(
    row: Mapping[str, object],
    *,
    order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    event_sourced_fill_economics_order_ids: set[str] | None = None,
) -> tuple[RuntimeLedgerFill | None, list[datetime]]:
    computed_at = row.get("computed_at")
    execution_event_at = row.get("execution_event_at")
    execution_created_at = row.get("execution_created_at")
    fill_event_at = (
        execution_created_at
        if isinstance(execution_created_at, datetime)
        else computed_at
    )
    if isinstance(execution_event_at, datetime):
        fill_event_at = execution_event_at
    ledger_computed_at = (
        fill_event_at if isinstance(fill_event_at, datetime) else computed_at
    )
    price = _first_positive_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    side = _first_text(row, "side", "order_side") or ""
    signed_qty = _execution_signed_qty(
        side=side,
        qty=_first_positive_decimal(
            row,
            "filled_qty",
            "filled_quantity",
            "qty",
            "quantity",
        ),
    )
    symbol = str(row.get("symbol") or "").strip().upper()
    if not symbol or not isinstance(ledger_computed_at, datetime):
        return None, []
    decision_id = _first_text(row, "decision_id", "trade_decision_id", "decision_hash")
    order_id = _first_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )
    execution_policy_hash = _first_text(
        row,
        "execution_policy_hash",
        "execution_policy_sha256",
        "policy_hash",
    ) or _first_payload_digest(
        row,
        "execution_policy",
        "execution_policy_context",
        "execution_advisor",
        "_execution_advice_provenance",
    )
    cost_model_hash = _first_text(
        row, "cost_model_hash", "fee_model_hash", "cost_model_sha256"
    ) or _first_payload_digest(
        row,
        "cost_model",
        "cost_model_config",
        "transaction_cost_model",
        "fee_model",
        "fees_model",
        "model",
    )
    lineage_hash = _first_text(
        row,
        "lineage_hash",
        "candidate_lineage_hash",
        "replay_lineage_hash",
        "candidate_evaluation_key",
    ) or _first_lineage_digest(row)
    replay_data_hash = _first_text(
        row,
        "replay_data_hash",
        "replay_tape_content_sha256",
        "dataset_snapshot_hash",
        "source_query_digest",
    )
    if price is None or price <= 0 or signed_qty == 0:
        return None, []
    event_sourced_order_ids = (
        event_sourced_fill_economics_order_ids
        if event_sourced_fill_economics_order_ids is not None
        else _event_sourced_fill_economics_order_ids(order_lifecycle_rows or [])
    )
    if order_id is not None and order_id in event_sourced_order_ids:
        return None, []
    event_times = [ledger_computed_at]
    if isinstance(fill_event_at, datetime):
        event_times.append(fill_event_at)
    filled_qty = abs(signed_qty)
    filled_notional = filled_qty * price
    cost_amount = _runtime_execution_cost_amount(
        row,
        filled_notional=filled_notional,
        side=side,
        filled_qty=filled_qty,
    )
    cost_basis = _runtime_execution_cost_basis(
        row,
        cost_amount=cost_amount,
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if _cost_basis_is_alpaca_fee_schedule(cost_basis):
        cost_model_hash = _alpaca_2026_equity_fee_schedule_hash()
    return (
        RuntimeLedgerFill(
            executed_at=fill_event_at
            if isinstance(fill_event_at, datetime)
            else ledger_computed_at,
            event_type="fill",
            decision_id=decision_id,
            order_id=order_id,
            execution_policy_hash=execution_policy_hash,
            cost_model_hash=cost_model_hash,
            lineage_hash=lineage_hash,
            replay_data_hash=replay_data_hash,
            side=side,
            filled_qty=filled_qty,
            avg_fill_price=price,
            filled_notional=filled_notional,
            cost_amount=cost_amount,
            cost_basis=cost_basis,
            account_label=str(row.get("account_label") or "") or None,
            strategy_id=str(row.get("strategy_id") or "") or None,
            symbol=symbol,
        ),
        event_times,
    )


def _build_realized_strategy_pnl_rows(
    execution_rows: list[dict[str, object]],
    *,
    decision_lifecycle_rows: list[dict[str, object]] | None = None,
    order_lifecycle_rows: list[dict[str, object]] | None = None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
    flat_start_position_snapshot: Mapping[str, object] | None = None,
    allow_authoritative_runtime_ledger_materialization: bool = False,
    split_mixed_source_decision_modes: bool = True,
) -> list[dict[str, object]]:
    flat_start_authority = _flat_start_position_snapshot_authority(
        flat_start_position_snapshot
    )
    if flat_start_authority is not None:
        carry_in_execution_rows = None
        carry_in_decision_lifecycle_rows = None
        carry_in_order_lifecycle_rows = None
    if split_mixed_source_decision_modes:
        partitions = _partition_runtime_source_rows_by_decision_mode(
            execution_rows=execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
        )
        if partitions is not None:
            partition_rows: list[dict[str, object]] = []
            for (
                mode_key,
                partition_execution_rows,
                partition_decision_rows,
                partition_order_rows,
                partition_unlinked_order_rows,
                partition_carry_in_execution_rows,
                partition_carry_in_decision_rows,
                partition_carry_in_order_rows,
            ) in partitions:
                for row in _build_realized_strategy_pnl_rows(
                    partition_execution_rows,
                    decision_lifecycle_rows=partition_decision_rows,
                    order_lifecycle_rows=partition_order_rows,
                    unlinked_order_lifecycle_rows=partition_unlinked_order_rows,
                    carry_in_execution_rows=partition_carry_in_execution_rows,
                    carry_in_decision_lifecycle_rows=partition_carry_in_decision_rows,
                    carry_in_order_lifecycle_rows=partition_carry_in_order_rows,
                    flat_start_position_snapshot=flat_start_position_snapshot,
                    allow_authoritative_runtime_ledger_materialization=(
                        allow_authoritative_runtime_ledger_materialization
                    ),
                    split_mixed_source_decision_modes=False,
                ):
                    row["source_decision_mode_partition"] = mode_key
                    bucket = row.get("runtime_ledger_bucket")
                    if isinstance(bucket, Mapping):
                        row["runtime_ledger_bucket"] = {
                            **dict(bucket),
                            "source_decision_mode_partition": mode_key,
                        }
                    partition_rows.append(row)
            return partition_rows

    if not (
        execution_rows
        or decision_lifecycle_rows
        or carry_in_execution_rows
        or carry_in_decision_lifecycle_rows
    ):
        return []

    ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    carry_in_ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    event_times: list[datetime] = []
    execution_order_ids = {
        order_id for row in execution_rows if (order_id := _runtime_order_id(row))
    }
    execution_ids = {
        execution_id
        for row in execution_rows
        if (execution_id := _first_text(row, "execution_id"))
    }
    execution_symbols = {
        symbol
        for row in execution_rows
        if (symbol := _runtime_source_row_symbol(row)) is not None
    }
    decision_lifecycle_ids = _runtime_source_decision_ids(decision_lifecycle_rows or [])
    carry_in_execution_order_ids = {
        order_id
        for row in carry_in_execution_rows or []
        if (order_id := _runtime_order_id(row))
    }
    carry_in_execution_ids = {
        execution_id
        for row in carry_in_execution_rows or []
        if (execution_id := _first_text(row, "execution_id"))
    }
    carry_in_execution_symbols = {
        symbol
        for row in carry_in_execution_rows or []
        if (symbol := _runtime_source_row_symbol(row)) is not None
    }
    carry_in_decision_lifecycle_ids = _runtime_source_decision_ids(
        carry_in_decision_lifecycle_rows or []
    )
    execution_id_by_order_id = _execution_id_by_order_id(execution_rows)
    carry_in_execution_id_by_order_id = _execution_id_by_order_id(
        carry_in_execution_rows or []
    )
    execution_side_by_order_id = _execution_side_by_order_id(execution_rows)
    carry_in_execution_side_by_order_id = _execution_side_by_order_id(
        carry_in_execution_rows or []
    )
    order_lifecycle_rows = [
        _with_canonical_runtime_source_refs(
            _with_linked_execution_id(
                row,
                execution_id_by_order_id=execution_id_by_order_id,
                execution_side_by_order_id=execution_side_by_order_id,
            )
        )
        for row in order_lifecycle_rows or []
    ]
    carry_in_order_lifecycle_rows = [
        _with_canonical_runtime_source_refs(
            _with_linked_execution_id(
                row,
                execution_id_by_order_id=carry_in_execution_id_by_order_id,
                execution_side_by_order_id=carry_in_execution_side_by_order_id,
            )
        )
        for row in carry_in_order_lifecycle_rows or []
    ]
    event_sourced_fill_economics_order_ids = _event_sourced_fill_economics_order_ids(
        order_lifecycle_rows
    )
    for row in decision_lifecycle_rows or []:
        lifecycle_row = _runtime_lifecycle_ledger_row(row, event_type="decision")
        if lifecycle_row is None:
            continue
        ledger_rows.append(lifecycle_row)
        event_time = lifecycle_row.get("executed_at")
        if isinstance(event_time, datetime):
            event_times.append(event_time)
    for row in order_lifecycle_rows:
        row_order_id = _runtime_order_id(row)
        row_execution_id = _first_text(row, "execution_id")
        row_symbol = _runtime_source_row_symbol(row)
        if (
            (execution_order_ids or execution_ids or execution_symbols)
            and row_order_id not in execution_order_ids
            and row_execution_id not in execution_ids
            and row_symbol not in execution_symbols
        ):
            continue
        if (
            not (execution_order_ids or execution_ids or execution_symbols)
            and decision_lifecycle_ids
        ):
            row_decision_ids = _runtime_source_decision_ids([row])
            if row_decision_ids and not (row_decision_ids & decision_lifecycle_ids):
                continue
        event_type = _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
        if event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            lifecycle_row = _runtime_lifecycle_ledger_row(
                row,
                event_type=event_type,
                require_complete_fill=True,
            )
            if lifecycle_row is None:
                if (
                    row_order_id in execution_order_ids
                    or row_execution_id in execution_ids
                    or (
                        not execution_order_ids
                        and not execution_ids
                        and not execution_symbols
                        and _source_authority_order_event_row(row)
                    )
                ):
                    lifecycle_row = _runtime_lifecycle_ledger_row(
                        row,
                        event_type=event_type,
                    )
                    if lifecycle_row is not None:
                        lifecycle_row["source"] = "order_feed_lifecycle"
            if lifecycle_row is not None:
                ledger_rows.append(lifecycle_row)
                event_time = lifecycle_row.get("executed_at")
                if isinstance(event_time, datetime):
                    event_times.append(event_time)
                continue
            event_time = _runtime_ledger_row_time(row)
            if isinstance(event_time, datetime):
                event_times.append(event_time)
            continue
        lifecycle_row = _runtime_lifecycle_ledger_row(
            row,
            event_type=event_type,
        )
        if lifecycle_row is None:
            continue
        ledger_rows.append(lifecycle_row)
        event_time = lifecycle_row.get("executed_at")
        if isinstance(event_time, datetime):
            event_times.append(event_time)
    for row in execution_rows:
        ledger_fill, ledger_event_times = _runtime_execution_ledger_fill_from_row(
            row,
            order_lifecycle_rows=order_lifecycle_rows,
            event_sourced_fill_economics_order_ids=(
                event_sourced_fill_economics_order_ids
            ),
        )
        if ledger_fill is None:
            continue
        ledger_rows.append(ledger_fill)
        event_times.extend(ledger_event_times)

    for row in carry_in_decision_lifecycle_rows or []:
        lifecycle_row = _runtime_lifecycle_ledger_row(row, event_type="decision")
        if lifecycle_row is not None:
            carry_in_ledger_rows.append(lifecycle_row)
    for row in carry_in_order_lifecycle_rows:
        row_order_id = _runtime_order_id(row)
        row_execution_id = _first_text(row, "execution_id")
        row_symbol = _runtime_source_row_symbol(row)
        if (
            (
                carry_in_execution_order_ids
                or carry_in_execution_ids
                or carry_in_execution_symbols
            )
            and row_order_id not in carry_in_execution_order_ids
            and row_execution_id not in carry_in_execution_ids
            and row_symbol not in carry_in_execution_symbols
        ):
            continue
        if (
            not (
                carry_in_execution_order_ids
                or carry_in_execution_ids
                or carry_in_execution_symbols
            )
            and carry_in_decision_lifecycle_ids
        ):
            row_decision_ids = _runtime_source_decision_ids([row])
            if row_decision_ids and not (
                row_decision_ids & carry_in_decision_lifecycle_ids
            ):
                continue
        event_type = _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
        lifecycle_row = _runtime_lifecycle_ledger_row(
            row,
            event_type=event_type,
            require_complete_fill=event_type in _RUNTIME_LEDGER_FILL_EVENTS,
        )
        if lifecycle_row is None and event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            if (
                row_order_id in carry_in_execution_order_ids
                or row_execution_id in carry_in_execution_ids
                or (
                    not carry_in_execution_order_ids
                    and not carry_in_execution_ids
                    and not carry_in_execution_symbols
                    and _source_authority_order_event_row(row)
                )
            ):
                lifecycle_row = _runtime_lifecycle_ledger_row(
                    row,
                    event_type=event_type,
                )
                if lifecycle_row is not None:
                    lifecycle_row["source"] = "order_feed_lifecycle"
        if lifecycle_row is not None:
            carry_in_ledger_rows.append(lifecycle_row)
    combined_order_lifecycle_rows = [
        *(carry_in_order_lifecycle_rows or []),
        *(order_lifecycle_rows or []),
    ]
    combined_event_sourced_fill_economics_order_ids = (
        _event_sourced_fill_economics_order_ids(combined_order_lifecycle_rows)
    )
    for row in carry_in_execution_rows or []:
        ledger_fill, _ledger_event_times = _runtime_execution_ledger_fill_from_row(
            row,
            order_lifecycle_rows=combined_order_lifecycle_rows,
            event_sourced_fill_economics_order_ids=(
                combined_event_sourced_fill_economics_order_ids
            ),
        )
        if ledger_fill is not None:
            carry_in_ledger_rows.append(ledger_fill)
    if not event_times:
        return []
    unique_times = sorted(set(event_times))
    (
        carry_in_ledger_rows,
        active_carry_in_order_ids,
        active_carry_in_decision_ids,
    ) = _active_carry_in_ledger_rows(
        carry_in_ledger_rows,
        bucket_start=unique_times[0],
    )
    carry_in_execution_rows = _filter_carry_in_source_rows_for_active_lots(
        carry_in_execution_rows,
        active_order_ids=active_carry_in_order_ids,
        active_decision_ids=active_carry_in_decision_ids,
    )
    carry_in_decision_lifecycle_rows = _filter_carry_in_source_rows_for_active_lots(
        carry_in_decision_lifecycle_rows,
        active_order_ids=active_carry_in_order_ids,
        active_decision_ids=active_carry_in_decision_ids,
    )
    carry_in_order_lifecycle_rows = _filter_carry_in_source_rows_for_active_lots(
        carry_in_order_lifecycle_rows,
        active_order_ids=active_carry_in_order_ids,
        active_decision_ids=active_carry_in_decision_ids,
    )
    bucket_ranges = [(unique_times[0], unique_times[-1] + timedelta(microseconds=1))]
    realized_rows: list[dict[str, object]] = []
    for bucket in build_runtime_ledger_buckets(
        ledger_rows,
        bucket_ranges=bucket_ranges,
        group_by=("symbol",),
        require_order_lifecycle=True,
        carry_in_rows=carry_in_ledger_rows,
    ):
        if bucket.closed_trade_count <= 0 and not bucket.blockers:
            continue
        row = _runtime_ledger_tca_row_from_bucket(
            bucket=bucket,
            computed_at=unique_times[-1],
        )
        bucket_payload = row.get("runtime_ledger_bucket")
        source_context = _runtime_source_context_for_bucket(
            bucket=bucket,
            execution_rows=execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
        )
        source_account_labels = cast(list[str], source_context["source_account_labels"])
        source_decision_mode_counts = cast(
            dict[str, int], source_context["source_decision_mode_counts"]
        )
        source_decision_profit_proof_eligible = bool(
            source_context["source_decision_profit_proof_eligible"]
        )
        target_notional_sizing = cast(
            dict[str, object], source_context["paper_route_target_notional_sizing"]
        )
        target_notional_sizing_blockers = _metadata_text_list(
            target_notional_sizing.get("blockers")
        )
        source_refs = cast(list[str], source_context["source_refs"])
        source_row_counts = cast(dict[str, int], source_context["source_row_counts"])
        trade_decision_ids = cast(list[str], source_context["trade_decision_ids"])
        execution_ids = cast(list[str], source_context["execution_ids"])
        execution_tca_metric_ids = cast(
            list[str], source_context["execution_tca_metric_ids"]
        )
        execution_order_event_ids = cast(
            list[str], source_context["execution_order_event_ids"]
        )
        source_window_ids = cast(list[str], source_context["source_window_ids"])
        source_window_status_counts = cast(
            dict[str, int], source_context["source_window_status_counts"]
        )
        source_window_classification_counts = cast(
            dict[str, int], source_context["source_window_classification_counts"]
        )
        source_window_gap_count = int(source_context["source_window_gap_count"] or 0)
        source_window_gap_ranges = cast(
            list[Mapping[str, object]], source_context["source_window_gap_ranges"]
        )
        source_window_start = cast(datetime, source_context["source_window_start"])
        source_window_end = cast(datetime, source_context["source_window_end"])
        source_offsets = cast(
            list[Mapping[str, object]], source_context["source_offsets"]
        )
        source_materialization = cast(
            str | None, source_context["source_materialization"]
        )
        authority_class = cast(str | None, source_context["authority_class"])
        authority_reason = cast(str | None, source_context["authority_reason"])
        order_feed_lifecycle_complete = bool(
            source_context["order_feed_lifecycle_complete"]
        )
        fill_economics_complete = bool(source_context["fill_economics_complete"])
        execution_tca_required = bool(source_context["execution_tca_required"])
        execution_tca_complete = bool(source_context["execution_tca_complete"])
        bucket_order_feed_fill_lifecycle_blockers = cast(
            list[str], source_context["order_feed_fill_lifecycle_blockers"]
        )
        bucket_source_materialization_blockers = list(
            bucket_order_feed_fill_lifecycle_blockers
        )
        if (
            execution_tca_required
            and not execution_tca_complete
            and EXECUTION_TCA_MISSING_BLOCKER
            not in bucket_source_materialization_blockers
        ):
            bucket_source_materialization_blockers.append(EXECUTION_TCA_MISSING_BLOCKER)
        if (
            execution_tca_required
            and not execution_tca_complete
            and RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER
            not in bucket_source_materialization_blockers
        ):
            bucket_source_materialization_blockers.append(
                RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER
            )
        equity_denominator = cast(
            tuple[Decimal, str] | None, source_context["equity_denominator"]
        )
        if flat_start_authority is not None and isinstance(bucket_payload, Mapping):
            row.update(flat_start_authority)
            bucket_payload = {
                **dict(bucket_payload),
                **flat_start_authority,
            }
            row["runtime_ledger_bucket"] = bucket_payload
        if source_account_labels and isinstance(bucket_payload, Mapping):
            bucket_payload = {
                **dict(bucket_payload),
                "source_account_labels": source_account_labels,
            }
            if len(source_account_labels) == 1:
                bucket_payload["source_account_label"] = source_account_labels[0]
            row["runtime_ledger_bucket"] = bucket_payload
        if source_decision_mode_counts:
            row["source_decision_mode_counts"] = source_decision_mode_counts
            row["profit_proof_eligible"] = source_decision_profit_proof_eligible
            if isinstance(bucket_payload, Mapping):
                source_decision_mode = next(
                    iter(source_decision_mode_counts),
                    None,
                )
                bucket_payload = {
                    **dict(bucket_payload),
                    "source_decision_mode_counts": source_decision_mode_counts,
                    "profit_proof_eligible": source_decision_profit_proof_eligible,
                }
                if len(source_decision_mode_counts) == 1:
                    row["source_decision_mode"] = source_decision_mode
                    bucket_payload["source_decision_mode"] = source_decision_mode
                if not source_decision_profit_proof_eligible:
                    blockers = list(bucket_payload.get("blockers") or [])
                    if (
                        SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                        not in blockers
                    ):
                        blockers.append(
                            SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                        )
                    bucket_payload["blockers"] = blockers
                    row["runtime_ledger_blockers"] = blockers
                    row["post_cost_promotion_eligible"] = False
                    row["promotion_blocker"] = (
                        SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                    )
                row["runtime_ledger_bucket"] = bucket_payload
        if target_notional_sizing.get("requires_target_notional_sizing"):
            row["paper_route_target_notional_sizing"] = target_notional_sizing
            if isinstance(bucket_payload, Mapping):
                bucket_payload = {
                    **dict(bucket_payload),
                    "paper_route_target_notional_sizing": target_notional_sizing,
                }
                if target_notional_sizing_blockers:
                    blockers = list(bucket_payload.get("blockers") or [])
                    for blocker in target_notional_sizing_blockers:
                        if blocker not in blockers:
                            blockers.append(blocker)
                    bucket_payload["blockers"] = blockers
                    row["runtime_ledger_blockers"] = blockers
                    row["post_cost_promotion_eligible"] = False
                    row["promotion_blocker"] = target_notional_sizing_blockers[0]
                row["runtime_ledger_bucket"] = bucket_payload
        if isinstance(bucket_payload, Mapping):
            bucket_payload = _with_runtime_ledger_source_authority_context(
                bucket_payload,
                source_window_start=source_window_start,
                source_window_end=source_window_end,
                source_refs=source_refs,
                source_row_counts=source_row_counts,
                trade_decision_ids=trade_decision_ids,
                execution_ids=execution_ids,
                execution_tca_metric_ids=execution_tca_metric_ids,
                execution_order_event_ids=execution_order_event_ids,
                source_window_ids=source_window_ids,
                source_offsets=source_offsets,
                source_window_status_counts=source_window_status_counts,
                source_window_classification_counts=source_window_classification_counts,
                source_window_gap_count=source_window_gap_count,
                source_window_gap_ranges=source_window_gap_ranges,
                order_feed_lifecycle_complete=order_feed_lifecycle_complete,
                execution_economics_complete=fill_economics_complete,
                execution_tca_required=execution_tca_required,
                source_materialization=source_materialization,
                authority_class=authority_class,
                authority_reason=authority_reason,
            )
            row["runtime_ledger_bucket"] = bucket_payload
            row["runtime_ledger_blockers"] = _metadata_text_list(
                bucket_payload.get("blockers")
            )
        source_backed_runtime_ledger = (
            allow_authoritative_runtime_ledger_materialization
            and fill_economics_complete
            and not bucket_source_materialization_blockers
            and isinstance(bucket_payload, Mapping)
            and not runtime_ledger_promotion_source_authority_blockers(bucket_payload)
        )
        event_sourced_runtime_ledger = (
            source_backed_runtime_ledger
            and isinstance(bucket_payload, Mapping)
            and _runtime_ledger_bucket_profit_proof_present(bucket_payload)
        )
        if event_sourced_runtime_ledger:
            row["authoritative"] = True
            row["authority_reason"] = "event_sourced_runtime_ledger_profit_proof"
            row["pnl_derivation"] = "execution_order_events_runtime_ledger"
            row["post_cost_promotion_eligible"] = True
            row["runtime_ledger_blockers"] = []
            row.pop("promotion_blocker", None)
            if isinstance(bucket_payload, Mapping):
                runtime_bucket = {
                    **dict(bucket_payload),
                    "authoritative": True,
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "pnl_derivation": "execution_order_events_runtime_ledger",
                    "source_materialization": (
                        source_materialization or "source_execution_lifecycle"
                    ),
                }
                if equity_denominator is not None:
                    runtime_bucket["account_equity"] = str(equity_denominator[0])
                    runtime_bucket["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = runtime_bucket
        elif source_backed_runtime_ledger:
            row["post_cost_expectancy_basis"] = POST_COST_BASIS_RUNTIME_LEDGER
            row["post_cost_promotion_eligible"] = False
            row["authoritative"] = False
            row["authority_reason"] = (
                "source_execution_lifecycle_materialized_runtime_ledger"
            )
            row["pnl_derivation"] = "execution_order_events_runtime_ledger"
            blockers = list(row.get("runtime_ledger_blockers") or [])
            row["runtime_ledger_blockers"] = blockers
            if blockers:
                row["promotion_blocker"] = blockers[0]
            else:
                row.pop("promotion_blocker", None)
            if isinstance(bucket_payload, Mapping):
                runtime_bucket = {
                    **dict(bucket_payload),
                    "blockers": blockers,
                    "pnl_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "authoritative": False,
                    "authority_reason": (
                        "source_execution_lifecycle_materialized_runtime_ledger"
                    ),
                    "pnl_derivation": "execution_order_events_runtime_ledger",
                    "source_materialization": (
                        source_materialization or "source_execution_lifecycle"
                    ),
                }
                if equity_denominator is not None:
                    runtime_bucket["account_equity"] = str(equity_denominator[0])
                    runtime_bucket["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = runtime_bucket
        else:
            row["post_cost_expectancy_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
            row["post_cost_promotion_eligible"] = False
            row["authoritative"] = False
            row["authority_reason"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            row["pnl_derivation"] = "execution_reconstructed_from_execution_rows"
            row["promotion_blocker"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            blockers = list(row.get("runtime_ledger_blockers") or [])
            for blocker in bucket_source_materialization_blockers:
                if blocker not in blockers:
                    blockers.append(blocker)
            if isinstance(bucket_payload, Mapping):
                for blocker in runtime_ledger_promotion_source_authority_blockers(
                    bucket_payload
                ):
                    if blocker not in blockers:
                        blockers.append(blocker)
            if "execution_reconstruction_not_runtime_ledger_proof" not in blockers:
                blockers.append("execution_reconstruction_not_runtime_ledger_proof")
            row["runtime_ledger_blockers"] = blockers
            if isinstance(bucket_payload, Mapping):
                bucket_payload = dict(bucket_payload)
                bucket_payload["blockers"] = blockers
                bucket_payload["pnl_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
                bucket_payload["authoritative"] = False
                bucket_payload["authority_reason"] = (
                    "execution_reconstruction_not_runtime_ledger_proof"
                )
                if equity_denominator is not None:
                    bucket_payload["account_equity"] = str(equity_denominator[0])
                    bucket_payload["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = bucket_payload
        realized_rows.append(row)
    return realized_rows


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
