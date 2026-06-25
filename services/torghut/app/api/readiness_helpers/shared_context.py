"""Extracted Torghut API route and support functions."""

from __future__ import annotations




from ..common import (
    ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS,
    BUILD_IMAGE_DIGEST,
    BUILD_VERSION,
    Future,
    JangarDependencyQuorumStatus,
    Mapping,
    SQLAlchemyError,
    Sequence,
    SessionLocal,
    TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR,
    TRADING_HEALTH_SURFACE_EVALUATION_LOCK,
    TRADING_HEALTH_SURFACE_EVALUATIONS,
    TRADING_HEALTH_SURFACE_PAYLOAD_CACHE,
    TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS,
    TimeoutError,
    TradingScheduler,
    active_simulation_runtime_context,
    bindparam,
    build_alpha_closure_dividend_slo,
    build_revenue_repair_digest,
    cast,
    check_schema_current,
    compact_alpha_evidence_foundry,
    compact_alpha_readiness_settlement_conveyor,
    compact_alpha_repair_closure_board,
    compact_alpha_repair_dividend_ledger,
    compact_executable_alpha_settlement_slots,
    compact_jangar_controller_ingestion_carry,
    compact_no_delta_repair_reentry_auction,
    datetime,
    deepcopy,
    load_quant_evidence_status,
    logger,
    settings,
    text,
    timezone,
)

from ..common import main_runtime_value



from .readiness_surface import (
    cache_completed_trading_health_surface_payload,
    evaluate_core_readiness_payload,
    guard_live_submission_gate_for_readiness,
    health_surface_timeout_fallback_payload,
    minimal_health_surface_timeout_payload,
    readiness_dependency_degradation_reason_codes,
    readiness_dependency_snapshot,
    record_trading_health_surface_completion,
    strip_promotion_authority_claims_for_readiness,
    trading_health_surface_cache_key,
)

_evaluate_core_readiness_payload = evaluate_core_readiness_payload
_minimal_health_surface_timeout_payload = minimal_health_surface_timeout_payload


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
    "BUILD_IMAGE_DIGEST",
    "BUILD_VERSION",
    "Future",
    "JangarDependencyQuorumStatus",
    "Mapping",
    "SQLAlchemyError",
    "Sequence",
    "SessionLocal",
    "TRADING_HEALTH_SURFACE_EVALUATIONS",
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "TimeoutError",
    "TradingScheduler",
    "active_simulation_runtime_context",
    "bindparam",
    "build_alpha_closure_dividend_slo",
    "build_revenue_repair_digest",
    "cache_completed_trading_health_surface_payload",
    "cast",
    "check_schema_current",
    "compact_alpha_evidence_foundry",
    "compact_alpha_readiness_settlement_conveyor",
    "compact_alpha_repair_closure_board",
    "compact_alpha_repair_dividend_ledger",
    "compact_executable_alpha_settlement_slots",
    "compact_jangar_controller_ingestion_carry",
    "compact_no_delta_repair_reentry_auction",
    "datetime",
    "deepcopy",
    "guard_live_submission_gate_for_readiness",
    "health_surface_timeout_fallback_payload",
    "load_quant_evidence_status",
    "logger",
    "main_runtime_value",
    "readiness_dependency_degradation_reason_codes",
    "readiness_dependency_snapshot",
    "record_trading_health_surface_completion",
    "settings",
    "strip_promotion_authority_claims_for_readiness",
    "text",
    "timezone",
    "trading_health_surface_cache_key",
)
