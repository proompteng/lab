from __future__ import annotations

from tests.autonomous_lane.autonomous_lane_support import (
    AutonomousLaneTestCaseBase,
    Base,
    Path,
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
    RollbackReadinessResult,
    SignalEnvelope,
    SimpleNamespace,
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    VNextCompletionGateResult,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
    _persist_hypothesis_governance_rows,
    create_engine,
    datetime,
    json,
    os,
    patch,
    run_autonomous_lane,
    select,
    sessionmaker,
    tempfile,
    timedelta,
    timezone,
)


class TestAutonomousLanePersistenceA(AutonomousLaneTestCaseBase):
    def test_lane_blocks_promotion_when_candidate_readiness_is_invalid(
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

        def invalid_candidate_state(
            candidate_id: str,
            run_id: str,
            **kwargs: object,
        ) -> dict[str, object]:
            return {
                "candidateId": candidate_id,
                "runId": run_id,
                "activeStage": "gate-evaluation",
                "paused": False,
                "datasetSnapshotRef": "signals_window",
                "noSignalReason": None,
                "runbookValidated": "unknown",
                "rollbackReadiness": {
                    "killSwitchDryRunPassed": "maybe",
                    "gitopsRevertDryRunPassed": "maybe",
                    "strategyDisableDryRunPassed": "maybe",
                    "dryRunCompletedAt": "not-a-timestamp",
                    "humanApproved": "unknown",
                    "rollbackTarget": None,
                },
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "app.trading.autonomy.lane_candidate_phase_execution._build_candidate_state_payload",
                side_effect=invalid_candidate_state,
            ):
                output_dir = Path(tmpdir) / "lane-invalid-readiness"
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
                self.assertFalse(actuation_payload["actuation_allowed"])
                self.assertTrue(
                    any(
                        reason in actuation_payload["gates"]["recommendation_reasons"]
                        for reason in [
                            "rollback_checks_missing_or_failed",
                            "rollback_dry_run_failed",
                        ]
                    )
                )
                self.assertIn(
                    "runbook_not_validated",
                    actuation_payload["gates"]["recommendation_reasons"],
                )

    def test_lane_blocks_promotion_when_candidate_readiness_is_malformed(
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

        def malformed_candidate_state(
            candidate_id: str,
            run_id: str,
            **kwargs: object,
        ) -> dict[str, object]:
            payload = {
                "candidateId": candidate_id,
                "runId": run_id,
                "activeStage": "gate-evaluation",
                "paused": False,
                "datasetSnapshotRef": "signals_window",
                "noSignalReason": None,
                "runbookValidated": "unknown",
            }
            payload["rollbackReadiness"] = "malformed"
            return payload

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "app.trading.autonomy.lane_candidate_phase_execution._build_candidate_state_payload",
                side_effect=malformed_candidate_state,
            ):
                output_dir = Path(tmpdir) / "lane-malformed-readiness"
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
                self.assertFalse(actuation_payload["actuation_allowed"])
                self.assertIn(
                    "rollback_checks_missing_or_failed",
                    actuation_payload["gates"]["recommendation_reasons"],
                )

    def test_lane_blocks_promotion_when_candidate_rollbacks_are_stale(
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
        stale_cutoff = datetime(2026, 2, 1, tzinfo=timezone.utc)

        def stale_candidate_state(
            candidate_id: str,
            run_id: str,
            now: datetime,
            **kwargs: object,
        ) -> dict[str, object]:
            return {
                "candidateId": candidate_id,
                "runId": run_id,
                "activeStage": "gate-evaluation",
                "paused": False,
                "datasetSnapshotRef": "signals_window",
                "noSignalReason": None,
                "runbookValidated": True,
                "rollbackReadiness": {
                    "killSwitchDryRunPassed": True,
                    "gitopsRevertDryRunPassed": True,
                    "strategyDisableDryRunPassed": True,
                    "dryRunCompletedAt": (now - timedelta(days=4)).isoformat(),
                    "humanApproved": True,
                    "rollbackTarget": "deadbeef",
                },
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "app.trading.autonomy.lane_candidate_phase_execution._build_candidate_state_payload",
                side_effect=stale_candidate_state,
            ):
                output_dir = Path(tmpdir) / "lane-stale-readiness"
                result = run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    code_version="test-sha",
                    strategy_configmap_path=strategy_configmap_path,
                    evaluated_at=stale_cutoff,
                )

                actuation_payload = json.loads(
                    result.actuation_intent_path.read_text(encoding="utf-8")
                )
                self.assertFalse(actuation_payload["actuation_allowed"])
                self.assertIn(
                    "rollback_dry_run_stale",
                    actuation_payload["gates"]["recommendation_reasons"],
                )

    def test_lane_writes_iteration_report(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-notes"
            session_factory = self._empty_session_factory()
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                session_factory=session_factory,
                code_version="test-sha",
                governance_head="agentruns/notes-check",
                governance_base="main",
                governance_repository="proompteng/lab",
            )

            notes_path = output_dir / "notes" / "iteration-1.md"
            self.assertTrue(notes_path.exists())
            note_body = notes_path.read_text(encoding="utf-8")
            self.assertIn(f"- run_id: {result.run_id}", note_body)
            self.assertIn(f"- candidate_id: {result.candidate_id}", note_body)
            self.assertIn("- repository: proompteng/lab", note_body)
            self.assertIn("- base: main", note_body)
            self.assertIn("- head: agentruns/notes-check", note_body)

    @patch(
        "app.trading.autonomy.lane_gate_spec_phase.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=False,
            reasons=["rollback_checks_missing_or_failed"],
            required_checks=["killSwitchDryRunPassed"],
            missing_checks=["killSwitchDryRunPassed"],
        ),
    )
    def test_lane_does_not_persist_promotion_when_rollback_not_ready(
        self, _mock_rollback: object
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

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-no-promote"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

            self.assertIsNone(result.paper_patch_path)
            with session_factory() as session:
                candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one()

        self.assertEqual(candidate.lifecycle_role, "challenger")
        self.assertEqual(candidate.lifecycle_status, "evaluated")
        self.assertFalse(candidate.metadata_bundle.get("actuation_allowed"))
        self.assertIsNone(promotion_row.approved_mode)
        self.assertIsNotNone(promotion_row.deny_reason)
        self.assertEqual(promotion_row.requested_mode, "paper")

    def test_lane_uses_repo_relative_default_configmap_path(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )
        previous_cwd = Path.cwd()
        try:
            os.chdir(Path(__file__).parent.parent)
            with tempfile.TemporaryDirectory() as tmpdir:
                output_dir = Path(tmpdir) / "lane-default-path"
                session_factory = self._empty_session_factory()
                result = run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    session_factory=session_factory,
                    code_version="test-sha",
                )
                self.assertIsNone(result.paper_patch_path)
                gate_payload = json.loads(
                    result.gate_report_path.read_text(encoding="utf-8")
                )
                self.assertFalse(
                    gate_payload["promotion_decision"]["promotion_allowed"]
                )
                self.assertNotEqual(gate_payload["recommended_mode"], "paper")
        finally:
            os.chdir(previous_cwd)

    def test_lane_persists_research_ledger_when_enabled(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

            self.assertIsNone(result.paper_patch_path)
            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertIn(
                "tca_order_count_below_minimum",
                gate_payload["promotion_decision"]["reason_codes"],
            )

            with session_factory() as session:
                run_row = session.execute(
                    select(ResearchRun).where(ResearchRun.run_id == result.run_id)
                ).scalar_one()
                candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                fold_rows = (
                    session.execute(
                        select(ResearchFoldMetrics).where(
                            ResearchFoldMetrics.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                stress_rows = (
                    session.execute(
                        select(ResearchStressMetrics).where(
                            ResearchStressMetrics.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                dataset_snapshot = session.execute(
                    select(VNextDatasetSnapshot).where(
                        VNextDatasetSnapshot.run_id == result.run_id
                    )
                ).scalar_one()
                feature_specs = (
                    session.execute(
                        select(VNextFeatureViewSpec).where(
                            VNextFeatureViewSpec.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                model_artifacts = (
                    session.execute(
                        select(VNextModelArtifact).where(
                            VNextModelArtifact.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                experiment_spec = session.execute(
                    select(VNextExperimentSpec).where(
                        VNextExperimentSpec.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                experiment_run = session.execute(
                    select(VNextExperimentRun).where(
                        VNextExperimentRun.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                simulation_calibration = session.execute(
                    select(VNextSimulationCalibration).where(
                        VNextSimulationCalibration.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                shadow_live_deviation = session.execute(
                    select(VNextShadowLiveDeviation).where(
                        VNextShadowLiveDeviation.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                promotion_decision = session.execute(
                    select(VNextPromotionDecision).where(
                        VNextPromotionDecision.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                spec_lineage_gate = session.execute(
                    select(VNextCompletionGateResult).where(
                        VNextCompletionGateResult.run_id == result.run_id,
                        VNextCompletionGateResult.gate_id
                        == "strategy_spec_v2_runtime_lineage",
                    )
                ).scalar_one()
            self.assertEqual(run_row.status, "passed")
            self.assertIsNotNone(run_row.dataset_from)
            self.assertIsNotNone(run_row.dataset_to)
            self.assertIsInstance(candidate.decision_count, int)
            self.assertGreaterEqual(candidate.decision_count, 0)
            self.assertIsInstance(candidate.universe_definition, dict)
            assert isinstance(candidate.universe_definition, dict)
            lifecycle = candidate.universe_definition.get("autonomy_lifecycle")
            self.assertIsInstance(lifecycle, dict)
            assert isinstance(lifecycle, dict)
            self.assertEqual(lifecycle.get("role"), "challenger")
            self.assertIn(
                lifecycle.get("status"), {"promoted_champion", "retained_challenger"}
            )
            self.assertTrue(fold_rows)
            self.assertEqual(len(stress_rows), 4)
            self.assertEqual(promotion_row.requested_mode, "paper")
            self.assertIn(promotion_row.approved_mode, {"paper", None})
            self.assertEqual(dataset_snapshot.run_id, result.run_id)
            self.assertEqual(dataset_snapshot.source, "historical_market_replay")
            self.assertTrue(feature_specs)
            self.assertTrue(model_artifacts)
            self.assertEqual(experiment_spec.run_id, result.run_id)
            self.assertEqual(experiment_run.run_id, result.run_id)
            self.assertEqual(simulation_calibration.run_id, result.run_id)
            self.assertEqual(shadow_live_deviation.run_id, result.run_id)
            self.assertEqual(promotion_decision.run_id, result.run_id)
            self.assertEqual(promotion_decision.promotion_target, "paper")
            self.assertEqual(spec_lineage_gate.status, "satisfied")
            self.assertIn(candidate.lifecycle_role, {"champion", "challenger"})
            self.assertIsInstance(candidate.metadata_bundle, dict)
            self.assertIsInstance(candidate.recommendation_bundle, dict)
            self.assertIsNotNone(promotion_row.decision_action)
            self.assertTrue((promotion_row.decision_rationale or "").strip())
            self.assertIsInstance(promotion_row.evidence_bundle, dict)
            self.assertIsNotNone(
                promotion_row.approve_reason or promotion_row.deny_reason
            )
            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertIn(
                "profitability_stage_manifest",
                candidate_spec["artifacts"],
            )
            self.assertIn(
                "profitability_stage_manifest",
                candidate_spec["stage_manifest_refs"],
            )
            self.assertIn("stage_lineage", candidate_spec)
            self.assertEqual(
                candidate_spec["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn("stages", candidate_spec["stage_lineage"])
            self.assertIn("candidate-generation", candidate_spec["artifacts"])
            self.assertIn("evaluation", candidate_spec["artifacts"])
            self.assertIn("promotion-recommendation", candidate_spec["artifacts"])
            self.assertIn("promotion_recommendation", candidate_spec["artifacts"])
            self.assertIn(
                "candidate-generation",
                candidate_spec["stage_trace_ids"],
            )
            self.assertIn(
                "evaluation",
                candidate_spec["stage_trace_ids"],
            )
            self.assertIn(
                "promotion-recommendation",
                candidate_spec["stage_trace_ids"],
            )
            self.assertEqual(
                candidate_spec["stage_trace_ids"],
                result.stage_trace_ids,
            )
            self.assertIn("replay_artifact_hashes", candidate_spec)
            artifact_paths = dict(candidate_spec["artifacts"])
            artifact_paths.update(
                {
                    "candidate_generation_manifest": candidate_spec[
                        "stage_manifest_refs"
                    ]["candidate-generation"],
                    "evaluation_manifest": candidate_spec["stage_manifest_refs"][
                        "evaluation"
                    ],
                    "recommendation_manifest": candidate_spec["stage_manifest_refs"][
                        "promotion-recommendation"
                    ],
                }
            )
            profitability_manifest = json.loads(
                result.profitability_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                candidate_spec["stage_manifest_refs"]["profitability_stage_manifest"],
                str(result.profitability_manifest_path),
            )
            self.assertTrue(
                result.profitability_manifest_path.exists(),
                "profitability stage manifest should be written",
            )
            self.assertIn("research", profitability_manifest["stages"])
            self.assertIn("validation", profitability_manifest["stages"])
            self.assertIn("execution", profitability_manifest["stages"])
            self.assertIn("governance", profitability_manifest["stages"])
            for artifact_key, expected_hash in candidate_spec[
                "replay_artifact_hashes"
            ].items():
                artifact_path = artifact_paths.get(artifact_key)
                self.assertIsNotNone(
                    artifact_path, f"artifact {artifact_key} should be present"
                )
                self.assertEqual(
                    expected_hash,
                    self._artifact_sha256(Path(artifact_path)),
                    f"artifact hash for {artifact_key} should match replay payload",
                )
            for key in (
                "candidate_generation_manifest",
                "evaluation_manifest",
                "recommendation_manifest",
                "promotion_recommendation",
            ):
                self.assertIn(key, candidate_spec["replay_artifact_hashes"])
            self.assertIn("stage_lineage", candidate.metadata_bundle)
            self.assertEqual(
                candidate.metadata_bundle["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn(
                "stage_manifest_refs",
                candidate.metadata_bundle,
            )
            self.assertEqual(
                candidate.metadata_bundle["stage_manifest_refs"],
                candidate_spec["stage_manifest_refs"],
            )
            self.assertIn("stage_lineage", promotion_row.evidence_bundle)
            self.assertEqual(
                promotion_row.evidence_bundle["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn("replay_artifact_hashes", promotion_row.evidence_bundle)
            self.assertEqual(
                promotion_row.evidence_bundle["replay_artifact_hashes"],
                candidate.metadata_bundle["replay_artifact_hashes"],
            )

    def test_persist_hypothesis_governance_rows_writes_strategy_ledger(self) -> None:
        session_factory = self._empty_session_factory()

        class _PromotionRecommendationStub:
            reasons = ["dependency_quorum_allow"]

            def to_payload(self) -> dict[str, object]:
                return {
                    "action": "promote",
                    "recommended_mode": "paper",
                    "reasons": list(self.reasons),
                }

        with session_factory() as session:
            _persist_hypothesis_governance_rows(
                session=session,
                run_id="run-1",
                candidate_id="cand-1",
                candidate_spec_payload={
                    "alpha_readiness": {"matched_hypothesis_ids": ["H-CONT-01"]},
                    "dependency_quorum": {"decision": "allow"},
                    "runtime_observation": {
                        "authoritative": True,
                        "observed_stage": "paper",
                        "evidence_provenance": "paper_runtime_observed",
                    },
                },
                signals=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        symbol="AAPL",
                        timeframe="1Min",
                        payload={},
                    ),
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 6, 20, 0, tzinfo=timezone.utc),
                        symbol="AAPL",
                        timeframe="1Min",
                        payload={},
                    ),
                ],
                report=SimpleNamespace(
                    metrics=SimpleNamespace(
                        decision_count=120,
                        trade_count=116,
                    )
                ),
                promotion_target="paper",
                effective_promotion_allowed=True,
                promotion_recommendation=_PromotionRecommendationStub(),
                simulation_calibration_report_payload={
                    "order_count": 116,
                    "avg_realized_shortfall_bps": "-1.5",
                },
                shadow_live_deviation_report_payload={
                    "order_count": 116,
                    "avg_abs_slippage_bps": "4.2",
                },
                now=datetime(2026, 3, 6, 20, 1, tzinfo=timezone.utc),
            )
            session.commit()

            hypothesis = session.execute(select(StrategyHypothesis)).scalar_one()
            hypothesis_version = session.execute(
                select(StrategyHypothesisVersion)
            ).scalar_one()
            metric_window = session.execute(
                select(StrategyHypothesisMetricWindow)
            ).scalar_one()
            capital_allocation = session.execute(
                select(StrategyCapitalAllocation)
            ).scalar_one()
            promotion_decision = session.execute(
                select(StrategyPromotionDecision)
            ).scalar_one()

        self.assertEqual(hypothesis.hypothesis_id, "H-CONT-01")
        self.assertEqual(hypothesis_version.hypothesis_id, "H-CONT-01")
        self.assertEqual(metric_window.observed_stage, "paper")
        self.assertEqual(metric_window.evidence_provenance, "paper_runtime_observed")
        self.assertEqual(metric_window.evidence_maturity, "empirically_validated")
        self.assertEqual(metric_window.capital_stage, "shadow")
        self.assertTrue(
            metric_window.payload_json["runtime_observation_qualification"][
                "qualified_runtime_observation"
            ]
        )
        self.assertEqual(capital_allocation.stage, "shadow")
        self.assertEqual(promotion_decision.promotion_target, "paper")
        self.assertTrue(promotion_decision.allowed)

    def test_persist_hypothesis_governance_rows_fail_closed_without_runtime_observation_contract(
        self,
    ) -> None:
        session_factory = self._empty_session_factory()

        class _PromotionRecommendationStub:
            reasons = ["dependency_quorum_allow"]

            def to_payload(self) -> dict[str, object]:
                return {
                    "action": "promote",
                    "recommended_mode": "live",
                    "reasons": list(self.reasons),
                }

        with session_factory() as session:
            _persist_hypothesis_governance_rows(
                session=session,
                run_id="run-2",
                candidate_id="cand-2",
                candidate_spec_payload={
                    "alpha_readiness": {"matched_hypothesis_ids": ["H-CONT-01"]},
                    "dependency_quorum": {"decision": "allow"},
                },
                signals=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                        symbol="AAPL",
                        timeframe="1Min",
                        payload={},
                    ),
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 6, 20, 0, tzinfo=timezone.utc),
                        symbol="AAPL",
                        timeframe="1Min",
                        payload={},
                    ),
                ],
                report=SimpleNamespace(
                    metrics=SimpleNamespace(
                        decision_count=120,
                        trade_count=116,
                    )
                ),
                promotion_target="live",
                effective_promotion_allowed=True,
                promotion_recommendation=_PromotionRecommendationStub(),
                simulation_calibration_report_payload={
                    "order_count": 116,
                    "avg_realized_shortfall_bps": "-1.5",
                },
                shadow_live_deviation_report_payload={
                    "order_count": 116,
                    "avg_abs_slippage_bps": "4.2",
                },
                now=datetime(2026, 3, 6, 20, 1, tzinfo=timezone.utc),
            )
            session.commit()
            metric_window = session.execute(
                select(StrategyHypothesisMetricWindow)
            ).scalar_one()
            capital_allocation = session.execute(
                select(StrategyCapitalAllocation)
            ).scalar_one()

        self.assertEqual(metric_window.observed_stage, "live")
        self.assertEqual(metric_window.evidence_provenance, "historical_market_replay")
        self.assertEqual(metric_window.evidence_maturity, "calibrated")
        self.assertEqual(metric_window.capital_stage, "shadow")
        self.assertFalse(
            metric_window.payload_json["runtime_observation_qualification"][
                "qualified_runtime_observation"
            ]
        )
        self.assertEqual(capital_allocation.stage, "shadow")
