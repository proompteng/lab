"""Shared health-cache state for Torghut API readiness surfaces."""

from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from threading import Lock

TRADING_DEPENDENCY_HEALTH_CACHE_LOCK = Lock()
TRADING_DEPENDENCY_HEALTH_CACHE: dict[str, dict[str, object]] = {}
TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS = 3.0
TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="torghut-health-surface",
)
TRADING_HEALTH_SURFACE_EVALUATION_LOCK = Lock()
TRADING_HEALTH_SURFACE_EVALUATIONS: dict[
    str,
    Future[tuple[dict[str, object], int]],
] = {}
TRADING_HEALTH_SURFACE_PAYLOAD_CACHE: dict[str, dict[str, object]] = {}
OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK = Lock()
OPTIONS_CATALOG_FRESHNESS_CACHE: dict[
    tuple[str, ...], tuple[datetime, dict[str, object]]
] = {}
TRADING_STATUS_READ_BUDGET_SECONDS = 12.0
ALPACA_HEALTH_CACHE_LOCK = Lock()
ALPACA_HEALTH_STATE: dict[str, object] = {}
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

__all__ = (
    "TRADING_DEPENDENCY_HEALTH_CACHE_LOCK",
    "TRADING_DEPENDENCY_HEALTH_CACHE",
    "TRADING_HEALTH_SURFACE_TIMEOUT_SECONDS",
    "TRADING_HEALTH_SURFACE_EVALUATION_EXECUTOR",
    "TRADING_HEALTH_SURFACE_EVALUATION_LOCK",
    "TRADING_HEALTH_SURFACE_EVALUATIONS",
    "TRADING_HEALTH_SURFACE_PAYLOAD_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "TRADING_STATUS_READ_BUDGET_SECONDS",
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "READINESS_PROMOTION_AUTHORITY_KEYS",
    "ACCOUNT_SCOPE_STATEMENT_TIMEOUT_MS",
)
