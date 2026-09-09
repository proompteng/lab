"""Type-only dependency boundary shared by scheduler pipeline domains."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Protocol

from ..capital_controls import CapitalSafetyController

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from ....alpaca_client import TorghutAlpacaClient
    from ....models import Execution, PositionSnapshot, Strategy, TradeDecision
    from ....strategies import StrategyCatalog
    from ...decisions import DecisionEngine
    from ...execution import OrderExecutor
    from ...execution_adapters import ExecutionAdapter
    from ...execution_policy import ExecutionPolicy, ExecutionPolicyOutcome
    from ...feature_quality import FeatureQualityReport
    from ...firewall import OrderFirewall
    from ...ingest import ClickHouseSignalIngestor, SignalBatch
    from ...lean_lanes import LeanLaneManager
    from ...llm import LLMReviewEngine
    from ...llm.policy import PolicyOutcome
    from ...llm.review_engine import LLMReviewOutcome
    from ...llm.schema import (
        MarketContextBundle,
        MarketSnapshot as LLMMarketSnapshot,
    )
    from ...market_context import MarketContextClient
    from ...models import SignalEnvelope, StrategyDecision
    from ...order_feed import OrderFeedIngestor
    from ...portfolio import AllocationResult, PortfolioSizingResult
    from ...prices import MarketSnapshot, PriceFetcher
    from ...quote_quality import SignalQuoteQualityTracker
    from ...reconcile import Reconciler
    from ...risk import RiskEngine
    from ...universe import UniverseResolver
    from ..state import RuntimeUncertaintyGate, TradingState
    from .contexts import (
        AllocationDecisionContext,
        BatchSignalProcessingContext,
        DecisionBlockRequest,
        DecisionSubmissionContext,
        DomainTelemetryEvent,
        ExecutionFallbackRequest,
        ExecutionPolicyRequest,
        LLMReviewContext,
        LLMReviewErrorRequest,
        LLMReviewRecord,
        LLMUnavailableRequest,
        MarketContextBlockRequest,
        OrderSubmissionRequest,
        RiskVerdictRequest,
    )


class TradingPipelineInteractions(Protocol):
    """Shared dependencies exposed to the existing semantic scheduler domains."""

    alpaca_client: TorghutAlpacaClient
    order_firewall: OrderFirewall
    ingestor: ClickHouseSignalIngestor
    decision_engine: DecisionEngine
    risk_engine: RiskEngine
    executor: OrderExecutor
    execution_adapter: ExecutionAdapter
    reconciler: Reconciler
    universe_resolver: UniverseResolver
    state: TradingState
    account_label: str
    session_factory: Callable[[], Session]
    price_fetcher: PriceFetcher
    strategy_catalog: StrategyCatalog | None
    execution_policy: ExecutionPolicy
    order_feed_ingestor: OrderFeedIngestor
    capital_safety: CapitalSafetyController
    market_context_client: MarketContextClient
    lean_lane_manager: LeanLaneManager
    llm_review_engine: LLMReviewEngine | None
    _signal_quote_quality: SignalQuoteQualityTracker

    def _apply_allocation_results(
        self,
        *,
        context: AllocationDecisionContext,
        allocation_results: list[AllocationResult],
    ) -> None: ...

    def _apply_llm_policy_verdict(
        self,
        *,
        session: Session,
        decision_row: TradeDecision,
        policy_outcome: PolicyOutcome,
    ) -> tuple[Decimal | None, str | None]: ...

    def _apply_llm_review(
        self,
        context: LLMReviewContext,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, str | None]: ...

    def _apply_pair_allocation_results(
        self,
        *,
        context: AllocationDecisionContext,
        allocation_results: list[AllocationResult],
    ) -> None: ...

    def _apply_portfolio_sizing(
        self,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, object]],
    ) -> PortfolioSizingResult: ...

    def _apply_runtime_uncertainty_gate(
        self,
        decision: StrategyDecision,
        *,
        positions: list[dict[str, object]],
    ) -> tuple[StrategyDecision, dict[str, object], str | None]: ...

    def _attach_current_session_strategy_position_tags(
        self,
        session: Session,
        positions: list[dict[str, object]],
    ) -> list[dict[str, object]]: ...

    @staticmethod
    def _attach_strategy_position_tags(
        position: dict[str, object],
        *,
        exposures: Mapping[str, Mapping[str, Mapping[str, object]]],
        session_open: datetime,
    ) -> list[dict[str, object]]: ...

    def _block_decision_submission(self, request: DecisionBlockRequest) -> None: ...

    def _bounded_degraded_qty(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, object]],
        multiplier: Decimal,
    ) -> Decimal: ...

    def _build_llm_response_json(
        self,
        *,
        outcome: LLMReviewOutcome,
        policy_outcome: PolicyOutcome,
        guardrails: object,
        policy_resolution: dict[str, object],
    ) -> dict[str, object]: ...

    def _build_market_snapshot(
        self,
        decision: StrategyDecision,
    ) -> LLMMarketSnapshot | None: ...

    def _decision_lifecycle_metadata(
        self,
        *,
        submission_stage: str,
        capital_stage: str | None = None,
        extra: Mapping[str, object] | None = None,
    ) -> dict[str, object]: ...

    def _degrade_runtime_uncertainty_gate_decision(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, object]],
        regime_gate: RuntimeUncertaintyGate,
        payload: dict[str, object],
    ) -> tuple[StrategyDecision, dict[str, object], str | None]: ...

    def _emit_domain_telemetry(self, event: DomainTelemetryEvent) -> None: ...

    def _ensure_decision_price(
        self,
        decision: StrategyDecision,
        signal_price: object,
    ) -> tuple[StrategyDecision, MarketSnapshot | None]: ...

    def _ensure_signal_executable_price(
        self,
        signal: SignalEnvelope,
    ) -> SignalEnvelope: ...

    def _evaluate_execution_policy_outcome(
        self,
        request: ExecutionPolicyRequest,
    ) -> tuple[StrategyDecision, ExecutionPolicyOutcome] | None: ...

    def _execution_client_for_symbol(self, symbol: str) -> ExecutionAdapter: ...

    def _execution_client_name(
        self,
        client: ExecutionAdapter,
    ) -> str: ...

    def _feature_quality_failure_payload(
        self,
        *,
        batch: SignalBatch,
        quality_signals: list[SignalEnvelope],
        quality_report: FeatureQualityReport,
    ) -> dict[str, object]: ...

    def _fetch_market_context(
        self,
        symbol: str,
        *,
        as_of: datetime | None = None,
    ) -> tuple[MarketContextBundle | None, str | None]: ...

    def _finalize_llm_review_outcome(
        self,
        *,
        decision: StrategyDecision,
        outcome: LLMReviewOutcome,
        policy_outcome: PolicyOutcome,
        guardrails: object,
    ) -> tuple[StrategyDecision, str | None]: ...

    def _get_account_snapshot(self, session: Session) -> PositionSnapshot: ...

    def _handle_execution_fallback(self, request: ExecutionFallbackRequest) -> None: ...

    def _handle_llm_review_error(
        self,
        request: LLMReviewErrorRequest,
    ) -> tuple[StrategyDecision, str | None]: ...

    def _handle_llm_unavailable(
        self,
        request: LLMUnavailableRequest,
    ) -> tuple[StrategyDecision, str | None]: ...

    def _ingest_order_feed(self, session: Session) -> None: ...

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool: ...

    def label_mature_rejected_signal_outcomes(
        self,
        *,
        now: datetime | None = None,
        limit: int = 25,
        followup_horizon: timedelta = timedelta(minutes=5),
    ) -> None: ...

    def _live_submission_gate(self) -> dict[str, object]: ...

    @staticmethod
    def _load_strategies(session: Session) -> list[Strategy]: ...

    def _maybe_handle_market_context_block(
        self,
        request: MarketContextBlockRequest,
    ) -> tuple[StrategyDecision, str | None] | None: ...

    def _maybe_record_lean_strategy_shadow(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
    ) -> None: ...

    def _passes_risk_verdict(self, request: RiskVerdictRequest) -> bool: ...

    @staticmethod
    def _persist_llm_review(record: LLMReviewRecord) -> None: ...

    def _position_qty_for_symbol(
        self,
        positions: list[dict[str, object]],
        symbol: str,
    ) -> Decimal: ...

    def _prepare_decision_for_submission(
        self,
        *,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
    ) -> tuple[StrategyDecision, MarketSnapshot | None] | None: ...

    def _process_batch_signals(
        self,
        *,
        context: BatchSignalProcessingContext,
    ) -> None: ...

    def _record_llm_committee_metrics(
        self,
        response_json: Mapping[str, object],
    ) -> None: ...

    def _record_llm_token_metrics(self, outcome: LLMReviewOutcome) -> None: ...

    def _record_llm_verdict_counter(self, verdict: str) -> None: ...

    def _record_market_context_observation(
        self,
        *,
        symbol: str,
        market_context: MarketContextBundle | None,
        market_context_error: str | None,
    ) -> None: ...

    def _record_simulation_position_state(
        self,
        *,
        execution_client: ExecutionAdapter,
        symbol: str,
    ) -> None: ...

    def _relevant_signal_symbols(
        self,
        *,
        strategies: Sequence[Strategy] | None,
        allowed_symbols: set[str] | None,
    ) -> set[str]: ...

    def _resolve_execution_context_open_orders(self) -> list[dict[str, object]]: ...

    @staticmethod
    def _resolve_pre_llm_executability_reject(
        decision: StrategyDecision,
    ) -> str | None: ...

    def _resolve_regime_confidence_thresholds(
        self,
        entropy_band: str,
    ) -> tuple[Decimal, Decimal]: ...

    def _resolve_runtime_uncertainty_degrade_profile(
        self,
        decision: StrategyDecision,
        regime_gate: RuntimeUncertaintyGate,
    ) -> tuple[Decimal, Decimal, int]: ...

    def _resolve_runtime_uncertainty_gate_components(
        self,
        decision: StrategyDecision,
    ) -> tuple[
        RuntimeUncertaintyGate,
        RuntimeUncertaintyGate,
        RuntimeUncertaintyGate,
    ]: ...

    def _sell_inventory_context(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, object]],
        projected: bool,
    ) -> str: ...

    @staticmethod
    def _should_degrade_runtime_uncertainty_fail(
        uncertainty_gate: RuntimeUncertaintyGate,
        gate: RuntimeUncertaintyGate,
    ) -> bool: ...

    def _submit_decision_execution(
        self,
        *,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
        policy_outcome: ExecutionPolicyOutcome,
    ) -> bool: ...

    def _submit_order_with_handling(
        self,
        request: OrderSubmissionRequest,
    ) -> tuple[Execution | None, bool]: ...

    def is_market_session_open(self, now: datetime | None = None) -> bool: ...

    def record_no_signal_batch(self, batch: SignalBatch) -> None: ...


__all__ = ["TradingPipelineInteractions"]
