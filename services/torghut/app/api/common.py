"""Shared imports and runtime state for Torghut API modules."""

import logging
import os
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from threading import Lock

from sqlalchemy.exc import OperationalError

from ..trading.lean_lanes import LeanLaneManager
from ..whitepapers import (
    WhitepaperWorkflowService,
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
ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = _ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS
TRADING_STATUS_READ_BUDGET_SECONDS = _TRADING_STATUS_READ_BUDGET_SECONDS
PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = (
    _PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS
)
PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = _PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK
PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = (
    _PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL
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
