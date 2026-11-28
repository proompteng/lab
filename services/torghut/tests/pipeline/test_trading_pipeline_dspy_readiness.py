from __future__ import annotations

from unittest.mock import patch

from sqlalchemy import select

from app.models import Execution, LLMDecisionReview, TradeDecision
from app.trading.llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from app.trading.scheduler.pipeline import TradingPipeline
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    CountingLLMReviewEngine,
    FakeIngestor,
    FakeLLMReviewEngine,
)
from tests.trading_fixtures import macd_buy_signal


class TestTradingPipelineDspyReadiness(TradingPipelineTestCaseBase):
    def test_pipeline_llm_unsupported_runtime_state_vetoes_decision(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="pass_through",
            llm_fail_mode_enforcement="configured",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        self.configure_settings(
            trading_mode="paper",
        )
        pipeline = self.make_pipeline(
            ingestor=FakeIngestor([signal]),
            llm_review_engine=FakeLLMReviewEngine(
                error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
            ),
        )

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
            self.assertEqual(reviews[0].response_json.get("effective_verdict"), "veto")
            self.assertEqual(len(executions), 0)

    def test_pipeline_llm_unsupported_runtime_state_vetoes_decision_in_shadow_mode(
        self,
    ) -> None:
        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_runtime_disabled",)

        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=True,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine(
            error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
        )
        with patch(
            "app.trading.scheduler.pipeline.llm_review.DSPyReviewRuntime.from_settings",
            return_value=_UnavailableLiveRuntime(),
        ):
            pipeline = self.make_pipeline(
                ingestor=FakeIngestor([signal]),
                account_label="live",
                llm_review_engine=engine,
            )
            self._seed_promotion_certificate_evidence()
            pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
            self.assertEqual(reviews[0].response_json.get("effective_verdict"), "veto")
            self.assertEqual(len(executions), 0)
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_dspy_live_runtime_gate_allows_live_path(self) -> None:
        class _AvailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return True, ()

        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_abstain_fail_mode="veto",
            llm_escalate_fail_mode="veto",
            llm_quality_fail_mode="veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        with patch(
            "app.trading.scheduler.pipeline.llm_review.DSPyReviewRuntime.from_settings",
            return_value=_AvailableLiveRuntime(),
        ):
            pipeline = self.make_pipeline(
                ingestor=FakeIngestor([signal]),
                account_label="live",
                llm_review_engine=engine,
            )
        self._seed_promotion_certificate_evidence()
        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_dspy_live_runtime_readiness_blocked_without_dspy_live_artifact(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()

        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_active_mode_requires_dspy_live_executor",)

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        with patch(
            "app.trading.scheduler.pipeline.llm_review.DSPyReviewRuntime.from_settings",
            return_value=_UnavailableLiveRuntime(),
        ):
            pipeline = self.make_pipeline(
                ingestor=FakeIngestor([signal]),
                account_label="live",
                llm_review_engine=engine,
            )
            pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_when_stage_not_stage3(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_autonomy_allow_live_promotion=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage2",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        pipeline = self.make_pipeline(
            ingestor=FakeIngestor([signal]),
            account_label="live",
            llm_review_engine=engine,
        )

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(len(decisions), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(
                reviews[0].response_json.get("llm_runtime", {}).get("subtype"),
                "policy_blocked",
            )
            self.assertEqual(
                decisions[0].decision_json.get("llm_runtime", {}).get("subtype"),
                "policy_blocked",
            )
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()
        self.configure_settings(
            llm_model_version_lock="mismatch-model:v2",
        )

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        pipeline = self.make_pipeline(
            ingestor=FakeIngestor([signal]),
            account_label="live",
            llm_review_engine=engine,
        )

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            llm_runtime = reviews[0].response_json.get("llm_runtime", {})
            self.assertEqual(
                llm_runtime.get("reject_reason"),
                "llm_runtime_fallback_policy_blocked",
            )
            self.assertEqual(llm_runtime.get("subtype"), "policy_blocked")
            self.assertIsInstance(llm_runtime.get("primary_reason"), str)
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_classify_dspy_live_runtime_block_distinguishes_artifact_and_runtime_causes(
        self,
    ) -> None:
        artifact = TradingPipeline._classify_dspy_live_runtime_block(
            ("dspy_bootstrap_artifact_forbidden",)
        )
        runtime = TradingPipeline._classify_dspy_live_runtime_block(
            ("dspy_live_readiness_error:TimeoutError",)
        )

        self.assertEqual(
            artifact, ("llm_runtime_fallback_artifact_invalid", "artifact_invalid")
        )
        self.assertEqual(
            runtime, ("llm_runtime_fallback_runtime_not_ready", "runtime_not_ready")
        )

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_malformed_artifact_hash(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            llm_dspy_artifact_hash="not-a-valid-hex-hash",
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        with patch(
            "app.trading.scheduler.pipeline.llm_review.DSPyReviewRuntime.from_settings"
        ) as from_settings:
            pipeline = self.make_pipeline(
                ingestor=FakeIngestor([signal]),
                account_label="live",
            )
            pipeline.run_once()
            from_settings.assert_not_called()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(len(executions), 0)

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_before_readiness_probe(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            llm_dspy_artifact_hash="a" * 64,
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()
        self.configure_settings(
            llm_model_version_lock="mismatch-model:v2",
        )

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        with patch(
            "app.trading.scheduler.pipeline.llm_review.DSPyReviewRuntime.from_settings"
        ) as from_settings:
            pipeline = self.make_pipeline(
                ingestor=FakeIngestor([signal]),
                account_label="live",
                llm_review_engine=engine,
            )
            pipeline.run_once()
            from_settings.assert_not_called()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(
                reviews[0].rationale,
                "llm_dspy_live_runtime_gate_blocked",
            )
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_bootstrap_artifact_hash(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="live",
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_fail_mode="veto",
            llm_fail_mode_enforcement="strict_veto",
            llm_shadow_mode=False,
            llm_min_confidence=0.0,
            llm_dspy_runtime_mode="active",
            jangar_base_url="http://jangar.test",
            llm_dspy_artifact_hash=DSPyReviewRuntime.bootstrap_artifact_hash(),
            llm_rollout_stage="stage3",
        )
        self.configure_llm_guardrails()

        self.seed_demo_strategy()

        signal = macd_buy_signal()

        engine = CountingLLMReviewEngine()
        pipeline = self.make_pipeline(
            ingestor=FakeIngestor([signal]),
            account_label="live",
            llm_review_engine=engine,
        )

        pipeline.run_once()

        with self.session_local() as session:
            reviews = session.execute(select(LLMDecisionReview)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(reviews), 1)
            self.assertEqual(reviews[0].verdict, "error")
            self.assertEqual(reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked")
            self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
            self.assertEqual(len(executions), 0)
            self.assertEqual(engine.review_calls, 0)
