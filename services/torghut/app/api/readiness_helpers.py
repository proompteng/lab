"""Torghut API readiness helpers helpers."""

from __future__ import annotations

from typing import Any

from . import readiness_helpers_modules as _readiness_helpers_modules
from .proxy import capture_module_exports

_IMPLEMENTATION_MODULES: tuple[object, ...] = getattr(
    _readiness_helpers_modules,
    "_IMPLEMENTATION_MODULES",
)

_readiness_dependency_cache_key: Any = getattr(
    _readiness_helpers_modules, "_readiness_dependency_cache_key"
)
_readiness_dependency_checks: Any = getattr(
    _readiness_helpers_modules, "_readiness_dependency_checks"
)
_readiness_dependency_snapshot: Any = getattr(
    _readiness_helpers_modules, "_readiness_dependency_snapshot"
)
_readiness_authority_truthy: Any = getattr(
    _readiness_helpers_modules, "_readiness_authority_truthy"
)
_append_unique_reason: Any = getattr(
    _readiness_helpers_modules, "_append_unique_reason"
)
_readiness_dependency_degradation_reason_codes: Any = getattr(
    _readiness_helpers_modules, "_readiness_dependency_degradation_reason_codes"
)
_guard_live_submission_gate_for_readiness: Any = getattr(
    _readiness_helpers_modules, "_guard_live_submission_gate_for_readiness"
)
_strip_promotion_authority_claims_for_readiness: Any = getattr(
    _readiness_helpers_modules, "_strip_promotion_authority_claims_for_readiness"
)
_core_readiness_live_submission_gate: Any = getattr(
    _readiness_helpers_modules, "_core_readiness_live_submission_gate"
)
_evaluate_core_readiness_payload: Any = getattr(
    _readiness_helpers_modules, "_evaluate_core_readiness_payload"
)
_trading_health_surface_cache_key: Any = getattr(
    _readiness_helpers_modules, "_trading_health_surface_cache_key"
)
_cache_completed_trading_health_surface_payload: Any = getattr(
    _readiness_helpers_modules, "_cache_completed_trading_health_surface_payload"
)
_record_trading_health_surface_completion: Any = getattr(
    _readiness_helpers_modules, "_record_trading_health_surface_completion"
)
_cached_trading_health_surface_payload: Any = getattr(
    _readiness_helpers_modules, "_cached_trading_health_surface_payload"
)
_cached_readiness_dependencies_for_health_surface: Any = getattr(
    _readiness_helpers_modules, "_cached_readiness_dependencies_for_health_surface"
)
_fail_closed_health_evaluation_gate: Any = getattr(
    _readiness_helpers_modules, "_fail_closed_health_evaluation_gate"
)
_health_surface_timeout_dependency_placeholder: Any = getattr(
    _readiness_helpers_modules, "_health_surface_timeout_dependency_placeholder"
)
_minimal_health_surface_timeout_live_submission_gate: Any = getattr(
    _readiness_helpers_modules, "_minimal_health_surface_timeout_live_submission_gate"
)
_minimal_health_surface_timeout_proof_floor: Any = getattr(
    _readiness_helpers_modules, "_minimal_health_surface_timeout_proof_floor"
)
_minimal_health_surface_timeout_payload: Any = getattr(
    _readiness_helpers_modules, "_minimal_health_surface_timeout_payload"
)
_health_surface_timeout_fallback_payload: Any = getattr(
    _readiness_helpers_modules, "_health_surface_timeout_fallback_payload"
)
_evaluate_trading_health_payload_bounded: Any = getattr(
    _readiness_helpers_modules, "_evaluate_trading_health_payload_bounded"
)
_evaluate_trading_health_payload: Any = getattr(
    _readiness_helpers_modules, "_evaluate_trading_health_payload"
)
_evaluate_universe_dependency: Any = getattr(
    _readiness_helpers_modules, "_evaluate_universe_dependency"
)
_refresh_universe_state_for_readiness: Any = getattr(
    _readiness_helpers_modules, "_refresh_universe_state_for_readiness"
)
_resolve_universe_resolver_for_readiness: Any = getattr(
    _readiness_helpers_modules, "_resolve_universe_resolver_for_readiness"
)
_execute_readiness_account_scope_query: Any = getattr(
    _readiness_helpers_modules, "_execute_readiness_account_scope_query"
)
_check_account_scope_invariants_bounded: Any = getattr(
    _readiness_helpers_modules, "_check_account_scope_invariants_bounded"
)
_evaluate_database_contract: Any = getattr(
    _readiness_helpers_modules, "_evaluate_database_contract"
)
evaluate_core_readiness_payload = _evaluate_core_readiness_payload
evaluate_trading_health_payload_bounded = _evaluate_trading_health_payload_bounded
evaluate_trading_health_payload = _evaluate_trading_health_payload
evaluate_database_contract = _evaluate_database_contract
readiness_dependency_snapshot = _readiness_dependency_snapshot
resolve_universe_resolver_for_readiness = _resolve_universe_resolver_for_readiness

__all__ = (
    "_readiness_dependency_cache_key",
    "_readiness_dependency_checks",
    "_readiness_dependency_snapshot",
    "_readiness_authority_truthy",
    "_append_unique_reason",
    "_readiness_dependency_degradation_reason_codes",
    "_guard_live_submission_gate_for_readiness",
    "_strip_promotion_authority_claims_for_readiness",
    "_core_readiness_live_submission_gate",
    "_evaluate_core_readiness_payload",
    "_trading_health_surface_cache_key",
    "_cache_completed_trading_health_surface_payload",
    "_record_trading_health_surface_completion",
    "_cached_trading_health_surface_payload",
    "_cached_readiness_dependencies_for_health_surface",
    "_fail_closed_health_evaluation_gate",
    "_health_surface_timeout_dependency_placeholder",
    "_minimal_health_surface_timeout_live_submission_gate",
    "_minimal_health_surface_timeout_proof_floor",
    "_minimal_health_surface_timeout_payload",
    "_health_surface_timeout_fallback_payload",
    "_evaluate_trading_health_payload_bounded",
    "_evaluate_trading_health_payload",
    "_evaluate_universe_dependency",
    "_refresh_universe_state_for_readiness",
    "_resolve_universe_resolver_for_readiness",
    "_execute_readiness_account_scope_query",
    "_check_account_scope_invariants_bounded",
    "_evaluate_database_contract",
    "evaluate_core_readiness_payload",
    "evaluate_trading_health_payload_bounded",
    "evaluate_trading_health_payload",
    "evaluate_database_contract",
    "readiness_dependency_snapshot",
    "resolve_universe_resolver_for_readiness",
)

capture_module_exports(globals(), __all__)
