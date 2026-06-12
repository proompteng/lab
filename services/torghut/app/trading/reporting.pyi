from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
import json
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path
from typing import Any, Literal, Mapping, Optional, cast
from ..models import Strategy
from .costs import CostModelConfig, CostModelInputs, OrderIntent, TransactionCostModel
from .evaluation import WalkForwardDecision, WalkForwardResults
from .evaluation_trace import SweepCandidateResult
from .regime import RegimeLabel, classify_regime

class EvaluationReportConfig:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    evaluation_start: datetime
    evaluation_end: datetime
    signal_source: str
    strategies: list[Strategy]
    git_sha: Optional[str]
    cost_model_config: CostModelConfig
    run_id: Optional[str]
    strategy_config_path: Optional[str]
    variant_count: Optional[int]
    variant_warning_threshold: int
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class EvaluationMetrics:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    decision_count: int
    trade_count: int
    gross_pnl: Decimal
    net_pnl: Decimal
    total_cost: Decimal
    max_drawdown: Decimal
    turnover_notional: Decimal
    turnover_ratio: Decimal
    average_exposure: Decimal
    cost_bps: Decimal
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class RobustnessFoldMetrics:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    fold_name: str
    decision_count: int
    trade_count: int
    net_pnl: Decimal
    max_drawdown: Decimal
    turnover_ratio: Decimal
    cost_bps: Decimal
    regime: RegimeLabel
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class RobustnessReport:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    method: str
    fold_count: int
    net_pnl_mean: Decimal
    net_pnl_std: Decimal
    net_pnl_cv: Optional[Decimal]
    worst_fold_net_pnl: Decimal
    best_fold_net_pnl: Decimal
    negative_fold_count: int
    folds: list[RobustnessFoldMetrics]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class MultipleTestingSummary:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    variant_count: int
    warning_threshold: int
    warning_triggered: bool
    warnings: list[str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class EvaluationImpactAssumptions:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    default_execution_seconds: int
    decisions_with_spread: int
    decisions_with_volatility: int
    decisions_with_adv: int
    assumptions: dict[str, str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class EvaluationGatePolicy:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    policy_version: str
    promotion_enabled: bool
    allow_live: bool
    min_trades: int
    min_net_pnl: Decimal
    max_drawdown: Decimal
    max_turnover_ratio: Decimal
    def from_path(*args: Any, **kwargs: Any) -> Any: ...
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class EvaluationGateOutcome:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    policy_version: str
    promotion_requested: bool
    promotion_target: Literal["shadow", "paper", "live"]
    promotion_allowed: bool
    evidence_collection_allowed: bool
    recommended_mode: Literal["shadow", "paper", "live"]
    reasons: list[str]
    promotion_blockers: list[str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class EvaluationReport:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    report_version: str
    generated_at: datetime
    config: EvaluationReportConfig
    metrics: EvaluationMetrics
    gates: EvaluationGateOutcome
    robustness: RobustnessReport
    multiple_testing: MultipleTestingSummary
    impact_assumptions: EvaluationImpactAssumptions
    git_sha: Optional[str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class PromotionEvidenceSummary:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    fold_metrics_count: int
    stress_metrics_count: int
    rationale_present: bool
    evidence_complete: bool
    reasons: list[str]
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

class PromotionRecommendation:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    action: Literal["promote", "hold", "deny", "demote"]
    requested_mode: Literal["shadow", "paper", "live"]
    recommended_mode: Literal["shadow", "paper", "live"]
    eligible: bool
    rationale: str
    reasons: list[str]
    evidence: PromotionEvidenceSummary
    trace_id: str
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

def build_promotion_recommendation(*args: Any, **kwargs: Any) -> Any: ...

class _PositionState:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    qty: Decimal
    avg_price: Optional[Decimal]

class _ResolvedImpactInputs:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    spread: Optional[Decimal]
    volatility: Optional[Decimal]
    adv: Optional[Decimal]
    execution_seconds: int

def generate_evaluation_report(*args: Any, **kwargs: Any) -> Any: ...
def write_evaluation_report(*args: Any, **kwargs: Any) -> Any: ...
def _flatten_decisions(*args: Any, **kwargs: Any) -> Any: ...
def _evaluate_metrics(*args: Any, **kwargs: Any) -> Any: ...
def _evaluate_gates(*args: Any, **kwargs: Any) -> Any: ...
def _evaluate_robustness(*args: Any, **kwargs: Any) -> Any: ...
def _evaluate_multiple_testing(*args: Any, **kwargs: Any) -> Any: ...
def _apply_fill(*args: Any, **kwargs: Any) -> Any: ...
def _open_long(*args: Any, **kwargs: Any) -> Any: ...
def _close_long(*args: Any, **kwargs: Any) -> Any: ...
def _open_short(*args: Any, **kwargs: Any) -> Any: ...
def _cover_short(*args: Any, **kwargs: Any) -> Any: ...
def _unrealized_pnl(*args: Any, **kwargs: Any) -> Any: ...
def _exposure_notional(*args: Any, **kwargs: Any) -> Any: ...
def _estimate_cost(*args: Any, **kwargs: Any) -> Any: ...
def _resolve_price(*args: Any, **kwargs: Any) -> Any: ...
def _cost_model_payload(*args: Any, **kwargs: Any) -> Any: ...
def _collect_impact_assumptions(*args: Any, **kwargs: Any) -> Any: ...
def _strategy_payload(*args: Any, **kwargs: Any) -> Any: ...
def _decimal(*args: Any, **kwargs: Any) -> Any: ...
def _resolve_impact_inputs(*args: Any, **kwargs: Any) -> Any: ...
def _recorded_impact_inputs(*args: Any, **kwargs: Any) -> Any: ...
def _as_int(*args: Any, **kwargs: Any) -> Any: ...
def _deterministic_mode_int(*args: Any, **kwargs: Any) -> Any: ...
def _bps_from_cost(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_mean(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_std(*args: Any, **kwargs: Any) -> Any: ...

class ProfitabilityConstraintPolicy:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    holdout_target_net_per_day: Decimal
    min_active_holdout_days: int
    max_worst_holdout_day_loss: Decimal
    max_holdout_drawdown_pct_equity: Decimal | None
    min_holdout_p10_daily_net: Decimal | None
    min_profit_factor: Decimal
    require_training_decisions: bool
    require_holdout_decisions: bool

class ReplayProfitabilitySummary:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    start_date: str
    end_date: str
    start_equity: Decimal | None
    trading_day_count: int
    net_pnl: Decimal
    net_per_day: Decimal
    active_days: int
    decision_count: int
    filled_count: int
    wins: int
    losses: int
    worst_day_net: Decimal
    p10_daily_net: Decimal
    max_drawdown: Decimal
    max_drawdown_pct_equity: Decimal | None
    profit_factor: Decimal | None
    daily_net: dict[str, Decimal]

def _daily_drawdown(*args: Any, **kwargs: Any) -> Any: ...
def _daily_quantile_floor(*args: Any, **kwargs: Any) -> Any: ...
def summarize_replay_profitability(*args: Any, **kwargs: Any) -> Any: ...
def score_replay_profitability_candidate(*args: Any, **kwargs: Any) -> Any: ...

__all__: Any
