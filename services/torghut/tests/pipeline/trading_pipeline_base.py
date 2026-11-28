from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Callable, Literal, Sequence
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app import config
from app.models import (
    Base,
    EvidenceEpochRecord,
    Strategy,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    VNextDatasetSnapshot,
)
from app.strategies.catalog import extract_catalog_metadata
from app.trading.decisions import DecisionEngine
from app.trading.execution import OrderExecutor
from app.trading.firewall import OrderFirewall
from app.trading.prices import PriceFetcher
from app.trading.reconcile import Reconciler
from app.trading.risk import RiskEngine
from app.trading.scheduler.pipeline import TradingPipeline
from app.trading.scheduler.state import TradingState
from app.trading.strategy_capital_authority import (
    AuthorityProofBindings,
    CapitalAccountMode,
    CapitalSessionWindow,
    CapitalStage,
    CapitalVenue,
    StrategyCapitalAuthority,
    canonical_payload_digest,
)
from app.trading.strategy_capital_authority_store import (
    activate_strategy_capital_authority,
)
from app.trading.universe import UniverseResolver
from tests.pipeline.trading_pipeline_support import (
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    WarmupIngestor,
)
from tests.trading_fixtures import make_strategy


class TradingPipelineTestCaseBase(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        self.configure_settings(
            llm_enabled=False,
            trading_kill_switch_enabled=False,
            trading_new_exposure_cutoff_time_et=time(23, 57),
            trading_flatten_start_time_et=time(23, 58),
            trading_flat_confirmation_time_et=time(23, 59),
        )
        self.enterContext(
            patch.multiple(
                "app.trading.strategy_capital_runtime",
                BUILD_COMMIT="a" * 40,
                BUILD_IMAGE_DIGEST="sha256:" + "a" * 64,
            )
        )

    def configure_settings(self, **overrides: object) -> None:
        self.enterContext(patch.multiple(config.settings, **overrides))

    def configure_llm_guardrails(self, *, adjustment_approved: bool = False) -> None:
        self.configure_settings(
            llm_allowed_models_raw=config.settings.llm_model,
            llm_evaluation_report="eval-2026-02-08",
            llm_effective_challenge_id="mrm-review-2026-02-08",
            llm_shadow_completed_at="2026-02-08T00:00:00Z",
            llm_model_version_lock=config.settings.llm_model,
            llm_adjustment_approved=adjustment_approved,
        )

    def seed_demo_strategy(self, **overrides: object) -> None:
        fields = {
            "description": "demo",
            "max_notional_per_trade": Decimal("1000"),
        }
        with self.session_local() as session:
            session.add(make_strategy(name="demo", **(fields | overrides)))
            session.commit()

    def make_pipeline(self, **overrides: object) -> TradingPipeline:
        # Build a fresh set of collaborators for each pipeline. Do not
        # share fake client state between the read, firewall and submit paths.
        defaults = dict(
            alpaca_client=FakeAlpacaClient,
            order_firewall=lambda: OrderFirewall(FakeAlpacaClient()),
            ingestor=lambda: FakeIngestor([]),
            decision_engine=DecisionEngine,
            risk_engine=RiskEngine,
            executor=OrderExecutor,
            execution_adapter=FakeAlpacaClient,
            reconciler=Reconciler,
            universe_resolver=UniverseResolver,
            state=TradingState,
            account_label=lambda: "paper",
            session_factory=lambda: self.session_local,
        )
        collaborators = {
            key: factory() for key, factory in defaults.items() if key not in overrides
        }
        return TradingPipeline(**collaborators, **overrides)

    def _activate_test_capital_authority(
        self,
        session: Session,
        *,
        strategy: Strategy,
        account_mode: Literal["paper", "live"] = "paper",
        account_label: str | None = None,
        symbols: Sequence[str] | None = None,
    ) -> StrategyCapitalAuthority:
        """Issue an explicit bounded grant for tests that intentionally submit."""

        now = datetime.now(timezone.utc)
        digest = "sha256:" + "a" * 64
        evidence_epoch_id = f"tee-{uuid4().hex}"
        evidence_fresh_until = now + timedelta(hours=2)
        evidence_stage_scope = "paper" if account_mode == "paper" else "live"
        evidence_decision = (
            "paper_allowed" if account_mode == "paper" else "live_allowed"
        )
        evidence_payload = {
            "schema_version": "torghut.evidence-epoch.v1",
            "evidence_epoch_id": evidence_epoch_id,
            "account_label": account_label or account_mode,
            "stage_scope": evidence_stage_scope,
            "created_at": now.isoformat(),
            "fresh_until": evidence_fresh_until.isoformat(),
            "decision": evidence_decision,
            "reason_codes": [],
            "receipt_ids": [],
            "receipts": [],
        }
        session.add(
            EvidenceEpochRecord(
                evidence_epoch_id=evidence_epoch_id,
                account_label=account_label or account_mode,
                stage_scope=evidence_stage_scope,
                decision=evidence_decision,
                fresh_until=evidence_fresh_until,
                reason_codes_json=[],
                receipt_ids_json=[],
                payload_json=evidence_payload,
            )
        )
        candidate_ref = str(
            extract_catalog_metadata(strategy.description).get("strategy_id")
            or strategy.name
        ).strip()
        authority = StrategyCapitalAuthority(
            authority_id=f"test-{strategy.name}-{account_mode}-v1",
            strategy_ref=strategy.name,
            candidate_ref=candidate_ref,
            evidence_epoch_id=evidence_epoch_id,
            stage=(
                CapitalStage.PAPER_PROBATION
                if account_mode == "paper"
                else CapitalStage.CAPITAL_ALLOWED
            ),
            account_label=account_label or account_mode,
            account_mode=CapitalAccountMode(account_mode),
            venue=CapitalVenue.ALPACA,
            allowed_symbols=tuple(symbols or strategy.universe_symbols or ()),
            max_order_notional=Decimal("1000000"),
            max_gross_notional=Decimal("10000000"),
            max_net_notional=Decimal("10000000"),
            max_loss=Decimal("1000000"),
            max_orders_per_minute=100,
            max_orders_per_session=10000,
            session=CapitalSessionWindow(
                timezone_name="UTC",
                weekdays=(0, 1, 2, 3, 4, 5, 6),
                start=time(0, 0),
                end=time(23, 59, 59),
            ),
            issued_at=now - timedelta(hours=1),
            expires_at=now + timedelta(hours=1),
            proofs=AuthorityProofBindings(
                policy_digest=digest,
                evidence_digest=canonical_payload_digest(evidence_payload),
                code_commit="a" * 40,
                image_digest=digest,
                data_digest=digest,
                execution_digest=digest,
            ),
            issued_by="test-research-owner",
            approved_by="test-risk-owner",
            reduce_only=False,
        )
        activate_strategy_capital_authority(
            session,
            strategy=strategy,
            authority=authority,
        )
        return authority

    @staticmethod
    def _prime_test_capital_state(state: TradingState) -> None:
        state.capital_daily_start_equity = Decimal("100000")
        state.capital_current_equity = Decimal("100000")

    def _build_rejected_outcome_pipeline(
        self,
        *,
        state: TradingState | None = None,
        session_factory: Callable[[], Session] | None = None,
        price_fetcher: PriceFetcher | None = None,
    ) -> TradingPipeline:
        alpaca_client = FakeAlpacaClient()
        return self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            execution_adapter=alpaca_client,
            state=state or TradingState(),
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
        return self.make_pipeline(
            ingestor=ingestor,
            decision_engine=decision_engine or DecisionEngine(),
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
