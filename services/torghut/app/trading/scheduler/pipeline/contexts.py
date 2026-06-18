"""Typed internal contexts for scheduler pipeline stages."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from sqlalchemy.orm import Session

    from ....models import Strategy, TradeDecision
    from ...ingest import SignalBatch
    from ...llm import LLMReviewEngine
    from ...llm.schema import (
        MarketContextBundle,
        MarketSnapshot as LLMMarketSnapshot,
        PortfolioSnapshot,
        RecentDecisionSummary,
    )
    from ...models import StrategyDecision
    from ...prices import MarketSnapshot


def _empty_symbol_allowlist() -> set[str]:
    return set()


@dataclass(frozen=True)
class TradingPipelineRuntimeDependencies:
    alpaca_client: Any
    order_firewall: Any
    ingestor: Any
    decision_engine: Any
    risk_engine: Any
    executor: Any
    execution_adapter: Any
    reconciler: Any
    universe_resolver: Any
    state: Any
    account_label: str
    session_factory: Any
    llm_review_engine: Any | None = None
    price_fetcher: Any | None = None
    strategy_catalog: Any | None = None
    execution_policy: Any | None = None
    order_feed_ingestor: Any | None = None

    @classmethod
    def from_legacy_call(
        cls,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
        *,
        default_session_factory: Any,
    ) -> TradingPipelineRuntimeDependencies:
        names = (
            "alpaca_client",
            "order_firewall",
            "ingestor",
            "decision_engine",
            "risk_engine",
            "executor",
            "execution_adapter",
            "reconciler",
            "universe_resolver",
            "state",
            "account_label",
            "session_factory",
            "llm_review_engine",
            "price_fetcher",
            "strategy_catalog",
            "execution_policy",
            "order_feed_ingestor",
        )
        values = dict(kwargs)
        for name, value in zip(names, args, strict=False):
            if name in values:
                raise TypeError(f"multiple values for argument {name!r}")
            values[name] = value
        values.setdefault("session_factory", default_session_factory)
        missing = [name for name in names[:11] if name not in values]
        if missing:
            missing_list = ", ".join(missing)
            raise TypeError(f"missing required pipeline dependencies: {missing_list}")
        return cls(
            alpaca_client=values["alpaca_client"],
            order_firewall=values["order_firewall"],
            ingestor=values["ingestor"],
            decision_engine=values["decision_engine"],
            risk_engine=values["risk_engine"],
            executor=values["executor"],
            execution_adapter=values["execution_adapter"],
            reconciler=values["reconciler"],
            universe_resolver=values["universe_resolver"],
            state=values["state"],
            account_label=str(values["account_label"]),
            session_factory=values["session_factory"],
            llm_review_engine=values.get("llm_review_engine"),
            price_fetcher=values.get("price_fetcher"),
            strategy_catalog=values.get("strategy_catalog"),
            execution_policy=values.get("execution_policy"),
            order_feed_ingestor=values.get("order_feed_ingestor"),
        )


@dataclass(frozen=True)
class SessionWarmupWindow:
    session_day: date
    start: datetime
    end: datetime
    limit: int
    max_seconds: int
    max_signals: int


@dataclass(frozen=True)
class AllocationDecisionContext:
    session: Session
    strategies: list[Strategy]
    account: dict[str, str]
    positions: list[dict[str, Any]]
    allowed_symbols: set[str]


@dataclass(frozen=True)
class BatchSignalProcessingContext:
    session: Session
    batch: SignalBatch
    strategies: list[Strategy]
    account_snapshot: Any
    account: dict[str, str]
    positions: list[dict[str, Any]]
    allowed_symbols: set[str]


@dataclass(frozen=True)
class PositionTagContext:
    symbol_exposures: Mapping[str, Mapping[str, Any]]
    signed_position_qty: Decimal
    position_qty: Decimal
    side: str


@dataclass(frozen=True)
class StrategyPositionTagRequest:
    position: dict[str, Any]
    strategy_id: str
    exposure: Mapping[str, Any]
    qty: Decimal
    side: str
    session_open: datetime
    split_from_aggregate: bool = False


@dataclass(frozen=True)
class StrategyPositionExposureUpdate:
    symbol: str
    strategy_id: str
    signed_qty: Decimal
    filled_qty: Decimal
    side: str
    execution_created_at: datetime
    avg_fill_price: Optional[Decimal]


@dataclass(frozen=True)
class DecisionSubmissionContext:
    session: Session
    decision_row: TradeDecision
    strategy: Strategy
    account: dict[str, str]
    positions: list[dict[str, Any]]
    symbol_allowlist: set[str] = field(default_factory=_empty_symbol_allowlist)


@dataclass(frozen=True)
class LiveSubmissionGateInputs:
    session: Session | None = None
    hypothesis_summary: Mapping[str, Any] | None = None
    empirical_jobs_status: Mapping[str, Any] | None = None
    dspy_runtime_status: Mapping[str, Any] | None = None
    quant_health_status: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class DecisionBlockRequest:
    session: Session
    decision: StrategyDecision
    decision_row: TradeDecision
    reason: str
    submission_stage: str
    capital_stage: str | None = None
    extra_metadata: Mapping[str, Any] | None = None
    severity: str = "warning"


@dataclass(frozen=True)
class DecisionRejectionRequest:
    session: Session
    decision: StrategyDecision
    decision_row: TradeDecision
    reasons: list[str]
    log_template: str


@dataclass(frozen=True)
class DomainTelemetryEvent:
    event_name: str
    severity: str
    decision: StrategyDecision | None = None
    decision_row: TradeDecision | None = None
    execution: Any | None = None
    reason_codes: Sequence[str] | None = None
    extra_properties: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ExecutionPolicyRequest:
    context: DecisionSubmissionContext
    decision: StrategyDecision
    snapshot: Optional[MarketSnapshot]


@dataclass(frozen=True)
class RiskVerdictRequest:
    context: DecisionSubmissionContext
    decision: StrategyDecision
    execution_advisor: Mapping[str, Any] | None


@dataclass(frozen=True)
class LLMReviewContext:
    session: Session
    decision_row: TradeDecision
    account: dict[str, str]
    positions: list[dict[str, Any]]


@dataclass(frozen=True)
class LLMRuntimeBlockRequest:
    context: LLMReviewContext
    decision: StrategyDecision
    reason: str
    reject_reason: str
    risk_flags: list[str]
    response_payload_extra: dict[str, Any] | None = None
    policy_resolution: dict[str, Any] | None = None


@dataclass(frozen=True)
class LLMPolicyReviewRequest:
    context: LLMReviewContext
    decision: StrategyDecision
    guardrails: Any
    policy_resolution: dict[str, Any]
    engine: LLMReviewEngine | None = None


@dataclass(frozen=True)
class LLMRuntimeReviewResult:
    engine: LLMReviewEngine | None
    block: tuple[StrategyDecision, Optional[str]] | None = None


@dataclass(frozen=True)
class MarketContextBlockRequest:
    context: LLMReviewContext
    decision: StrategyDecision
    guardrails: Any
    policy_resolution: dict[str, Any]
    market_context: Optional[MarketContextBundle]
    market_context_error: Optional[str]


@dataclass(frozen=True)
class LLMUnavailableRequest:
    context: LLMReviewContext
    decision: StrategyDecision
    reason: str
    shadow_mode: bool
    effective_fail_mode: str | None = None
    risk_flags: list[str] | None = None
    market_context: Optional[MarketContextBundle] = None
    reject_reason: str | None = None
    response_payload_extra: dict[str, Any] | None = None
    policy_resolution: dict[str, Any] | None = None


@dataclass(frozen=True)
class LLMReviewErrorRequest:
    context: LLMReviewContext
    decision: StrategyDecision
    guardrails: Any
    policy_resolution: dict[str, Any]
    engine: LLMReviewEngine
    request_json: dict[str, Any]
    error: Exception


@dataclass(frozen=True)
class LLMReviewRunRequest:
    context: LLMReviewContext
    decision: StrategyDecision
    guardrails: Any
    policy_resolution: dict[str, Any]
    engine: LLMReviewEngine
    request_json: dict[str, Any]


@dataclass(frozen=True)
class LLMReviewInputs:
    portfolio_snapshot: PortfolioSnapshot
    market_snapshot: Optional[LLMMarketSnapshot]
    market_context: Optional[MarketContextBundle]
    market_context_error: Optional[str]
    recent_decisions: list[RecentDecisionSummary]


@dataclass(frozen=True)
class LLMReviewRecord:
    session: Session
    decision_row: TradeDecision
    model: str
    prompt_version: str
    request_json: dict[str, Any]
    response_json: dict[str, Any]
    verdict: str
    confidence: Optional[float]
    adjusted_qty: Optional[Decimal]
    adjusted_order_type: Optional[str]
    rationale: Optional[str]
    risk_flags: list[str]
    tokens_prompt: Optional[int]
    tokens_completion: Optional[int]


@dataclass(frozen=True)
class OrderSubmissionRequest:
    session: Session
    execution_client: Any
    decision: StrategyDecision
    decision_row: TradeDecision
    selected_adapter_name: str
    retry_delays: list[int]


@dataclass(frozen=True)
class ExecutionFallbackRequest:
    session: Session
    decision: StrategyDecision
    decision_row: TradeDecision
    execution: Any
    selected_adapter_name: str
    actual_adapter_name: str
