"""Shared imports and runtime state for Torghut API modules."""

# pyright: reportUnusedImport=false, reportUnusedFunction=false, reportUnsupportedDunderAll=false
# ruff: noqa: F401

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
from ..trading import TradingScheduler
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
_TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = Lock()
_TRADING_DEPENDENCY_HEALTH_CACHE: dict[str, dict[str, object]] = {}
_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 3.0
_TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="torghut-health-surface",
)
_TRADING_HEALTH_SURFACE_EVALUATION_LOCK = Lock()
_ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = 3
_RETRYABLE_TCA_RECOMPUTE_SQLSTATES = frozenset({"40P01", "40001"})


def _retryable_tca_recompute_error(exc: BaseException) -> bool:
    if not isinstance(exc, OperationalError):
        return False
    original = getattr(exc, "orig", None)
    sqlstate = str(getattr(original, "sqlstate", "") or "") or str(
        getattr(original, "pgcode", "") or ""
    )
    if sqlstate in _RETRYABLE_TCA_RECOMPUTE_SQLSTATES:
        return True
    message = str(exc).lower()
    return "deadlock detected" in message or "serialization failure" in message


retryable_tca_recompute_error = _retryable_tca_recompute_error
_TRADING_HEALTH_SURFACE_EVALUATIONS: dict[
    str,
    Future[tuple[dict[str, object], int]],
] = {}
_TRADING_HEALTH_SURFACE_PAYLOAD_CACHE: dict[str, dict[str, object]] = {}
_OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = Lock()
_OPTIONS_CATALOG_FRESHNESS_CACHE: dict[
    tuple[str, ...], tuple[datetime, dict[str, object]]
] = {}
_TRADING_STATUS_READ_BUDGET_SECONDS = 12.0
_ALPACA_HEALTH_CACHE_LOCK = Lock()
_ALPACA_HEALTH_STATE: dict[str, object] = {}
_PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = 600
_PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = Lock()
_PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"
_paper_route_target_plan_success_cache: tuple[dict[str, Any], float] | None = None
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
_READINESS_PROMOTION_AUTHORITY_KEYS = frozenset(
    {
        "promotion_authority",
        "promotion_authority_ok",
        "promotion_allowed",
        "final_authority_ok",
        "final_promotion_allowed",
        "final_promotion_authorized",
    }
)
_ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS = 150
_SIMPLE_LANE_ALLOWED_REJECT_REASONS = {
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


_EXPORTED_SYMBOLS = {
    "BUILD_COMMIT": BUILD_COMMIT,
    "BUILD_VERSION": BUILD_VERSION,
    "HTTPConnection": HTTPConnection,
    "HTTPSConnection": HTTPSConnection,
    "SessionLocal": SessionLocal,
    "TorghutAlpacaClient": TorghutAlpacaClient,
    "WHITEPAPER_WORKFLOW": WHITEPAPER_WORKFLOW,
    "_ALPACA_HEALTH_STATE": _ALPACA_HEALTH_STATE,
    "_OPTIONS_CATALOG_FRESHNESS_CACHE": _OPTIONS_CATALOG_FRESHNESS_CACHE,
    "_TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR": (
        _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR
    ),
    "_TRADING_HEALTH_SURFACE_EVALUATION_LOCK": (
        _TRADING_HEALTH_SURFACE_EVALUATION_LOCK
    ),
    "_TRADING_HEALTH_SURFACE_EVALUATIONS": _TRADING_HEALTH_SURFACE_EVALUATIONS,
    "_TRADING_HEALTH_SURFACE_PAYLOAD_CACHE": _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE,
    "_TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS": (
        _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
    ),
    "_TRADING_STATUS_READ_BUDGET_SECONDS": _TRADING_STATUS_READ_BUDGET_SECONDS,
    "_TRADING_DEPENDENCY_HEALTH_CACHE": _TRADING_DEPENDENCY_HEALTH_CACHE,
    "_paper_route_target_plan_success_cache": (_paper_route_target_plan_success_cache),
    "_retryable_tca_recompute_error": _retryable_tca_recompute_error,
    "build_capital_replay_projection": build_capital_replay_projection,
    "build_empirical_jobs_status": build_empirical_jobs_status,
    "build_hypothesis_runtime_summary": build_hypothesis_runtime_summary,
    "build_live_submission_gate_payload": build_live_submission_gate_payload,
    "build_llm_evaluation_metrics": build_llm_evaluation_metrics,
    "build_profit_signal_quorum": build_profit_signal_quorum,
    "build_profitability_proof_floor_receipt": build_profitability_proof_floor_receipt,
    "build_quality_adjusted_profit_frontier": build_quality_adjusted_profit_frontier,
    "build_renewal_bond_profit_escrow": build_renewal_bond_profit_escrow,
    "build_revenue_repair_digest": build_revenue_repair_digest,
    "build_tca_gate_inputs": build_tca_gate_inputs,
    "check_schema_current": check_schema_current,
    "check_tigerbeetle_health": check_tigerbeetle_health,
    "evaluate_feature_batch_quality": evaluate_feature_batch_quality,
    "hypothesis_registry_requires_dependency_capability": (
        hypothesis_registry_requires_dependency_capability
    ),
    "latest_tigerbeetle_reconciliation_payload": (
        latest_tigerbeetle_reconciliation_payload
    ),
    "load_jangar_dependency_quorum": load_jangar_dependency_quorum,
    "load_jangar_route_continuity_packet": load_jangar_route_continuity_packet,
    "load_hypothesis_registry": load_hypothesis_registry,
    "load_quant_evidence_status": load_quant_evidence_status,
    "persist_evidence_epoch": persist_evidence_epoch,
    "refresh_execution_tca_metrics": refresh_execution_tca_metrics,
    "resolve_hypothesis_dependency_quorum": resolve_hypothesis_dependency_quorum,
    "tigerbeetle_ref_counts": tigerbeetle_ref_counts,
    "time": time,
    "retryable_tca_recompute_error": retryable_tca_recompute_error,
    "whitepaper_kafka_enabled": whitepaper_kafka_enabled,
    "whitepaper_semantic_indexing_enabled": whitepaper_semantic_indexing_enabled,
    "whitepaper_workflow_enabled": whitepaper_workflow_enabled,
}


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS = _ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS
ALPACA_HEALTH_CACHE_LOCK = _ALPACA_HEALTH_CACHE_LOCK
ALPACA_HEALTH_STATE = _ALPACA_HEALTH_STATE
OPTIONS_CATALOG_FRESHNESS_CACHE = _OPTIONS_CATALOG_FRESHNESS_CACHE
OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK
paper_route_target_plan_success_cache = _paper_route_target_plan_success_cache
READINESS_PROMOTION_AUTHORITY_KEYS = _READINESS_PROMOTION_AUTHORITY_KEYS
RETRYABLE_TCA_RECOMPUTE_SQLSTATES = _RETRYABLE_TCA_RECOMPUTE_SQLSTATES
SIMPLE_LANE_ALLOWED_REJECT_REASONS = _SIMPLE_LANE_ALLOWED_REJECT_REASONS
TRADING_DEPENDENCY_HEALTH_CACHE = _TRADING_DEPENDENCY_HEALTH_CACHE
TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = _TRADING_DEPENDENCY_HEALTH_CACHE_LOCK
TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = _TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR
TRADING_HEALTH_SURFACE_EVALUATION_LOCK = _TRADING_HEALTH_SURFACE_EVALUATION_LOCK
TRADING_HEALTH_SURFACE_EVALUATIONS = _TRADING_HEALTH_SURFACE_EVALUATIONS
TRADING_HEALTH_SURFACE_PAYLOAD_CACHE = _TRADING_HEALTH_SURFACE_PAYLOAD_CACHE
TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = _TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS
