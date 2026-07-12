from __future__ import annotations

from datetime import time

from typing import Literal

from tests.pipeline.trading_pipeline_support import (
    AdaptiveExecutionPolicyDecision,
    Any,
    Base,
    Callable,
    CountingAlpacaClient,
    CountingLLMReviewEngine,
    CursorAdvancingFakeIngestor,
    CursorErrorWarmupIngestor,
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeCircuitBreaker,
    FakeIngestor,
    FakeLLMReviewEngine,
    FakePriceFetcher,
    FetchErrorWarmupIngestor,
    LLMDecisionContext,
    LLMDecisionReview,
    LLMPolicyContext,
    LLMReviewOutcome,
    LLMReviewRequest,
    LLMReviewResponse,
    Mapping,
    MarketContextBundle,
    MarketSnapshot,
    Mock,
    NoSignalReasonIngestor,
    OpenOrderAlpacaClient,
    OrderExecutor,
    OrderFirewall,
    Path,
    PortfolioSnapshot,
    PositionSnapshot,
    PositionedAlpacaClient,
    PriceFetcher,
    QuoteQualityStatus,
    RaisingObserveDecisionEngine,
    RecentDecisionSummary,
    Reconciler,
    RecordingDecisionEngine,
    RejectedSignalOutcomeEvent,
    RejectingAlpacaClient,
    RiskEngine,
    SQLAlchemyError,
    SellInventoryConflictAlpacaClient,
    SellInventoryConflictRetryClient,
    Sequence,
    Session,
    SignalBatch,
    SignalEnvelope,
    SimpleNamespace,
    SimulationExecutionAdapter,
    Strategy,
    StrategyDecision,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TestCase,
    TimelinePriceFetcher,
    TradeDecision,
    TradingPipeline,
    TradingState,
    TransactionAwareWarmupIngestor,
    UniverseResolver,
    VNextDatasetSnapshot,
    WarmupIngestor,
    _apply_projected_position_decision,
    _build_dspy_lineage,
    _committee_trace_has_veto,
    _default_probabilities,
    is_entry_action_for_strategies,
    is_exit_action_for_strategies,
    _market_context_bundle,
    _project_open_orders_onto_positions,
    _set_llm_guardrails,
    strategy_uses_position_isolation,
    _with_default_executable_quote,
    build_hypothesis_runtime_summary,
    cast,
    create_engine,
    date,
    datetime,
    json,
    os,
    patch,
    select,
    sessionmaker,
    tempfile,
    timedelta,
    timezone,
    uuid4,
)


