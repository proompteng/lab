"""Generic multifactor trading machine contracts and runtime helpers."""

from .alpha_model import build_alpha_forecast
from .attribution import AttributionInputs, build_attribution_snapshot
from .contracts import (
    AlphaForecast,
    AssetKey,
    AttributionSnapshot,
    ExecutionIntent,
    FactorVector,
    PortfolioTarget,
    RiskForecast,
    UniverseSnapshot,
)
from .cost_model import estimate_transaction_cost
from .portfolio_construction import (
    PortfolioCostInput,
    PortfolioLimits,
    build_portfolio_target,
)
from .risk_model import RiskExposureState, RiskLimits, build_risk_forecast

__all__ = [
    "AlphaForecast",
    "AssetKey",
    "AttributionSnapshot",
    "AttributionInputs",
    "ExecutionIntent",
    "FactorVector",
    "PortfolioCostInput",
    "PortfolioLimits",
    "PortfolioTarget",
    "RiskExposureState",
    "RiskForecast",
    "RiskLimits",
    "UniverseSnapshot",
    "build_alpha_forecast",
    "build_attribution_snapshot",
    "build_portfolio_target",
    "build_risk_forecast",
    "estimate_transaction_cost",
]
