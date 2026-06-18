"""Shared imports and runtime state for Torghut API modules."""

import json
import logging
import os
import sys
import time
from collections.abc import Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from threading import Lock
from typing import Any, cast
from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
import inngest
from inngest.fast_api import serve as inngest_fastapi_serve
from sqlalchemy import bindparam, func, select, text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session
from urllib.parse import urlencode, urlsplit

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from ..db import SessionLocal, check_schema_current, ensure_schema, get_session, ping
from ..metrics import render_trading_metrics
from ..models import (
    Execution,
    ExecutionTCAMetric,
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
)
from ..observability import capture_posthog_event, shutdown_posthog_telemetry
from ..trading.alpha_closure_dividend_slo import build_alpha_closure_dividend_slo
from ..trading.alpha_evidence_foundry import compact_alpha_evidence_foundry
from ..trading.alpha_readiness_settlement_conveyor import (
    compact_alpha_readiness_settlement_conveyor,
)
from ..trading.alpha_repair_dividend_ledger import (
    compact_alpha_repair_dividend_ledger,
)
from ..trading.alpha_repair_closure_board import compact_alpha_repair_closure_board
from ..trading.autonomy import (
    assert_runtime_gate_policy_contract,
    evaluate_evidence_continuity,
)
from ..trading.autoresearch_routes import router as autoresearch_router
from ..trading.capital_reentry_cohorts import build_capital_reentry_cohort_ledger
from ..trading.completion import build_doc29_completion_status
from ..trading.consumer_evidence import (
    build_route_proven_profit_receipt,
    build_torghut_consumer_evidence_receipt,
)
from ..trading.clock_settlement import build_clock_settlement_receipt
from ..trading.empirical_jobs import build_empirical_jobs_status
from ..trading.evidence_clock_arbiter import (
    build_evidence_clock_arbiter_and_exchange,
)
from ..trading.evidence_epochs import (
    EvidenceEpoch,
    compile_evidence_epoch,
    load_evidence_epoch_payload,
    load_latest_evidence_epoch_payload,
    persist_evidence_epoch,
)
from ..trading.evidence_receipts import (
    EvidenceReceipt,
    build_artifact_parity_receipt,
    build_data_freshness_receipt,
    build_empirical_jobs_receipt,
    build_jangar_authority_receipt,
    build_portfolio_proof_receipt,
    build_schema_receipt,
    build_service_health_receipt,
)
from ..trading.executable_alpha_receipts import (
    build_capital_replay_projection,
    compact_executable_alpha_settlement_slots,
)
from ..trading.feature_quality import (
    FeatureQualityThresholds,
    evaluate_feature_batch_quality,
)
from ..trading.forecast_runtime import forecast_status_from_empirical_jobs
from ..trading.freshness_carry import build_freshness_carry_ledger
from ..trading.hypotheses import (
    JangarDependencyQuorumStatus,
    hypothesis_registry_requires_dependency_capability,
    load_jangar_dependency_quorum,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
    validate_hypothesis_registry_from_settings,
)
from ..trading.jangar_continuity import load_jangar_route_continuity_packet
from ..trading.jangar_controller_ingestion_carry import (
    compact_jangar_controller_ingestion_carry,
)
from ..trading.lean_lanes import LeanLaneManager
from ..trading.lean_runtime import lean_authority_status
from ..trading.llm.evaluation import build_llm_evaluation_metrics
from ..trading.no_delta_repair_reentry_auction import (
    compact_no_delta_repair_reentry_auction,
)
from ..trading.profit_carry_passports import build_profit_carry_passport_ledger
from ..trading.profit_freshness_frontier import build_profit_freshness_frontier
from ..trading.profit_repair_settlement import build_profit_repair_settlement_ledger
from ..trading.profit_signal_quorum import build_profit_signal_quorum
from ..trading.paper_route_target_plan import (
    mapping_items as _shared_mapping_items,
    paper_route_target_plan_from_payload as _shared_paper_route_target_plan_from_payload,
)
from ..trading.paper_route_evidence import (
    DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS,
    MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT,
    PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL,
)
from ..trading.proofs.service import build_proofs_payload
from ..trading.proofs.schemas import ProofKind, ProofWindowSelector
from ..trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
)
from ..trading.runtime_ledger_source_authority import (
    build_runtime_ledger_profit_distance_readback,
    runtime_ledger_promotion_source_authority_blockers,
)
from ..trading.proof_floor import build_profitability_proof_floor_receipt
from ..trading.quality_adjusted_profit_frontier import (
    build_quality_adjusted_profit_frontier,
)
from ..trading.renewal_bond_profit_escrow import build_renewal_bond_profit_escrow
from ..trading.revenue_repair import build_revenue_repair_digest
from ..trading.repair_bid_settlement import build_repair_bid_settlement_ledger
from ..trading.repair_outcome_dividend import (
    build_repair_outcome_dividend_ledger,
)
from ..trading.repair_receipt_frontier import build_repair_receipt_frontier
from ..trading.route_evidence_clearinghouse import (
    build_route_evidence_clearinghouse_packet,
)
from ..trading.route_warrant_exchange import build_route_warrant_exchange
from ..trading.routeability_repair_acceptance import (
    build_routeability_repair_acceptance_ledger,
)
from ..trading.route_reacquisition_board import build_route_reacquisition_board
from ..trading.scheduler import TradingScheduler
from ..trading.source_serving_repair_receipt import (
    build_source_serving_repair_receipt_ledger,
)
from ..trading.submission_council import (
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    build_shadow_first_toggle_parity,
    load_quant_evidence_status,
    resolve_active_capital_stage,
)
from ..trading.ingest import ClickHouseSignalIngestor
from ..trading.models import SignalEnvelope
from ..trading.tca import build_tca_gate_inputs, refresh_execution_tca_metrics
from ..trading.simulation_progress import (
    active_simulation_runtime_context,
    simulation_progress_snapshot,
)
from ..trading.time_source import trading_time_status
from ..trading.tigerbeetle_client import check_tigerbeetle_health
from ..trading.tigerbeetle_reconcile import (
    BLOCKER_RECONCILIATION_STALE,
    latest_tigerbeetle_reconciliation_payload,
    latest_tigerbeetle_reconciliation_status_payload,
    tigerbeetle_ref_counts,
)
from ..trading.zero_notional_repair_executor import run_zero_notional_repair
from ..whitepapers import (
    WhitepaperKafkaWorker,
    WhitepaperWorkflowService,
    whitepaper_inngest_enabled,
    whitepaper_kafka_enabled,
    whitepaper_semantic_indexing_enabled,
    whitepaper_workflow_enabled,
)

