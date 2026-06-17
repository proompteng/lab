"""Torghut API health checks helpers."""

from __future__ import annotations

from typing import Any

from . import health_checks_modules as _health_checks_modules
from .proxy import capture_module_exports

_IMPLEMENTATION_MODULES: tuple[object, ...] = getattr(
    _health_checks_modules,
    "_IMPLEMENTATION_MODULES",
)

_check_postgres: Any = getattr(_health_checks_modules, "_check_postgres")
_check_tigerbeetle_protocol_health: Any = getattr(
    _health_checks_modules, "_check_tigerbeetle_protocol_health"
)
_tigerbeetle_status_int: Any = getattr(
    _health_checks_modules, "_tigerbeetle_status_int"
)
_empty_tigerbeetle_ref_counts: Any = getattr(
    _health_checks_modules, "_empty_tigerbeetle_ref_counts"
)
_latest_reconciliation_ref_counts: Any = getattr(
    _health_checks_modules, "_latest_reconciliation_ref_counts"
)
_unavailable_tigerbeetle_reconciliation_payload: Any = getattr(
    _health_checks_modules, "_unavailable_tigerbeetle_reconciliation_payload"
)
_build_tigerbeetle_ledger_status: Any = getattr(
    _health_checks_modules, "_build_tigerbeetle_ledger_status"
)
_build_control_plane_contract: Any = getattr(
    _health_checks_modules, "_build_control_plane_contract"
)
_active_runtime_revision: Any = getattr(
    _health_checks_modules, "_active_runtime_revision"
)
_build_shadow_first_toggle_parity: Any = getattr(
    _health_checks_modules, "_build_shadow_first_toggle_parity"
)
_resolve_active_capital_stage: Any = getattr(
    _health_checks_modules, "_resolve_active_capital_stage"
)
_build_shadow_first_runtime_payload: Any = getattr(
    _health_checks_modules, "_build_shadow_first_runtime_payload"
)
_check_clickhouse: Any = getattr(_health_checks_modules, "_check_clickhouse")
_forecast_service_status: Any = getattr(
    _health_checks_modules, "_forecast_service_status"
)
_lean_authority_status: Any = getattr(_health_checks_modules, "_lean_authority_status")
_empirical_jobs_status: Any = getattr(_health_checks_modules, "_empirical_jobs_status")
_alpaca_endpoint_class: Any = getattr(_health_checks_modules, "_alpaca_endpoint_class")
_alpaca_failure_status: Any = getattr(_health_checks_modules, "_alpaca_failure_status")
_alpaca_probe_account: Any = getattr(_health_checks_modules, "_alpaca_probe_account")
_remember_alpaca_success: Any = getattr(
    _health_checks_modules, "_remember_alpaca_success"
)
_alpaca_cached_last_good: Any = getattr(
    _health_checks_modules, "_alpaca_cached_last_good"
)
_check_alpaca: Any = getattr(_health_checks_modules, "_check_alpaca")
_tca_row_payload: Any = getattr(_health_checks_modules, "_tca_row_payload")
_load_tca_summary: Any = getattr(_health_checks_modules, "_load_tca_summary")
_load_clickhouse_ta_status: Any = getattr(
    _health_checks_modules, "_load_clickhouse_ta_status"
)
_budget_exhausted_live_submission_gate_payload: Any = getattr(
    _health_checks_modules, "_budget_exhausted_live_submission_gate_payload"
)
_budget_exhausted_options_catalog_freshness_payload: Any = getattr(
    _health_checks_modules, "_budget_exhausted_options_catalog_freshness_payload"
)
_route_claim_symbols: Any = getattr(_health_checks_modules, "_route_claim_symbols")
_load_cached_options_catalog_freshness_summary: Any = getattr(
    _health_checks_modules, "_load_cached_options_catalog_freshness_summary"
)
_store_options_catalog_freshness_summary: Any = getattr(
    _health_checks_modules, "_store_options_catalog_freshness_summary"
)
_decimal_or_none: Any = getattr(_health_checks_modules, "_decimal_or_none")
_sqlalchemy_error_indicates_statement_timeout: Any = getattr(
    _health_checks_modules, "_sqlalchemy_error_indicates_statement_timeout"
)
_load_bounded_options_catalog_freshness_summary: Any = getattr(
    _health_checks_modules, "_load_bounded_options_catalog_freshness_summary"
)
_load_options_catalog_freshness_summary: Any = getattr(
    _health_checks_modules, "_load_options_catalog_freshness_summary"
)
_resolve_tca_scope_symbols: Any = getattr(
    _health_checks_modules, "_resolve_tca_scope_symbols"
)
_ensure_utc_datetime: Any = getattr(_health_checks_modules, "_ensure_utc_datetime")
_load_last_decision_at: Any = getattr(_health_checks_modules, "_load_last_decision_at")
_build_hypothesis_runtime_payload: Any = getattr(
    _health_checks_modules, "_build_hypothesis_runtime_payload"
)
_build_live_submission_gate_payload: Any = getattr(
    _health_checks_modules, "_build_live_submission_gate_payload"
)
_build_simple_lane_status_payload: Any = getattr(
    _health_checks_modules, "_build_simple_lane_status_payload"
)
check_alpaca_dependency = _check_alpaca
check_clickhouse_dependency = _check_clickhouse
check_postgres_dependency = _check_postgres
check_tigerbeetle_protocol_health = _check_tigerbeetle_protocol_health
tigerbeetle_status_int = _tigerbeetle_status_int
empty_tigerbeetle_ref_counts = _empty_tigerbeetle_ref_counts
latest_reconciliation_ref_counts = _latest_reconciliation_ref_counts
unavailable_tigerbeetle_reconciliation_payload = (
    _unavailable_tigerbeetle_reconciliation_payload
)
build_tigerbeetle_ledger_status = _build_tigerbeetle_ledger_status
build_control_plane_contract = _build_control_plane_contract
build_shadow_first_runtime_payload = _build_shadow_first_runtime_payload
check_clickhouse = _check_clickhouse
forecast_service_status = _forecast_service_status
lean_authority_status = _lean_authority_status
empirical_jobs_status = _empirical_jobs_status
load_tca_summary = _load_tca_summary
load_clickhouse_ta_status = _load_clickhouse_ta_status
budget_exhausted_live_submission_gate_payload = (
    _budget_exhausted_live_submission_gate_payload
)
budget_exhausted_options_catalog_freshness_payload = (
    _budget_exhausted_options_catalog_freshness_payload
)
route_claim_symbols = _route_claim_symbols
load_options_catalog_freshness_summary = _load_options_catalog_freshness_summary
sqlalchemy_error_indicates_statement_timeout = (
    _sqlalchemy_error_indicates_statement_timeout
)
load_last_decision_at = _load_last_decision_at
build_hypothesis_runtime_payload = _build_hypothesis_runtime_payload
build_api_live_submission_gate_payload = _build_live_submission_gate_payload
build_simple_lane_status_payload = _build_simple_lane_status_payload