class TradingPipelineTestCaseBase(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        from app import config

        self._settings_snapshot = {
            name: getattr(config.settings, name)
            for name in (
                "trading_enabled",
                "trading_mode",
                "trading_mode",
                "trading_autonomy_allow_live_promotion",
                "trading_kill_switch_enabled",
                "trading_universe_source",
                "trading_static_symbols_raw",
                "trading_session_context_warmup_signal_limit",
                "trading_session_context_warmup_max_seconds",
                "trading_session_context_warmup_max_signals",
                "trading_feature_quality_enabled",
                "trading_feature_max_staleness_ms",
                "trading_allow_shorts",
                "trading_fractional_equities_enabled",
                "trading_pipeline_mode",
                "trading_simple_submit_enabled",
                "trading_simple_order_feed_telemetry_enabled",
                "trading_order_feed_enabled",
                "trading_order_feed_bootstrap_servers",
                "trading_order_feed_topic",
                "trading_order_feed_topic_v2",
                "trading_order_feed_assignment_mode",
                "trading_order_feed_auto_offset_reset",
                "trading_new_exposure_cutoff_time_et",
                "trading_flatten_start_time_et",
                "trading_flat_confirmation_time_et",
                "trading_universe_static_fallback_enabled",
                "trading_universe_static_fallback_symbols_raw",
                "trading_market_context_url",
                "trading_market_context_timeout_seconds",
                "trading_market_context_required",
                "trading_market_context_fail_mode",
                "trading_market_context_min_quality",
                "trading_market_context_max_staleness_seconds",
                "llm_enabled",
                "llm_min_confidence",
                "llm_adjustment_allowed",
                "llm_fail_mode",
                "llm_fail_mode_enforcement",
                "llm_abstain_fail_mode",
                "llm_escalate_fail_mode",
                "llm_quality_fail_mode",
                "llm_fail_open_live_approved",
                "llm_shadow_mode",
                "llm_allowed_models_raw",
                "llm_evaluation_report",
                "llm_effective_challenge_id",
                "llm_shadow_completed_at",
                "llm_model_version_lock",
                "llm_adjustment_approved",
                "llm_dspy_runtime_mode",
                "llm_dspy_artifact_hash",
                "llm_dspy_program_name",
                "llm_dspy_signature_version",
                "llm_rollout_stage",
                "llm_dspy_live_runtime_block_fail_mode",
                "llm_dspy_live_runtime_block_qty_multiplier",
                "jangar_base_url",
            )
        }
        config.settings.llm_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_new_exposure_cutoff_time_et = time(23, 57)
        config.settings.trading_flatten_start_time_et = time(23, 58)
        config.settings.trading_flat_confirmation_time_et = time(23, 59)

    def tearDown(self) -> None:
        from app import config

        for name, value in self._settings_snapshot.items():
            setattr(config.settings, name, value)

    def _build_rejected_outcome_pipeline(
        self,
        *,
        state: TradingState | None = None,
        session_factory: Callable[[], Session] | None = None,
        price_fetcher: PriceFetcher | None = None,
    ) -> TradingPipeline:
        alpaca_client = FakeAlpacaClient()
        return TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=state or TradingState(),
            account_label="paper",
            session_factory=session_factory or self.session_local,
            price_fetcher=price_fetcher or FakePriceFetcher(Decimal("101.50")),
        )

    @staticmethod
    def _runtime_ledger_weighted_window_payload(
        *, sample_count: int = 1
    ) -> dict[str, object]:
        return {
            "post_cost_promotion_sample_count": sample_count,
            "post_cost_basis_counts": {
                "realized_strategy_pnl_after_explicit_costs": sample_count
            },
            "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
            "runtime_ledger_notional_weighted_sample_count": sample_count,
        }

    def _runtime_ledger_bucket(
        self,
        *,
        run_id: str = "run-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
        observed_stage: str = "live",
        strategy_family: str = "demo",
        post_cost_expectancy_bps: Decimal = Decimal("2.5"),
        bucket_at: datetime | None = None,
    ) -> StrategyRuntimeLedgerBucket:
        observed_at = bucket_at or datetime.now(timezone.utc)
        return StrategyRuntimeLedgerBucket(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            bucket_started_at=observed_at - timedelta(minutes=15),
            bucket_ended_at=observed_at,
            account_label="live",
            runtime_strategy_name=f"runtime-{candidate_id}",
            strategy_family=strategy_family,
            fill_count=1,
            decision_count=1,
            submitted_order_count=1,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("10000"),
            gross_strategy_pnl=Decimal("3.0"),
            cost_amount=Decimal("0.5"),
            net_strategy_pnl_after_costs=Decimal("2.5"),
            post_cost_expectancy_bps=post_cost_expectancy_bps,
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy": 1},
            cost_model_hash_counts={"cost": 1},
            lineage_hash_counts={"lineage": 1},
            blockers_json=[],
            payload_json={
                "run_id": run_id,
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "observed_stage": observed_stage,
                "strategy_family": strategy_family,
                "submitted_order_count": 1,
                "closed_trade_count": 1,
                "open_position_count": 0,
                "filled_notional": "10000",
                "net_strategy_pnl_after_costs": "2.5",
                "post_cost_expectancy_bps": str(post_cost_expectancy_bps),
                "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                "execution_policy_hash_counts": {"policy": 1},
                "cost_model_hash_counts": {"cost": 1},
                "lineage_hash_counts": {"lineage": 1},
                "blockers": [],
            },
        )

    def _seed_promotion_certificate_evidence(
        self,
        *,
        hypothesis_id: str = "H-CONT-01",
        candidate_id: str = "cand-1",
        capital_stage: str = "0.10x canary",
        strategy_family: str = "demo",
        post_cost_expectancy_bps: Decimal = Decimal("2.5"),
        avg_abs_slippage_bps: Decimal = Decimal("1.0"),
        slippage_budget_bps: Decimal = Decimal("5.0"),
    ) -> None:
        evidence_at = datetime.now(timezone.utc)
        with self.session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    observed_stage="live",
                    window_started_at=evidence_at - timedelta(minutes=15),
                    window_ended_at=evidence_at,
                    market_session_count=1,
                    decision_count=1,
                    trade_count=1,
                    order_count=1,
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    post_cost_expectancy_bps=str(post_cost_expectancy_bps),
                    avg_abs_slippage_bps=str(avg_abs_slippage_bps),
                    slippage_budget_bps=str(slippage_budget_bps),
                    capital_stage=capital_stage,
                    payload_json=self._runtime_ledger_weighted_window_payload(),
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    promotion_target="live",
                    state=capital_stage,
                    allowed=True,
                    reason_summary="ready",
                )
            )
            session.add(
                self._runtime_ledger_bucket(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    strategy_family=strategy_family,
                    post_cost_expectancy_bps=post_cost_expectancy_bps,
                    bucket_at=evidence_at,
                )
            )
            session.add(
                StrategyHypothesis(
                    hypothesis_id=hypothesis_id,
                    lane_id=f"lane-{candidate_id}",
                    strategy_family=strategy_family,
                    active=True,
                )
            )
            session.add(
                VNextDatasetSnapshot(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    dataset_id=f"dataset-{candidate_id}",
                    source="historical_market_replay",
                    dataset_version="run-1",
                    artifact_ref=f"s3://torghut/empirical/{candidate_id}",
                )
            )
            session.commit()

    def _build_warmup_pipeline(
        self,
        *,
        ingestor: WarmupIngestor,
        decision_engine: DecisionEngine | None = None,
    ) -> TradingPipeline:
        return TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=ingestor,
            decision_engine=decision_engine or DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

    def _healthy_quant_status(
        self, *, account_label: str = "live"
    ) -> dict[str, object]:
        return {
            "required": True,
            "ok": True,
            "status": "healthy",
            "reason": "ready",
            "blocking_reasons": [],
            "account": account_label,
            "window": "15m",
            "source_url": (
                "http://jangar.test/api/torghut/trading/control-plane/quant/health"
                f"?account={account_label}&window=15m"
            ),
            "latest_metrics_count": 12,
            "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
        }

    def _healthy_live_quant_status(self) -> dict[str, object]:
        return self._healthy_quant_status(account_label="live")


