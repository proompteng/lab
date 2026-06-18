"""Explicit exports for Torghut readiness helpers helpers."""

from __future__ import annotations

from typing import Any

from . import shared_context as _dependency_surface
from . import evaluate_trading_health_payload_bounded as _bounded_health
from . import evaluate_trading_health_payload as _trading_health
from . import refresh_universe_state_for_readiness as _database_contract
from . import universe_dependency as _universe_dependency
from ..proxy import capture_module_exports

_IMPLEMENTATION_MODULES: tuple[object, ...] = (
    _dependency_surface,
    _bounded_health,
    _trading_health,
    _database_contract,
    _universe_dependency,
)

_readiness_dependency_cache_key: Any = getattr(
    _dependency_surface, "readiness_dependency_cache_key"
)
_readiness_dependency_checks: Any = getattr(
    _dependency_surface, "readiness_dependency_checks"
)
_readiness_dependency_snapshot: Any = getattr(
    _dependency_surface, "readiness_dependency_snapshot"
)
_readiness_authority_truthy: Any = getattr(
    _dependency_surface, "readiness_authority_truthy"
)
_append_unique_reason: Any = getattr(_dependency_surface, "append_unique_reason")
_readiness_dependency_degradation_reason_codes: Any = getattr(
    _dependency_surface, "readiness_dependency_degradation_reason_codes"
)
_guard_live_submission_gate_for_readiness: Any = getattr(
    _dependency_surface, "guard_live_submission_gate_for_readiness"
)
_strip_promotion_authority_claims_for_readiness: Any = getattr(
    _dependency_surface, "strip_promotion_authority_claims_for_readiness"
)
_core_readiness_live_submission_gate: Any = getattr(
    _dependency_surface, "core_readiness_live_submission_gate"
)
_evaluate_core_readiness_payload: Any = getattr(
    _dependency_surface, "evaluate_core_readiness_payload"
)
_trading_health_surface_cache_key: Any = getattr(
    _dependency_surface, "trading_health_surface_cache_key"
)
_cache_completed_trading_health_surface_payload: Any = getattr(
    _dependency_surface, "cache_completed_trading_health_surface_payload"
)
_record_trading_health_surface_completion: Any = getattr(
    _dependency_surface, "record_trading_health_surface_completion"
)
_cached_trading_health_surface_payload: Any = getattr(
    _dependency_surface, "cached_trading_health_surface_payload"
)
_cached_readiness_dependencies_for_health_surface: Any = getattr(
    _dependency_surface, "cached_readiness_dependencies_for_health_surface"
)
_fail_closed_health_evaluation_gate: Any = getattr(
    _dependency_surface, "fail_closed_health_evaluation_gate"
)
_health_surface_timeout_dependency_placeholder: Any = getattr(
    _dependency_surface, "health_surface_timeout_dependency_placeholder"
)
_minimal_health_surface_timeout_live_submission_gate: Any = getattr(
    _dependency_surface, "minimal_health_surface_timeout_live_submission_gate"
)
_minimal_health_surface_timeout_proof_floor: Any = getattr(
    _dependency_surface, "minimal_health_surface_timeout_proof_floor"
)
_minimal_health_surface_timeout_payload: Any = getattr(
    _dependency_surface, "minimal_health_surface_timeout_payload"
)
_health_surface_timeout_fallback_payload: Any = getattr(
    _dependency_surface, "health_surface_timeout_fallback_payload"
)
_evaluate_trading_health_payload_bounded: Any = getattr(
    _bounded_health, "_evaluate_trading_health_payload_bounded"
)
_evaluate_trading_health_payload: Any = getattr(
    _trading_health, "_evaluate_trading_health_payload"
)
_evaluate_universe_dependency: Any = getattr(
    _universe_dependency, "evaluate_universe_dependency"
)
_refresh_universe_state_for_readiness: Any = getattr(
    _database_contract, "_refresh_universe_state_for_readiness"
)
_resolve_universe_resolver_for_readiness: Any = getattr(
    _database_contract, "_resolve_universe_resolver_for_readiness"
)
_execute_readiness_account_scope_query: Any = getattr(
    _database_contract, "_execute_readiness_account_scope_query"
)
_check_account_scope_invariants_bounded: Any = getattr(
    _database_contract, "_check_account_scope_invariants_bounded"
)
_evaluate_database_contract: Any = getattr(
    _database_contract, "_evaluate_database_contract"
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