logger = logging.getLogger(__name__)

BUILD_VERSION = os.getenv("TORGHUT_VERSION", "dev")
BUILD_COMMIT = os.getenv("TORGHUT_COMMIT", "unknown")
BUILD_IMAGE_DIGEST = os.getenv("TORGHUT_IMAGE_DIGEST", "").strip() or None
BUILD_SOURCE_CI_REF = os.getenv("TORGHUT_SOURCE_CI_REF", "").strip() or None
BUILD_MANIFEST_COMMIT = os.getenv("TORGHUT_MANIFEST_COMMIT", "").strip() or None
BUILD_MANIFEST_IMAGE_DIGEST = (
    os.getenv("TORGHUT_MANIFEST_IMAGE_DIGEST", "").strip() or BUILD_IMAGE_DIGEST
)
BUILD_ARGO_SYNC_REVISION = os.getenv("TORGHUT_ARGO_SYNC_REVISION", "").strip() or None
BUILD_ARGO_HEALTH = os.getenv("TORGHUT_ARGO_HEALTH", "").strip() or None
RUNTIME_PROFITABILITY_LOOKBACK_HOURS = 72
RUNTIME_PROFITABILITY_SCHEMA_VERSION = "torghut.runtime-profitability.v1"
PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS = 86_400
CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE = (
    "Jangar dependency quorum is evaluated by the calling control plane; "
    "Torghut omits the recursive control-plane status fetch for consumer evidence."
)
LEAN_LANE_MANAGER = LeanLaneManager()
WHITEPAPER_WORKFLOW = WhitepaperWorkflowService()
TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = Lock()
TRADING_DEPENDENCY_HEALTH_CACHE: dict[str, dict[str, object]] = {}
TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 3.0
TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="torghut-health-surface",
)
TRADING_HEALTH_SURFACE_EVALUATION_LOCK = Lock()
_ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = 3
RETRYABLE_TCA_RECOMPUTE_SQLSTATES = frozenset({"40P01", "40001"})


