from __future__ import annotations
from app.trading.discovery.portfolio_optimizer_modules import (
    Decimal,
    ROUND_CEILING,
    Any,
    Mapping,
    Sequence,
    cast,
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_is_valid,
    PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
    PortfolioCandidateSpec,
    portfolio_candidate_id_for_payload,
    deployable_lower_bound_net_pnl_per_day,
    evaluate_profit_target_oracle,
    ProfitTargetOraclePolicy,
    POST_COST_PNL_BASIS,
    MAX_ALLOWED_PAIRWISE_CORRELATION,
    CONFORMAL_TAIL_RISK_ALPHA,
    PORTFOLIO_SEARCH_BEAM_WIDTH,
    PORTFOLIO_WEIGHTING_EQUAL_COUNT,
    PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET,
    PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET,
    PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE,
    PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES,
    optimize_portfolio_candidate,
)
from app.trading.discovery.portfolio_optimizer_modules import (
    portfolio_trading_day_count as _portfolio_trading_day_count,
)
from app.trading.discovery.portfolio_optimizer_modules import (
    shared_context as _shared_context,
)

_candidate_passes_minimums = getattr(_shared_context, "_candidate_passes_minimums")
_capital_safety_rejection = getattr(_shared_context, "_capital_safety_rejection")
_daily_net = getattr(_shared_context, "_daily_net")
_edge_risk_gross_exposure_budget_weights = getattr(
    _shared_context, "_edge_risk_gross_exposure_budget_weights"
)
_exact_replay_ledger_artifact_refs = getattr(
    _shared_context, "_exact_replay_ledger_artifact_refs"
)
_exact_replay_ledger_fill_count = getattr(
    _shared_context, "_exact_replay_ledger_fill_count"
)
_exact_replay_ledger_row_count = getattr(
    _shared_context, "_exact_replay_ledger_row_count"
)
_gross_exposure_allocation_priority = getattr(
    _shared_context, "_gross_exposure_allocation_priority"
)
_negative_cash_observation_count = getattr(
    _shared_context, "_negative_cash_observation_count"
)
_oracle_blocker_count = getattr(_portfolio_trading_day_count, "_oracle_blocker_count")

__all__ = [
    "Decimal",
    "ROUND_CEILING",
    "Any",
    "Mapping",
    "Sequence",
    "cast",
    "CandidateEvidenceBundle",
    "evidence_bundle_blockers",
    "evidence_bundle_is_valid",
    "PORTFOLIO_CANDIDATE_SCHEMA_VERSION",
    "PortfolioCandidateSpec",
    "portfolio_candidate_id_for_payload",
    "deployable_lower_bound_net_pnl_per_day",
    "evaluate_profit_target_oracle",
    "ProfitTargetOraclePolicy",
    "POST_COST_PNL_BASIS",
    "MAX_ALLOWED_PAIRWISE_CORRELATION",
    "CONFORMAL_TAIL_RISK_ALPHA",
    "PORTFOLIO_SEARCH_BEAM_WIDTH",
    "PORTFOLIO_WEIGHTING_EQUAL_COUNT",
    "PORTFOLIO_WEIGHTING_GROSS_EXPOSURE_BUDGET",
    "PORTFOLIO_WEIGHTING_EDGE_RISK_GROSS_EXPOSURE_BUDGET",
    "PORTFOLIO_RUNTIME_LEDGER_PNL_SOURCE",
    "PORTFOLIO_COMPOSABLE_SINGLE_SLEEVE_VETOES",
    "optimize_portfolio_candidate",
    "_candidate_passes_minimums",
    "_capital_safety_rejection",
    "_daily_net",
    "_edge_risk_gross_exposure_budget_weights",
    "_exact_replay_ledger_artifact_refs",
    "_exact_replay_ledger_fill_count",
    "_exact_replay_ledger_row_count",
    "_gross_exposure_allocation_priority",
    "_negative_cash_observation_count",
    "_oracle_blocker_count",
]
