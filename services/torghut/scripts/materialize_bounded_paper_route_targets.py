"""On-demand operator CLI for bounded H-PAIRS paper-route targets in TORGHUT_SIM."""

from __future__ import annotations

import argparse
import time
from collections.abc import Sequence
from http.client import HTTPConnection, HTTPSConnection
from typing import Any

from app.trading.paper_route_target_plan import paper_route_target_plan_targets
from scripts.materialize_bounded_paper_route_targets_modules import (
    dynamic_target_confirmation as _dynamic_target_confirmation,
)
from scripts.materialize_bounded_paper_route_targets_modules import (
    target_materialization_core as _target_materialization_core,
)
from scripts.materialize_bounded_paper_route_targets_modules import (
    ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER,
    ACTIVE_TARGET_WINDOW_SKIP_REASON,
    DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE,
    DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES,
    LIVE_LABEL_MARKERS,
    OPERATOR_CONFIRMATION,
    PROMOTION_FLAG_FIELDS,
    SCHEMA_VERSION,
    TARGET_PLAN_RESPONSE_LIMIT_BYTES,
    _account_label_blockers,
    _active_target_window_check,
    _base_confirmations,
    _candidate_materialization_plans,
    _confirmation_blockers,
    _confirmation_pair_blockers,
    _confirmed_dynamic_target_filters,
    _confirmed_dynamic_target_indexes,
    _confirmed_selected_plan_sources,
    _copy_preview_strategies,
    _decimal_text,
    _dynamic_target_confirmation_blockers,
    _exact_target_confirmations,
    _fetch_plan_url_payload,
    _fetch_plan_url_payload_once,
    _first_positive_decimal,
    _joined_summary_values,
    _json_default,
    _load_json_file,
    _load_plan,
    _materialization_plan_from_payload,
    _nested_mapping,
    _parse_args,
    _parse_utc_datetime,
    _plan_flag_blockers,
    _plan_materialization_score,
    _plan_with_target_indexes,
    _request_flag_blockers,
    _request_safety_blockers,
    _resolve_now_utc,
    _run_dry_run_materialization,
    _run_materialization,
    _runtime_strategy_confirmation_matches,
    _runtime_strategy_confirmation_names,
    _safe_decimal,
    _safe_text,
    _safety_blockers,
    _session_factory,
    _sqlalchemy_dsn,
    _strategy_names_from_summaries,
    _summary_dynamic_target_filter_matches,
    _summary_matches_dynamic_target_filters,
    _target_account_blockers,
    _target_authorization_blockers,
    _target_bounded_materialization_authorized,
    _target_capacity_blockers,
    _target_materialization_score,
    _target_notional,
    _target_notional_blockers,
    _target_plan_ref,
    _target_quantity,
    _target_required_field_blockers,
    _target_runtime_strategy_confirmation_names,
    _target_summaries,
    _target_summary_safety_blockers,
    _target_symbol_actions,
    _target_symbol_quantities,
    _target_window_check_active_indexes,
    _target_window_end,
    _target_window_start,
    _to_str_map,
    _truthy,
    _unique_texts,
    build_report,
    main,
)

_ORIGINAL_FETCH_PLAN_URL_PAYLOAD = _fetch_plan_url_payload
_ORIGINAL_FETCH_PLAN_URL_PAYLOAD_ONCE = _fetch_plan_url_payload_once
_ORIGINAL_BUILD_REPORT = build_report
_ORIGINAL_MAIN = main


def _sync_patch_targets() -> None:
    _target_materialization_core.HTTPConnection = HTTPConnection
    _target_materialization_core.HTTPSConnection = HTTPSConnection
    _target_materialization_core.TARGET_PLAN_RESPONSE_LIMIT_BYTES = (
        TARGET_PLAN_RESPONSE_LIMIT_BYTES
    )
    _target_materialization_core.paper_route_target_plan_targets = (
        paper_route_target_plan_targets
    )
    _target_materialization_core.time = time
    _target_materialization_core._fetch_plan_url_payload = _fetch_plan_url_payload
    _target_materialization_core._fetch_plan_url_payload_once = (
        _fetch_plan_url_payload_once
    )
    _dynamic_target_confirmation.build_report = build_report
    _dynamic_target_confirmation.paper_route_target_plan_targets = (
        paper_route_target_plan_targets
    )