def _retryable_tca_recompute_error(exc: BaseException) -> bool:
    if not isinstance(exc, OperationalError):
        return False
    original = getattr(exc, "orig", None)
    sqlstate = str(getattr(original, "sqlstate", "") or "") or str(
        getattr(original, "pgcode", "") or ""
    )
    if sqlstate in RETRYABLE_TCA_RECOMPUTE_SQLSTATES:
        return True
    message = str(exc).lower()
    return "deadlock detected" in message or "serialization failure" in message


retryable_tca_recompute_error = _retryable_tca_recompute_error
TRADING_HEALTH_SURFACE_EVALUATIONS: dict[
    str,
    Future[tuple[dict[str, object], int]],
] = {}
TRADING_HEALTH_SURFACE_PAYLOAD_CACHE: dict[str, dict[str, object]] = {}
OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = Lock()
OPTIONS_CATALOG_FRESHNESS_CACHE: dict[
    tuple[str, ...], tuple[datetime, dict[str, object]]
] = {}
_TRADING_STATUS_READ_BUDGET_SECONDS = 12.0
ALPACA_HEALTH_CACHE_LOCK = Lock()
ALPACA_HEALTH_STATE: dict[str, object] = {}
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = 600
_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = Lock()
_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"
paper_route_target_plan_success_cache: tuple[dict[str, Any], float] | None = None
ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = _ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS
TRADING_STATUS_READ_BUDGET_SECONDS = _TRADING_STATUS_READ_BUDGET_SECONDS
PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = (
    _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS
)
PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK
PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = (
    _PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL
)
shared_mapping_items = _shared_mapping_items
shared_paper_route_target_plan_from_payload = (
    _shared_paper_route_target_plan_from_payload
)
READINESS_PROMOTION_AUTHORITY_KEYS = frozenset(
    {
        "promotion_authority",
        "promotion_authority_ok",
        "promotion_allowed",
        "final_authority_ok",
        "final_promotion_allowed",
        "final_promotion_authorized",
    }
)
ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS = 150
SIMPLE_LANE_ALLOWED_REJECT_REASONS = {
    "kill_switch_enabled",
    "invalid_qty_increment",
    "qty_below_min_after_clamp",
    "insufficient_buying_power",
    "equity_required_for_exposure_increase",
    "max_notional_exceeded",
    "max_gross_exposure_exceeded",
    "max_symbol_exposure_exceeded",
    "shorting_not_allowed_for_asset",
    "broker_precheck_failed",
    "broker_submit_failed",
}


def main_runtime_value(name: str, default: object | None = None) -> Any:
    return globals().get(name, default)