__all__ = (
    "_check_postgres",
    "_check_tigerbeetle_protocol_health",
    "_tigerbeetle_status_int",
    "_empty_tigerbeetle_ref_counts",
    "_latest_reconciliation_ref_counts",
    "_unavailable_tigerbeetle_reconciliation_payload",
    "_build_tigerbeetle_ledger_status",
    "_build_control_plane_contract",
    "_active_runtime_revision",
    "_build_shadow_first_toggle_parity",
    "_resolve_active_capital_stage",
    "_build_shadow_first_runtime_payload",
    "_check_clickhouse",
    "_forecast_service_status",
    "_lean_authority_status",
    "_empirical_jobs_status",
    "_alpaca_endpoint_class",
    "_alpaca_failure_status",
    "_alpaca_probe_account",
    "_remember_alpaca_success",
    "_alpaca_cached_last_good",
    "_check_alpaca",
    "_tca_row_payload",
    "_load_tca_summary",
    "_load_clickhouse_ta_status",
    "_budget_exhausted_live_submission_gate_payload",
    "_budget_exhausted_options_catalog_freshness_payload",
    "_route_claim_symbols",
    "_load_cached_options_catalog_freshness_summary",
    "_store_options_catalog_freshness_summary",
    "_decimal_or_none",
    "_sqlalchemy_error_indicates_statement_timeout",
    "_load_bounded_options_catalog_freshness_summary",
    "_load_options_catalog_freshness_summary",
    "_resolve_tca_scope_symbols",
    "_ensure_utc_datetime",
    "_load_last_decision_at",
    "_build_hypothesis_runtime_payload",
    "_build_live_submission_gate_payload",
    "_build_simple_lane_status_payload",
    "check_alpaca_dependency",
    "check_clickhouse_dependency",
    "check_postgres_dependency",
    "check_tigerbeetle_protocol_health",
    "tigerbeetle_status_int",
    "empty_tigerbeetle_ref_counts",
    "latest_reconciliation_ref_counts",
    "unavailable_tigerbeetle_reconciliation_payload",
    "build_tigerbeetle_ledger_status",
    "build_control_plane_contract",
    "build_shadow_first_runtime_payload",
    "check_clickhouse",
    "forecast_service_status",
    "lean_authority_status",
    "empirical_jobs_status",
    "load_tca_summary",
    "load_clickhouse_ta_status",
    "budget_exhausted_live_submission_gate_payload",
    "budget_exhausted_options_catalog_freshness_payload",
    "route_claim_symbols",
    "load_options_catalog_freshness_summary",
    "sqlalchemy_error_indicates_statement_timeout",
    "load_last_decision_at",
    "build_hypothesis_runtime_payload",
    "build_api_live_submission_gate_payload",
    "build_simple_lane_status_payload",
)

capture_module_exports(globals(), __all__)