def _fetch_plan_url_payload_once(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    _sync_patch_targets()
    return _ORIGINAL_FETCH_PLAN_URL_PAYLOAD_ONCE(url, timeout_seconds=timeout_seconds)


def _fetch_plan_url_payload(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    _sync_patch_targets()
    return _ORIGINAL_FETCH_PLAN_URL_PAYLOAD(
        url,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        retry_backoff_seconds=retry_backoff_seconds,
    )


def build_report(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    _sync_patch_targets()
    return _ORIGINAL_BUILD_REPORT(args)


def main(argv: Sequence[str] | None = None) -> int:
    _sync_patch_targets()
    return _ORIGINAL_MAIN(argv)


__all__ = (
    "ACTIVE_TARGET_WINDOW_REQUIRED_BLOCKER",
    "ACTIVE_TARGET_WINDOW_SKIP_REASON",
    "DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCE",
    "DEFAULT_DYNAMIC_SELECTED_PLAN_SOURCES",
    "LIVE_LABEL_MARKERS",
    "OPERATOR_CONFIRMATION",
    "PROMOTION_FLAG_FIELDS",
    "SCHEMA_VERSION",
    "TARGET_PLAN_RESPONSE_LIMIT_BYTES",
    "HTTPConnection",
    "HTTPSConnection",
    "_account_label_blockers",
    "_active_target_window_check",
    "_base_confirmations",
    "_candidate_materialization_plans",
    "_confirmation_blockers",
    "_confirmation_pair_blockers",
    "_confirmed_dynamic_target_filters",
    "_confirmed_dynamic_target_indexes",
    "_confirmed_selected_plan_sources",
    "_copy_preview_strategies",
    "_decimal_text",
    "_dynamic_target_confirmation_blockers",
    "_exact_target_confirmations",
    "_fetch_plan_url_payload",
    "_fetch_plan_url_payload_once",
    "_first_positive_decimal",
    "_joined_summary_values",
    "_json_default",
    "_load_json_file",
    "_load_plan",
    "_materialization_plan_from_payload",
    "_nested_mapping",
    "_parse_args",
    "_parse_utc_datetime",
    "_plan_flag_blockers",
    "_plan_materialization_score",
    "_plan_with_target_indexes",
    "_request_flag_blockers",
    "_request_safety_blockers",
    "_resolve_now_utc",
    "_run_dry_run_materialization",
    "_run_materialization",
    "_runtime_strategy_confirmation_matches",
    "_runtime_strategy_confirmation_names",
    "_safe_decimal",
    "_safe_text",
    "_safety_blockers",
    "_session_factory",
    "_sqlalchemy_dsn",
    "_strategy_names_from_summaries",
    "_summary_dynamic_target_filter_matches",
    "_summary_matches_dynamic_target_filters",
    "_target_account_blockers",
    "_target_authorization_blockers",
    "_target_bounded_materialization_authorized",
    "_target_capacity_blockers",
    "_target_materialization_score",
    "_target_notional",
    "_target_notional_blockers",
    "_target_plan_ref",
    "_target_quantity",
    "_target_required_field_blockers",
    "_target_runtime_strategy_confirmation_names",
    "_target_summaries",
    "_target_summary_safety_blockers",
    "_target_symbol_actions",
    "_target_symbol_quantities",
    "_target_window_check_active_indexes",
    "_target_window_end",
    "_target_window_start",
    "_to_str_map",
    "_truthy",
    "_unique_texts",
    "build_report",
    "main",
    "paper_route_target_plan_targets",
    "time",
)

if __name__ == "__main__":
    raise SystemExit(main())
