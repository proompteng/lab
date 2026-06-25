"""API proof and profitability contract constants."""

from threading import Lock

from sqlalchemy.exc import OperationalError

RUNTIME_PROFITABILITY_LOOKBACK_HOURS = 72
RUNTIME_PROFITABILITY_SCHEMA_VERSION = "torghut.runtime-profitability.v1"
PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS = 86_400
CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE = (
    "Jangar dependency quorum is evaluated by the calling control plane; "
    "Torghut omits the recursive control-plane status fetch for consumer evidence."
)
ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS = 3
RETRYABLE_TCA_RECOMPUTE_SQLSTATES = frozenset({"40P01", "40001"})
PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS = 600
PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK = Lock()
PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL = "TORGHUT_SIM"
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


def retryable_tca_recompute_error(exc: BaseException) -> bool:
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


__all__ = (
    "RUNTIME_PROFITABILITY_LOOKBACK_HOURS",
    "RUNTIME_PROFITABILITY_SCHEMA_VERSION",
    "PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS",
    "CONSUMER_EVIDENCE_CONTROL_PLANE_DEPENDENCY_MESSAGE",
    "ZERO_NOTIONAL_TCA_RECOMPUTE_MAX_ATTEMPTS",
    "RETRYABLE_TCA_RECOMPUTE_SQLSTATES",
    "retryable_tca_recompute_error",
    "PAPER_ROUTE_TARGET_PLAN_STALE_SUCCESS_SECONDS",
    "PAPER_ROUTE_TARGET_PLAN_SUCCESS_CACHE_LOCK",
    "PAPER_ROUTE_BOUNDED_COLLECTION_ACCOUNT_LABEL",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
)
