from __future__ import annotations

from tests.autonomous_lane.autonomous_lane_support import (
    AutonomousLaneTestCaseBase,
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_SCHEMA_VERSION,
    Decimal,
    Path,
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchValidationTest,
    SignalEnvelope,
    SignalFeatures,
    SimpleNamespace,
    StrategyDecision,
    VNextPromotionDecision,
    WalkForwardDecision,
    _STRESS_METRICS_CASES,
    _deterministic_run_id,
    _resolve_gate_forecast_metrics,
    _resolve_gate_fragility_inputs,
    _resolve_hypothesis_window_evidence,
    datetime,
    json,
    os,
    patch,
    run_autonomous_lane,
    select,
    tempfile,
    timezone,
)


class TestAutonomousLaneEvidence(AutonomousLaneTestCaseBase):
    def test_runtime_observation_evidence_blocks_simulation_without_ledger_profit_proof(
        self,
    ) -> None:
        _, _, capital_stage, qualification = _resolve_hypothesis_window_evidence(
            promotion_target="paper",
            runtime_observation_payload={
                "authoritative": True,
                "observed_stage": "paper",
                "evidence_provenance": "paper_runtime_observed",
                "source_kind": "simulation_paper_runtime",
            },
            effective_promotion_allowed=True,
            order_count=24,
            min_sample_count_for_scale_up=20,
        )

        self.assertEqual(capital_stage, "shadow")
        self.assertEqual(
            qualification["qualification_reason"],
            "simulation_source_replay_only",
        )
        self.assertEqual(
            qualification["runtime_observation_has_runtime_ledger_profit_proof"],
            False,
        )
        self.assertFalse(qualification["qualified_runtime_observation"])

    def test_runtime_observation_evidence_keeps_artifact_counts_diagnostic_only(
        self,
    ) -> None:
        provenance, maturity, capital_stage, qualification = (
            _resolve_hypothesis_window_evidence(
                promotion_target="paper",
                runtime_observation_payload={
                    "authoritative": True,
                    "observed_stage": "paper",
                    "evidence_provenance": "paper_runtime_observed",
                    "source_kind": "simulation_exact_replay_runtime_ledger",
                    "runtime_ledger_artifact_row_count": 8,
                    "runtime_ledger_artifact_fill_count": 2,
                },
                effective_promotion_allowed=True,
                order_count=24,
                min_sample_count_for_scale_up=20,
            )
        )

        self.assertEqual(provenance, "historical_market_replay")
        self.assertEqual(maturity, "calibrated")
        self.assertEqual(capital_stage, "shadow")
        self.assertEqual(
            qualification["runtime_observation_has_runtime_ledger_profit_proof"],
            False,
        )
        self.assertFalse(qualification["qualified_runtime_observation"])
        self.assertEqual(
            qualification["qualification_reason"],
            "simulation_source_replay_only",
        )

    def test_runtime_observation_evidence_keeps_simulation_replay_only_with_explicit_ledger_profit_proof_flag(
        self,
    ) -> None:
        provenance, _, _, qualification = _resolve_hypothesis_window_evidence(
            promotion_target="paper",
            runtime_observation_payload={
                "authoritative": True,
                "observed_stage": "paper",
                "evidence_provenance": "paper_runtime_observed",
                "source_kind": "simulation_exact_replay_runtime_ledger",
                "runtime_ledger_profit_proof_present": True,
            },
            effective_promotion_allowed=False,
            order_count=0,
            min_sample_count_for_scale_up=20,
        )

        self.assertEqual(provenance, "historical_market_replay")
        self.assertEqual(
            qualification["runtime_observation_has_runtime_ledger_profit_proof"],
            True,
        )
        self.assertFalse(qualification["qualified_runtime_observation"])
        self.assertEqual(
            qualification["qualification_reason"],
            "simulation_source_replay_only",
        )

    def test_gate_forecast_metrics_fail_closed_for_non_authoritative_router_outputs(
        self,
    ) -> None:
        signals = [
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": "0.6", "signal": "0.2"},
                    "rsi14": "42",
                    "price": "100",
                },
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": "0.7", "signal": "0.1"},
                    "rsi14": "48",
                    "price": "101",
                },
            ),
        ]

        metrics = _resolve_gate_forecast_metrics(signals=signals)

        self.assertEqual(metrics, {})

    def test_gate_forecast_metrics_accept_authoritative_router_outputs(self) -> None:
        signals = [
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": "0.6", "signal": "0.2"},
                    "rsi14": "42",
                    "price": "100",
                },
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": "0.7", "signal": "0.1"},
                    "rsi14": "48",
                    "price": "101",
                },
            ),
        ]

        authoritative_contract = SimpleNamespace(
            fallback=SimpleNamespace(applied=False),
            inference_latency_ms=42,
            calibration_score=Decimal("0.93"),
            promotion_authority_eligible=True,
            to_payload=lambda: {
                "artifact_authority": {
                    "provenance": "historical_market_replay",
                    "maturity": "empirically_validated",
                    "authoritative": True,
                    "placeholder": False,
                }
            },
        )
        authoritative_router = SimpleNamespace(
            route_and_forecast=lambda **_: SimpleNamespace(
                contract=authoritative_contract
            )
        )

        with patch(
            "app.trading.autonomy.lane_gate_inputs.build_default_forecast_router",
            return_value=authoritative_router,
        ):
            metrics = _resolve_gate_forecast_metrics(signals=signals)

        self.assertIn("fallback_rate", metrics)
        self.assertIn("inference_latency_ms_p95", metrics)
        self.assertIn("calibration_score_min", metrics)
        self.assertGreaterEqual(Decimal(metrics["fallback_rate"]), Decimal("0"))
        self.assertLessEqual(Decimal(metrics["fallback_rate"]), Decimal("1"))
        self.assertGreaterEqual(int(metrics["inference_latency_ms_p95"]), 1)
        self.assertGreaterEqual(Decimal(metrics["calibration_score_min"]), Decimal("0"))

    def test_gate_fragility_inputs_are_derived_from_decision_payloads(self) -> None:
        decisions = [
            WalkForwardDecision(
                decision=StrategyDecision(
                    strategy_id="s1",
                    symbol="AAPL",
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    order_type="market",
                    time_in_force="day",
                    params={
                        "allocator": {
                            "fragility_state": "crisis",
                            "fragility_score": "0.92",
                            "stability_mode_active": True,
                        }
                    },
                ),
                features=SignalFeatures(
                    macd=None,
                    macd_signal=None,
                    rsi=None,
                    price=None,
                    volatility=None,
                ),
            )
        ]

        state, score, stability, inputs_valid = _resolve_gate_fragility_inputs(
            metrics_payload={}, decisions=decisions
        )

        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("0.92"))
        self.assertTrue(stability)
        self.assertTrue(inputs_valid)

    def test_gate_fragility_inputs_fail_closed_on_missing_or_invalid_values(
        self,
    ) -> None:
        state, score, stability, inputs_valid = _resolve_gate_fragility_inputs(
            metrics_payload={}, decisions=[]
        )
        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("1"))
        self.assertFalse(stability)
        self.assertFalse(inputs_valid)

        state, score, stability, inputs_valid = _resolve_gate_fragility_inputs(
            metrics_payload={},
            decisions=[
                WalkForwardDecision(
                    decision=StrategyDecision(
                        strategy_id="s1",
                        symbol="AAPL",
                        event_ts=datetime.now(timezone.utc),
                        timeframe="1Min",
                        action="buy",
                        qty=Decimal("1"),
                        order_type="market",
                        time_in_force="day",
                        params={
                            "allocator": {
                                "fragility_state": "not-a-state",
                                "fragility_score": "maybe",
                                "stability_mode_active": "n/a",
                            }
                        },
                    ),
                    features=SignalFeatures(
                        macd=None,
                        macd_signal=None,
                        rsi=None,
                        price=None,
                        volatility=None,
                    ),
                )
            ],
        )
        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("1"))
        self.assertFalse(stability)
        self.assertFalse(inputs_valid)

    def test_lane_emits_gate_report_and_paper_patch(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )
        strategy_configmap_path = (
            Path(__file__).parents[4]
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane"
            session_factory = self._empty_session_factory()
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                strategy_configmap_path=strategy_configmap_path,
                session_factory=session_factory,
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertIn("gates", gate_payload)
            self.assertNotEqual(gate_payload["recommended_mode"], "paper")
            self.assertIn("dependency_quorum", gate_payload)
            self.assertIn("alpha_readiness", gate_payload)
            self.assertIn("promotion_evidence", gate_payload)
            self.assertIn("promotion_decision", gate_payload)
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            evidence = gate_payload["promotion_evidence"]
            self.assertEqual(evidence["fold_metrics"]["count"], 1)
            self.assertEqual(
                evidence["stress_metrics"]["count"], len(_STRESS_METRICS_CASES)
            )
            self.assertEqual(
                evidence["stress_metrics"]["artifact_ref"],
                str(output_dir / "gates" / "stress-metrics-v1.json"),
            )
            self.assertEqual(
                evidence["benchmark_parity"]["artifact_ref"],
                str(output_dir / "gates" / "benchmark-parity-report-v1.json"),
            )
            self.assertEqual(
                evidence["deeplob_bdlob_contract"]["artifact_ref"],
                str(output_dir / "microstructure" / "deeplob-bdlob-report-v1.json"),
            )
            self.assertEqual(
                evidence["advisor_fallback_slo"]["artifact_ref"],
                str(output_dir / "execution" / "advisor-fallback-slo-report-v1.json"),
            )
            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertIn("dependency_quorum", candidate_spec)
            self.assertIn("alpha_readiness", candidate_spec)
            self.assertEqual(
                evidence["contamination_registry"]["artifact_ref"],
                str(output_dir / "gates" / "contamination-leakage-report-v1.json"),
            )
            self.assertEqual(
                evidence["hmm_state_posterior"]["artifact_ref"],
                str(output_dir / "gates" / "hmm-state-posterior-v1.json"),
            )
            self.assertEqual(
                evidence["expert_router_registry"]["artifact_ref"],
                str(output_dir / "gates" / "expert-router-registry-v1.json"),
            )
            self.assertTrue((output_dir / "gates" / "stress-metrics-v1.json").exists())
            self.assertTrue(
                (output_dir / "gates" / "benchmark-parity-report-v1.json").exists()
            )
            self.assertTrue(
                (
                    output_dir / "microstructure" / "deeplob-bdlob-report-v1.json"
                ).exists()
            )
            self.assertTrue(
                (
                    output_dir / "execution" / "advisor-fallback-slo-report-v1.json"
                ).exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "contamination-leakage-report-v1.json").exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "hmm-state-posterior-v1.json").exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "expert-router-registry-v1.json").exists()
            )
            hmm_state_posterior_payload = json.loads(
                (output_dir / "gates" / "hmm-state-posterior-v1.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                hmm_state_posterior_payload["schema_version"],
                "hmm-state-posterior-v1",
            )
            self.assertIn("source_lineage", hmm_state_posterior_payload)
            self.assertEqual(
                result.benchmark_parity_path,
                output_dir / "gates" / "benchmark-parity-report-v1.json",
            )
            benchmark_parity_payload = json.loads(
                result.benchmark_parity_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                benchmark_parity_payload["schema_version"],
                BENCHMARK_PARITY_SCHEMA_VERSION,
            )
            self.assertEqual(
                set(BENCHMARK_PARITY_REQUIRED_SCORECARDS),
                set(benchmark_parity_payload.get("scorecards", {}).keys()),
            )
            self.assertEqual(
                set(BENCHMARK_PARITY_REQUIRED_FAMILIES),
                {
                    str(run.get("family"))
                    for run in benchmark_parity_payload.get("benchmark_runs", [])
                    if isinstance(run, dict)
                },
            )
            for required_run in BENCHMARK_PARITY_REQUIRED_RUN_FIELDS:
                for run in benchmark_parity_payload.get("benchmark_runs", []):
                    self.assertIn(required_run, run)
            self.assertIn("janus_q", evidence)
            self.assertEqual(evidence["janus_q"]["event_car"]["count"], 3)
            self.assertEqual(evidence["janus_q"]["hgrm_reward"]["count"], 3)
            self.assertTrue(
                bool(evidence["promotion_rationale"].get("recommendation_trace_id"))
            )
            self.assertTrue(
                (output_dir / "gates" / "profitability-benchmark-v4.json").exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "profitability-evidence-v4.json").exists()
            )
            self.assertTrue(
                (
                    output_dir / "gates" / "profitability-evidence-validation.json"
                ).exists()
            )
            self.assertTrue((output_dir / "gates" / "janus-event-car-v1.json").exists())
            self.assertTrue(
                (output_dir / "gates" / "janus-hgrm-reward-v1.json").exists()
            )
            self.assertTrue((output_dir / "gates" / "actuation-intent.json").exists())
            self.assertTrue(
                (output_dir / "gates" / "promotion-evidence-gate.json").exists()
            )
            self.assertIsNone(result.paper_patch_path)
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertEqual(
                actuation_payload["schema_version"],
                "torghut.autonomy.actuation-intent.v1",
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            governance_payload = actuation_payload["governance"]
            self.assertEqual(governance_payload["repository"], "proompteng/lab")
            self.assertEqual(governance_payload["base"], "main")
            self.assertTrue(governance_payload["head"].startswith("agentruns/"))
            self.assertEqual(governance_payload["artifact_path"], str(output_dir))
            self.assertEqual(governance_payload["change"], "autonomous-promotion")
            self.assertEqual(
                governance_payload["reason"],
                "Autonomous recommendation for paper target.",
            )
            self.assertIsNone(governance_payload["priority_id"])
            self.assertIn("artifact_refs", actuation_payload)
            self.assertTrue(
                str(output_dir / "gates" / "profitability-evidence-v4.json")
                in actuation_payload["artifact_refs"]
            )
            self.assertIn(
                str(output_dir / "gates" / "rollback-readiness.json"),
                actuation_payload["artifact_refs"],
            )
            self.assertIn(
                str(output_dir / "gates" / "stress-metrics-v1.json"),
                actuation_payload["artifact_refs"],
            )
            self.assertIn(
                str(output_dir / "gates" / "benchmark-parity-report-v1.json"),
                actuation_payload["artifact_refs"],
            )

    def test_lane_promotion_stress_artifact_ref_uses_output_dir_relative_path(
        self,
    ) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )
        strategy_configmap_path = (
            Path(__file__).parents[4]
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            original_cwd = Path.cwd()
            os.chdir(tmpdir)
            try:
                output_dir = Path("lane")
                session_factory = self._empty_session_factory()
                result = run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    strategy_configmap_path=strategy_configmap_path,
                    session_factory=session_factory,
                    code_version="test-sha",
                )
                gate_payload = json.loads(
                    result.gate_report_path.read_text(encoding="utf-8")
                )
                self.assertIn("promotion_evidence", gate_payload)
                evidence = gate_payload["promotion_evidence"]
                self.assertEqual(
                    evidence["stress_metrics"]["artifact_ref"],
                    str(Path("gates") / "stress-metrics-v1.json"),
                )
                self.assertEqual(
                    evidence["benchmark_parity"]["artifact_ref"],
                    str(Path("gates") / "benchmark-parity-report-v1.json"),
                )
                self.assertEqual(
                    evidence["deeplob_bdlob_contract"]["artifact_ref"],
                    str(Path("microstructure") / "deeplob-bdlob-report-v1.json"),
                )
                self.assertEqual(
                    evidence["advisor_fallback_slo"]["artifact_ref"],
                    str(Path("execution") / "advisor-fallback-slo-report-v1.json"),
                )
                self.assertEqual(
                    evidence["contamination_registry"]["artifact_ref"],
                    str(Path("gates") / "contamination-leakage-report-v1.json"),
                )
                self.assertEqual(
                    evidence["hmm_state_posterior"]["artifact_ref"],
                    str(Path("gates") / "hmm-state-posterior-v1.json"),
                )
                self.assertEqual(
                    evidence["expert_router_registry"]["artifact_ref"],
                    str(Path("gates") / "expert-router-registry-v1.json"),
                )
                self.assertTrue(
                    (output_dir / "gates" / "stress-metrics-v1.json").exists()
                )
                self.assertTrue(
                    (output_dir / "gates" / "benchmark-parity-report-v1.json").exists()
                )
                self.assertTrue(
                    (
                        output_dir / "microstructure" / "deeplob-bdlob-report-v1.json"
                    ).exists()
                )
                self.assertTrue(
                    (
                        output_dir / "execution" / "advisor-fallback-slo-report-v1.json"
                    ).exists()
                )
                self.assertTrue(
                    (
                        output_dir / "gates" / "contamination-leakage-report-v1.json"
                    ).exists()
                )
                self.assertTrue(
                    (output_dir / "gates" / "hmm-state-posterior-v1.json").exists()
                )
                self.assertTrue(
                    (output_dir / "gates" / "expert-router-registry-v1.json").exists()
                )
            finally:
                os.chdir(original_cwd)

    def test_lane_bridges_strategy_factory_into_gate_and_persistence(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "lane-with-strategy-factory"
            train_prices_path, test_prices_path = self._write_alpha_price_csvs(root)
            session_factory = self._empty_session_factory()

            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
                alpha_train_prices_path=train_prices_path,
                alpha_test_prices_path=test_prices_path,
            )

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertIn("strategy_factory", candidate_spec)
            self.assertIn(
                "strategy_factory_candidate_spec", candidate_spec["artifacts"]
            )
            self.assertIn(
                "strategy_factory_evaluation_report", candidate_spec["artifacts"]
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            strategy_factory_evidence = gate_payload["promotion_evidence"].get(
                "strategy_factory"
            )
            self.assertIsInstance(strategy_factory_evidence, dict)
            self.assertIn("candidate_spec_artifact", strategy_factory_evidence)
            self.assertIn("sequential_status", strategy_factory_evidence)

            with session_factory() as session:
                run_row = session.execute(
                    select(ResearchRun).where(ResearchRun.run_id == result.run_id)
                ).scalar_one()
                candidate_row = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                attempts = (
                    session.execute(
                        select(ResearchAttempt).where(
                            ResearchAttempt.run_id == result.run_id
                        )
                    )
                    .scalars()
                    .all()
                )
                validation_rows = (
                    session.execute(
                        select(ResearchValidationTest).where(
                            ResearchValidationTest.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                sequential_row = session.execute(
                    select(ResearchSequentialTrial).where(
                        ResearchSequentialTrial.candidate_id == result.candidate_id
                    )
                ).scalar_one_or_none()
                calibration_rows = (
                    session.execute(select(ResearchCostCalibration)).scalars().all()
                )
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one_or_none()
                vnext_promotion_row = session.execute(
                    select(VNextPromotionDecision).where(
                        VNextPromotionDecision.candidate_id == result.candidate_id
                    )
                ).scalar_one_or_none()

            self.assertEqual(run_row.discovery_mode, "strategy_factory_autonomy_v1")
            self.assertTrue(bool(candidate_row.candidate_family))
            self.assertGreater(len(attempts), 0)
            self.assertGreater(len(validation_rows), 0)
            self.assertIsNotNone(sequential_row)
            self.assertGreater(len(calibration_rows), 0)
            self.assertIsNotNone(promotion_row)
            self.assertIsNotNone(vnext_promotion_row)
            self.assertIn("strategy_factory", promotion_row.evidence_bundle)
            self.assertIn("strategy_factory", vnext_promotion_row.payload_json)

    def test_deterministic_run_id_changes_when_strategy_factory_inputs_change(
        self,
    ) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "set-a").mkdir(parents=True, exist_ok=True)
            (root / "set-b").mkdir(parents=True, exist_ok=True)
            train_a, test_a = self._write_alpha_price_csvs(root / "set-a")
            train_b, test_b = self._write_alpha_price_csvs(root / "set-b")
            train_b.write_text(
                train_b.read_text(encoding="utf-8") + "\n", encoding="utf-8"
            )

            run_id_a = _deterministic_run_id(
                fixture_path,
                strategy_config_path,
                gate_policy_path,
                "paper",
                alpha_train_prices_path=train_a,
                alpha_test_prices_path=test_a,
            )
            run_id_b = _deterministic_run_id(
                fixture_path,
                strategy_config_path,
                gate_policy_path,
                "paper",
                alpha_train_prices_path=train_b,
                alpha_test_prices_path=test_b,
            )

        self.assertNotEqual(run_id_a, run_id_b)

    def test_lane_progression_manifests_and_iteration_note(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-manifest"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            candidate_manifest = json.loads(
                result.candidate_generation_manifest_path.read_text(encoding="utf-8")
            )
            evaluation_manifest = json.loads(
                result.evaluation_manifest_path.read_text(encoding="utf-8")
            )
            recommendation_manifest = json.loads(
                result.recommendation_manifest_path.read_text(encoding="utf-8")
            )

            self.assertEqual(candidate_manifest["stage"], "candidate-generation")
            self.assertEqual(candidate_manifest["stage_index"], 1)
            self.assertIsNone(candidate_manifest["parent_lineage_hash"])
            self.assertEqual(
                evaluation_manifest["parent_lineage_hash"],
                candidate_manifest["lineage_hash"],
            )
            self.assertEqual(
                evaluation_manifest["parent_stage"], "candidate-generation"
            )
            self.assertEqual(evaluation_manifest["stage"], "evaluation")
            self.assertEqual(evaluation_manifest["stage_index"], 2)
            self.assertEqual(
                recommendation_manifest["parent_lineage_hash"],
                evaluation_manifest["lineage_hash"],
            )
            self.assertEqual(recommendation_manifest["parent_stage"], "evaluation")
            self.assertEqual(
                recommendation_manifest["stage"], "promotion-recommendation"
            )
            self.assertEqual(recommendation_manifest["stage_index"], 3)
            self.assertEqual(
                result.stage_lineage_root,
                candidate_manifest["lineage_hash"],
            )
            self.assertEqual(
                result.stage_trace_ids["candidate-generation"],
                candidate_manifest["stage_trace_id"],
            )
            self.assertEqual(
                result.stage_trace_ids["evaluation"],
                evaluation_manifest["stage_trace_id"],
            )
            self.assertEqual(
                result.stage_trace_ids["promotion-recommendation"],
                recommendation_manifest["stage_trace_id"],
            )

            notes = sorted((output_dir / "notes").glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            note_text = notes[0].read_text(encoding="utf-8")
            self.assertIn("Autonomous lane iteration 1", note_text)
            self.assertIn("candidate-generation", note_text)

    def test_lane_reads_runtime_strategy_file_for_runbook_validation(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-runtime-runbook"
            strategy_configmap_path = Path(tmpdir) / "strategies.yaml"
            strategy_configmap_path.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "runtime-macd-rsi",
                                "strategy_type": "legacy_macd_rsi",
                                "version": "1.0.0",
                                "enabled": True,
                            }
                        ]
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )

            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                strategy_configmap_path=strategy_configmap_path,
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertNotIn(
                "runbook_not_validated",
                actuation_payload["gates"]["recommendation_reasons"],
            )

    def test_lane_progression_and_iteration_notes_respect_execution_artifact_path(
        self,
    ) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-default-notes"
            artifact_path = Path(tmpdir) / "external-notes-root"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                governance_inputs={
                    "execution_context": {
                        "repository": "override/repo",
                        "base": "feature/base",
                        "head": "run/head",
                        "priorityId": "P-1001",
                        "artifactPath": str(artifact_path),
                    }
                },
            )

            notes_dir = artifact_path / "notes"
            notes = sorted(notes_dir.glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            self.assertIn(
                "Autonomous lane iteration 1",
                notes[0].read_text(encoding="utf-8"),
            )
            self.assertFalse(
                any((output_dir / "notes").glob("iteration-*.md")),
                "iteration notes should be written under execution artifactPath",
            )
            phase_manifest = json.loads(
                result.phase_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                phase_manifest["execution_context"]["artifactPath"],
                str(artifact_path),
            )
            self.assertEqual(
                phase_manifest["execution_context"]["repository"],
                "override/repo",
            )
            self.assertEqual(
                phase_manifest["execution_context"]["base"], "feature/base"
            )
            self.assertEqual(
                phase_manifest["execution_context"]["head"],
                "run/head",
            )
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertEqual(
                actuation_payload["governance"]["artifact_path"],
                str(artifact_path),
            )
            self.assertEqual(
                actuation_payload["governance"]["repository"],
                "override/repo",
            )
            self.assertEqual(
                actuation_payload["governance"]["base"],
                "feature/base",
            )
            self.assertEqual(actuation_payload["governance"]["head"], "run/head")
            self.assertEqual(
                actuation_payload["governance"]["priority_id"],
                "P-1001",
            )