__all__ = (
    "logger",
    "BUILD_VERSION",
    "BUILD_COMMIT",
    "BUILD_IMAGE_DIGEST",
    "BUILD_SOURCE_CI_REF",
    "BUILD_MANIFEST_COMMIT",
    "BUILD_MANIFEST_IMAGE_DIGEST",
    "BUILD_ARGO_SYNC_REVISION",
    "BUILD_ARGO_HEALTH",
    "RUNTIME_PROFITABILITY_LOOKBACK_HOURS",
    "RUNTIME_PROFITABILITY_SCHEMA_VERSION",
    "PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS",
    "CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE",
    "LEAN_LANE_MANAGER",
    "WHITEPAPER_WORKFLOW",
    "retryable_tca_recompute_error",
    "ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "TRADING_STATUS_READ_BUDGET_SECONDS",
    "PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "shared_mapping_items",
    "shared_paper_route_target_plan_from_payload",
    "main_runtime_value",
)


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "Any",
    "BLOCKER_RECONCILIATION_STALE",
    "BUILD_ARGO_HEALTH",
    "BUILD_ARGO_SYNC_REVISION",
    "BUILD_COMMIT",
    "BUILD_IMAGE_DIGEST",
    "BUILD_MANIFEST_COMMIT",
    "BUILD_MANIFEST_IMAGE_DIGEST",
    "BUILD_SOURCE_CI_REF",
    "BUILD_VERSION",
    "Body",
    "CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE",
    "ClickHouseSignalIngestor",
    "DEFAULT_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "DEFAULT_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT",
    "Decimal",
    "Depends",
    "EvidenceEpoch",
    "EvidenceReceipt",
    "Execution",
    "ExecutionTCAMetric",
    "FastAPI",
    "FeatureQualityThresholds",
    "Future",
    "HTTPConnection",
    "HTTPException",
    "HTTPSConnection",
    "JSONResponse",
    "JangarDependencyQuorumStatus",
    "LEAN_LANE_MANAGER",
    "LeanLaneManager",
    "Lock",
    "MAX_PAPER_ROUTE_EVIDENCE_LOOKBACK_HOURS",
    "MAX_PAPER_ROUTE_EVIDENCE_TARGET_LIMIT",
    "Mapping",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "OperationalError",
    "PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "PAPER_ROUTE_RUNTIME_ACCOUNT_LABEL",
    "PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS",
    "Path",
    "ProofKind",
    "ProofWindowSelector",
    "Query",
    "READINESS_PROMOTION_AUTHORITY_KEYS",
    "RETRYABLE_TCA_RECOMPUTE_SQLSTATES",
    "RUNTIME_PROFITABILITY_LOOKBACK_HOURS",
    "RUNTIME_PROFITABILITY_SCHEMA_VERSION",
    "RejectedSignalOutcomeEvent",
    "Request",
    "Response",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "SQLAlchemyError",
    "Sequence",
    "Session",
    "SessionLocal",
    "SignalEnvelope",
    "Strategy",
    "StrategyRuntimeLedgerBucket",
    "TRADING_DEPENDENCY_HEALTH_CACHE",
    "TRADING_DEPENDENCY_HEALTH_CACHE_LOCK",
    "TRADING_HEALTH_SURFACE_EVALUATIONS",
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "TRADING_STATUS_READ_BUDGET_SECONDS",
    "ThreadPoolExecutor",
    "TimeoutError",
    "TorghutAlpacaClient",
    "TradeDecision",
    "TradingScheduler",
    "VNextDatasetSnapshot",
    "VNextExperimentRun",
    "VNextExperimentSpec",
    "VNextFeatureViewSpec",
    "VNextModelArtifact",
    "VNextPromotionDecision",
    "VNextShadowLiveDeviation",
    "VNextSimulationCalibration",
    "WHITEPAPER_WORKFLOW",
    "WhitepaperAnalysisRun",
    "WhitepaperCodexAgentRun",
    "WhitepaperDesignPullRequest",
    "WhitepaperEngineeringTrigger",
    "WhitepaperKafkaWorker",
    "WhitepaperRolloutTransition",
    "WhitepaperWorkflowService",
    "ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "READINESS_PROMOTION_AUTHORITY_KEYS",
    "RETRYABLE_TCA_RECOMPUTE_SQLSTATES",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "TRADING_DEPENDENCY_HEALTH_CACHE",
    "TRADING_DEPENDENCY_HEALTH_CACHE_LOCK",
    "TRADING_HEALTH_SURFACE_EVALUATIONS",
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "_TRADING_STATUS_READ_BUDGET_SECONDS",
    "_ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "paper_route_target_plan_success_cache",
    "_retryable_tca_recompute_error",
    "_shared_mapping_items",
    "_shared_paper_route_target_plan_from_payload",
    "active_simulation_runtime_context",
    "assert_runtime_gate_policy_contract",
    "asynccontextmanager",
    "autoresearch_router",
    "bindparam",
    "build_alpha_closure_dividend_slo",
    "build_artifact_parity_receipt",
    "build_capital_reentry_cohort_ledger",
    "build_capital_replay_projection",
    "build_clock_settlement_receipt",
    "build_data_freshness_receipt",
    "build_doc29_completion_status",
    "build_empirical_jobs_receipt",
    "build_empirical_jobs_status",
    "build_evidence_clock_arbiter_and_exchange",
    "build_freshness_carry_ledger",
    "build_hypothesis_runtime_summary",
    "build_jangar_authority_receipt",
    "build_live_submission_gate_payload",
    "build_llm_evaluation_metrics",
    "build_portfolio_proof_receipt",
    "build_profit_carry_passport_ledger",
    "build_profit_freshness_frontier",
    "build_profit_repair_settlement_ledger",
    "build_profit_signal_quorum",
    "build_profitability_proof_floor_receipt",
    "build_proofs_payload",
    "build_quality_adjusted_profit_frontier",
    "build_renewal_bond_profit_escrow",
    "build_repair_bid_settlement_ledger",
    "build_repair_outcome_dividend_ledger",
    "build_repair_receipt_frontier",
    "build_revenue_repair_digest",
    "build_route_evidence_clearinghouse_packet",
    "build_route_proven_profit_receipt",
    "build_route_reacquisition_board",
    "build_route_warrant_exchange",
    "build_routeability_repair_acceptance_ledger",
    "build_runtime_ledger_profit_distance_readback",
    "build_schema_receipt",
    "build_service_health_receipt",
    "build_shadow_first_toggle_parity",
    "build_source_serving_repair_receipt_ledger",
    "build_tca_gate_inputs",
    "build_torghut_consumer_evidence_receipt",
    "capture_posthog_event",
    "cast",
    "check_schema_current",
    "check_tigerbeetle_health",
    "compact_alpha_evidence_foundry",
    "compact_alpha_readiness_settlement_conveyor",
    "compact_alpha_repair_closure_board",
    "compact_alpha_repair_dividend_ledger",
    "compact_executable_alpha_settlement_slots",
    "compact_jangar_controller_ingestion_carry",
    "compact_no_delta_repair_reentry_auction",
    "compile_evidence_epoch",
    "cost_basis_counts_have_non_promotion_grade_costs",
    "datetime",
    "deepcopy",
    "ensure_schema",
    "evaluate_evidence_continuity",
    "evaluate_feature_batch_quality",
    "forecast_status_from_empirical_jobs",
    "func",
    "get_session",
    "hypothesis_registry_requires_dependency_capability",
    "inngest",
    "inngest_fastapi_serve",
    "json",
    "jsonable_encoder",
    "latest_tigerbeetle_reconciliation_payload",
    "latest_tigerbeetle_reconciliation_status_payload",
    "lean_authority_status",
    "load_evidence_epoch_payload",
    "load_hypothesis_registry",
    "load_jangar_dependency_quorum",
    "load_jangar_route_continuity_packet",
    "load_latest_evidence_epoch_payload",
    "load_quant_evidence_status",
    "logger",
    "logging",
    "main_runtime_value",
    "os",
    "paper_route_target_plan_success_cache",
    "persist_evidence_epoch",
    "ping",
    "refresh_execution_tca_metrics",
    "render_trading_metrics",
    "resolve_active_capital_stage",
    "resolve_hypothesis_dependency_quorum",
    "retryable_tca_recompute_error",
    "run_zero_notional_repair",
    "runtime_ledger_promotion_source_authority_blockers",
    "select",
    "settings",
    "shared_mapping_items",
    "shared_paper_route_target_plan_from_payload",
    "shutdown_posthog_telemetry",
    "simulation_progress_snapshot",
    "sys",
    "text",
    "tigerbeetle_ref_counts",
    "time",
    "timedelta",
    "timezone",
    "trading_time_status",
    "urlencode",
    "urlsplit",
    "validate_hypothesis_registry_from_settings",
    "whitepaper_inngest_enabled",
    "whitepaper_kafka_enabled",
    "whitepaper_semantic_indexing_enabled",
    "whitepaper_workflow_enabled",
)