__all__ = (
    "annotations",
    "Literal",
    "AdaptiveExecutionPolicyDecision",
    "Any",
    "Base",
    "Callable",
    "CountingAlpacaClient",
    "CountingLLMReviewEngine",
    "CursorAdvancingFakeIngestor",
    "CursorErrorWarmupIngestor",
    "DSPyReviewRuntime",
    "DSPyRuntimeUnsupportedStateError",
    "Decimal",
    "DecisionEngine",
    "Execution",
    "FakeAlpacaClient",
    "FakeCircuitBreaker",
    "FakeIngestor",
    "FakeLLMReviewEngine",
    "FakePriceFetcher",
    "FetchErrorWarmupIngestor",
    "LLMDecisionContext",
    "LLMDecisionReview",
    "LLMPolicyContext",
    "LLMReviewOutcome",
    "LLMReviewRequest",
    "LLMReviewResponse",
    "Mapping",
    "MarketContextBundle",
    "MarketSnapshot",
    "Mock",
    "NoSignalReasonIngestor",
    "OpenOrderAlpacaClient",
    "OrderExecutor",
    "OrderFirewall",
    "Path",
    "PortfolioSnapshot",
    "PositionSnapshot",
    "PositionedAlpacaClient",
    "PriceFetcher",
    "QuoteQualityStatus",
    "RaisingObserveDecisionEngine",
    "RecentDecisionSummary",
    "Reconciler",
    "RecordingDecisionEngine",
    "RejectedSignalOutcomeEvent",
    "RejectingAlpacaClient",
    "RiskEngine",
    "SQLAlchemyError",
    "SellInventoryConflictAlpacaClient",
    "SellInventoryConflictRetryClient",
    "Sequence",
    "Session",
    "SignalBatch",
    "SignalEnvelope",
    "SimpleNamespace",
    "SimulationExecutionAdapter",
    "Strategy",
    "StrategyDecision",
    "StrategyHypothesis",
    "StrategyHypothesisMetricWindow",
    "StrategyPromotionDecision",
    "StrategyRuntimeLedgerBucket",
    "TestCase",
    "TimelinePriceFetcher",
    "TradeDecision",
    "TradingPipeline",
    "TradingState",
    "TransactionAwareWarmupIngestor",
    "UniverseResolver",
    "VNextDatasetSnapshot",
    "WarmupIngestor",
    "_apply_projected_position_decision",
    "_build_dspy_lineage",
    "_committee_trace_has_veto",
    "_default_probabilities",
    "is_entry_action_for_strategies",
    "is_exit_action_for_strategies",
    "_market_context_bundle",
    "_project_open_orders_onto_positions",
    "_set_llm_guardrails",
    "strategy_uses_position_isolation",
    "_with_default_executable_quote",
    "build_hypothesis_runtime_summary",
    "cast",
    "create_engine",
    "date",
    "datetime",
    "json",
    "os",
    "patch",
    "select",
    "sessionmaker",
    "tempfile",
    "timedelta",
    "timezone",
    "uuid4",
    "TradingPipelineTestCaseBase",
)
