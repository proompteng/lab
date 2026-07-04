from __future__ import annotations


from tests.submission_council.support import (
    Base,
    Decimal,
    JangarDependencyQuorumStatus,
    SQLAlchemyError,
    SimpleNamespace,
    StaticPool,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    SubmissionCouncilTestCase,
    _certificate_evidence_authority_score,
    _certificate_evidence_selection_key,
    _load_latest_certificate_evidence,
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    create_engine,
    datetime,
    patch,
    sessionmaker,
    settings,
    timedelta,
    timezone,
)


class TestSubmissionCouncilHypothesisRuntimeSummaryA(SubmissionCouncilTestCase):
    def test_hypothesis_runtime_summary_uses_fresh_imported_runtime_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing", "post_cost_expectancy_below_edge"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 1)
        self.assertEqual(result["paper_probation_eligible_total"], 0)
        item = result["items"][0]
        self.assertTrue(item["promotion_eligible"])
        self.assertEqual(item["candidate_id"], "cand-runtime")
        self.assertEqual(item["capital_stage"], "0.10x canary")
        self.assertEqual(item["reasons"], [])
        self.assertEqual(item["observed"]["metric_window_decision_count"], 42)
        self.assertEqual(
            item["observed"]["runtime_window_prior_reasons"],
            ["drift_checks_missing", "post_cost_expectancy_below_edge"],
        )
        self.assertEqual(
            item["informational_reasons"],
            ["runtime_window_certificate_applied"],
        )

    def test_hypothesis_runtime_summary_prefers_stronger_runtime_certificate_candidate(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-good",
                    candidate_id="cand-good",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=15),
                    window_ended_at=now - timedelta(minutes=5),
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-good",
                    candidate_id="cand-good",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-good",
                    candidate_id="cand-good",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now - timedelta(minutes=5),
                )
            )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-blocked",
                    candidate_id="cand-blocked-newer",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=10),
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=0,
                    trade_count=0,
                    order_count=0,
                    avg_abs_slippage_bps="0",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="0",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 0,
                        "post_cost_basis_counts": {},
                        "post_cost_expectancy_aggregation": "no_promotion_grade_post_cost_rows",
                        "runtime_ledger_notional_weighted_sample_count": 0,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-blocked",
                    candidate_id="cand-blocked-newer",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=False,
                    reason_summary="runtime_decision_count_zero,runtime_order_count_zero",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 1)
        item = result["items"][0]
        self.assertTrue(item["promotion_eligible"])
        self.assertEqual(item["candidate_id"], "cand-good")
        self.assertEqual(item["capital_stage"], "0.10x canary")
        self.assertEqual(item["reasons"], [])

    def test_hypothesis_runtime_summary_keeps_paper_probation_when_newer_live_lacks_ledger(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-paper",
                    candidate_id="cand-paper",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now - timedelta(minutes=30),
                    window_ended_at=now - timedelta(minutes=20),
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-paper",
                    candidate_id="cand-paper",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="shadow",
                    allowed=True,
                    reason_summary="paper_runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-live-missing-ledger",
                    candidate_id="cand-live-missing-ledger",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=10),
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-live-missing-ledger",
                    candidate_id="cand-live-missing-ledger",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        self.assertEqual(result["paper_probation_eligible_total"], 1)
        item = result["items"][0]
        self.assertEqual(item["candidate_id"], "cand-paper")
        self.assertFalse(item["promotion_eligible"])
        self.assertTrue(item["paper_probation_eligible"])
        self.assertEqual(item["reasons"], ["paper_probation_evidence_collection_only"])
        self.assertNotIn(
            "runtime_ledger_proof_missing",
            item["observed"].get("runtime_window_rejection_reasons", []),
        )

    def test_certificate_evidence_selection_key_handles_unknown_or_missing_window(
        self,
    ) -> None:
        self.assertEqual(
            _certificate_evidence_authority_score(
                observed_stage="shadow",
                runtime_ledger_bucket=None,
            ),
            0,
        )
        self.assertEqual(
            _certificate_evidence_selection_key(
                {},
                now=datetime.now(timezone.utc),
                max_age_seconds=3600,
            ),
            (0, 0, 0, 0, 0, 0, 0, 0, Decimal("0"), 0.0),
        )

    def test_build_live_submission_gate_payload_rescues_stale_summary_with_session_live_runtime_evidence(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600

        class _RegistryItem:
            hypothesis_id = "H-CONT-01"

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "cand-live",
                    "strategy_id": "intraday_continuation",
                    "strategy_family": "intraday_continuation",
                    "lane_id": "continuation",
                    "dataset_snapshot_ref": "snap-live-runtime-proof",
                    "segment_dependencies": [],
                }

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[_RegistryItem()],
        )
        stale_runtime_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "strategy_id": "intraday_continuation",
            "lane_id": "continuation",
            "strategy_family": "intraday_continuation",
            "state": "shadow",
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }

        with session_local() as session:
            session.add(
                StrategyHypothesis(
                    hypothesis_id="H-CONT-01",
                    lane_id="continuation",
                    strategy_family="intraday_continuation",
                    source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                    active=True,
                    payload_json={},
                )
            )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-live",
                    candidate_id="cand-live",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=15),
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-live",
                    candidate_id="cand-live",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-live",
                    candidate_id="cand-live",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            with patch(
                "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=False,
                        last_autonomy_promotion_eligible=True,
                        last_autonomy_promotion_action="promote",
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "paper_probation_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "reason_totals": {"drift_checks_missing": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [stale_runtime_item],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    session=session,
                    clickhouse_ta_status={
                        "state": "current",
                        "source_ref": "torghut.ta_signals",
                        "signal_rows": 12,
                        "symbol_count": 6,
                    },
                )

        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["promotion_eligible_total"], 1)
        self.assertEqual(gate["reason"], "operational_submission_ready")
        self.assertEqual(gate["capital_stage"], "live")
        self.assertIsNone(gate["evidence_tuple"]["candidate_id"])
        self.assertNotIn("hypothesis_not_promotion_eligible", gate["blocked_reasons"])

    def test_load_latest_certificate_evidence_skips_mismatched_runtime_ledger_bucket(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-wrong",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now + timedelta(seconds=1),
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    strategy_family="mean_reversion",
                    bucket_at=now + timedelta(seconds=1),
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            evidence = _load_latest_certificate_evidence(
                session,
                hypothesis_ids=["H-CONT-01"],
            )

        self.assertEqual(len(evidence), 1)
        runtime_ledger_bucket = evidence[0]["runtime_ledger_bucket"]
        self.assertIsInstance(runtime_ledger_bucket, dict)
        self.assertEqual(runtime_ledger_bucket["run_id"], "runtime-proof-1")
        self.assertEqual(
            runtime_ledger_bucket["strategy_family"], "intraday_continuation"
        )

    def test_load_latest_certificate_evidence_fails_closed_when_runtime_ledger_scan_times_out(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            with patch(
                "app.trading.submission_council.certificate_loading._maybe_set_runtime_ledger_status_statement_timeout",
                side_effect=SQLAlchemyError("statement timeout"),
            ):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-CONT-01"],
                )

        self.assertEqual(len(evidence), 1)
        self.assertIsNone(evidence[0]["runtime_ledger_bucket"])
