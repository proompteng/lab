from __future__ import annotations

import logging

from ...config import settings
from .adaptive_policy import (
    ADAPTIVE_DEGRADE_FALLBACK_BPS,
    ADAPTIVE_EXECUTION_SLOWDOWN,
    ADAPTIVE_EXECUTION_SPEEDUP,
    ADAPTIVE_LOOKBACK_WINDOW,
    ADAPTIVE_MAX_SHORTFALL,
    ADAPTIVE_MAX_SLIPPAGE_BPS,
    ADAPTIVE_MIN_EXPECTED_SHORTFALL_COVERAGE,
    ADAPTIVE_MIN_SAMPLE_SIZE,
    ADAPTIVE_PARTICIPATION_RELAX,
    ADAPTIVE_PARTICIPATION_TIGHTEN,
    ADAPTIVE_TARGET_SLIPPAGE_BPS,
    AdaptiveExecutionPolicyDecision,
    derive_adaptive_execution_policy,
)
from .execution_tca_metrics import (
    EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
    upsert_execution_tca_metric,
)
from .lineage_read_model import build_tca_gate_inputs, refresh_execution_tca_metrics

logger = logging.getLogger("app.trading.tca")

__all__ = [
    "ADAPTIVE_DEGRADE_FALLBACK_BPS",
    "ADAPTIVE_EXECUTION_SLOWDOWN",
    "ADAPTIVE_EXECUTION_SPEEDUP",
    "ADAPTIVE_LOOKBACK_WINDOW",
    "ADAPTIVE_MAX_SHORTFALL",
    "ADAPTIVE_MAX_SLIPPAGE_BPS",
    "ADAPTIVE_MIN_EXPECTED_SHORTFALL_COVERAGE",
    "ADAPTIVE_MIN_SAMPLE_SIZE",
    "ADAPTIVE_PARTICIPATION_RELAX",
    "ADAPTIVE_PARTICIPATION_TIGHTEN",
    "ADAPTIVE_TARGET_SLIPPAGE_BPS",
    "AdaptiveExecutionPolicyDecision",
    "EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION",
    "POST_COST_PNL_BASIS",
    "build_tca_gate_inputs",
    "derive_adaptive_execution_policy",
    "logger",
    "refresh_execution_tca_metrics",
    "settings",
    "upsert_execution_tca_metric",
]
