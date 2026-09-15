from __future__ import annotations

from tests.autonomous_lane.autonomous_lane_support import (
    AutonomousLaneTestCaseBase,
    Base,
    GateEvaluationReport,
    GateResult,
    Path,
    PromotionEvidenceSummary,
    PromotionPrerequisiteResult,
    PromotionRecommendation,
    ResearchCandidate,
    RollbackReadinessResult,
    SignalEnvelope,
    _AUTONOMY_PHASE_ORDER,
    _STRESS_METRICS_CASES,
    _build_phase_manifest,
    build_phase_manifest_payload_with_runtime_and_rollback,
    build_rollback_proof_phase,
    build_runtime_and_rollback_governance_payloads,
    build_runtime_governance_phase,
    create_engine,
    datetime,
    normalize_phase_manifest_phases,
    patch,
    required_slo_gate_ids,
    run_autonomous_lane,
    select,
    sessionmaker,
    tempfile,
    timezone,
)


class TestAutonomousLanePhaseA(AutonomousLaneTestCaseBase):
    def test_lane_marks_hold_recommendation_as_retained_challenger(self) -> None:
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

        forced_gate = GateEvaluationReport(
            policy_version="v3-gates-1",
            promotion_target="paper",
            promotion_allowed=True,
            recommended_mode="paper",
            gates=[
                GateResult(gate_id="gate0_data_integrity", status="pass"),
                GateResult(gate_id="gate1_statistical_robustness", status="pass"),
                GateResult(gate_id="gate2_risk_capacity", status="pass"),
                GateResult(gate_id="gate3_shadow_paper_quality", status="pass"),
                GateResult(gate_id="gate4_operational_readiness", status="pass"),
                GateResult(gate_id="gate6_profitability_evidence", status="pass"),
                GateResult(gate_id="gate5_live_ramp_readiness", status="pass"),
            ],
            reasons=[],
            uncertainty_gate_action="pass",
            coverage_error="0.02",
            conformal_interval_width="1.00",
            shift_score="0.10",
            recalibration_run_id=None,
            evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            code_version="test-sha",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "app.trading.autonomy.lane_candidate_phase_execution.evaluate_gate_matrix",
                return_value=forced_gate,
            ):
                with patch(
                    "app.trading.autonomy.lane_gate_spec_phase.build_promotion_recommendation",
                    return_value=PromotionRecommendation(
                        action="hold",
                        requested_mode="paper",
                        recommended_mode="shadow",
                        eligible=True,
                        rationale="hold_for_shadow_stage",
                        reasons=["shadow_mode_recommended"],
                        evidence=PromotionEvidenceSummary(
                            fold_metrics_count=1,
                            stress_metrics_count=len(_STRESS_METRICS_CASES),
                            rationale_present=True,
                            evidence_complete=True,
                            reasons=[],
                        ),
                        trace_id="forced-hold-trace",
                    ),
                ):
                    result = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_config_path,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-hold",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )

        with session_factory() as session:
            candidate = session.execute(
                select(ResearchCandidate).where(
                    ResearchCandidate.candidate_id == result.candidate_id
                )
            ).scalar_one()

        self.assertEqual(candidate.lifecycle_role, "challenger")
        self.assertEqual(candidate.lifecycle_status, "evaluated")
        self.assertIsInstance(candidate.universe_definition, dict)
        assert isinstance(candidate.universe_definition, dict)
        lifecycle = candidate.universe_definition.get("autonomy_lifecycle")
        self.assertIsInstance(lifecycle, dict)
        assert isinstance(lifecycle, dict)
        self.assertEqual(lifecycle.get("status"), "retained_challenger")

    def test_build_phase_manifest_has_canonical_phase_order_and_transitions(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-123",
                candidate_id="cand-1",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=output_dir
                / "paper-candidate"
                / "strategy-configmap-patch.yaml",
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs={
                    "execution_context": {
                        "repository": "acme/torghut",
                        "base": "main",
                        "head": "paper-path",
                        "artifactPath": str(output_dir),
                        "priorityId": "p1",
                    }
                },
                drift_promotion_evidence=None,
            )

            self.assertEqual(manifest["status"], "pass")
            self.assertEqual(manifest["phase_count"], len(_AUTONOMY_PHASE_ORDER))
            self.assertEqual(
                [phase["name"] for phase in manifest["phases"]],
                list(_AUTONOMY_PHASE_ORDER),
            )
            self.assertEqual(
                manifest["phase_transitions"],
                [
                    {
                        "from": "gate-evaluation",
                        "to": "promotion-prerequisites",
                        "status": "pass",
                    },
                    {
                        "from": "promotion-prerequisites",
                        "to": "rollback-readiness",
                        "status": "pass",
                    },
                    {
                        "from": "rollback-readiness",
                        "to": "drift-gate",
                        "status": "pass",
                    },
                    {"from": "drift-gate", "to": "paper-canary", "status": "pass"},
                    {
                        "from": "paper-canary",
                        "to": "runtime-governance",
                        "status": "skipped",
                    },
                    {
                        "from": "runtime-governance",
                        "to": "rollback-proof",
                        "status": "pass",
                    },
                ],
            )
            self.assertEqual(
                manifest["execution_context"],
                {
                    "repository": "acme/torghut",
                    "base": "main",
                    "head": "paper-path",
                    "artifactPath": str(output_dir),
                    "priorityId": "p1",
                },
            )
            gate_transition_statuses = {
                phase["name"]: phase["status"] for phase in manifest["phases"]
            }
            self.assertEqual(gate_transition_statuses["runtime-governance"], "skipped")
            self.assertEqual(gate_transition_statuses["rollback-proof"], "pass")

    def test_normalize_phase_manifest_phases_adds_missing_and_defaults(self) -> None:
        manifest_phases = [
            {"name": "runtime-governance", "status": "pass"},
            {"name": "gate-evaluation", "status": "pass"},
            {"name": "rollback-proof", "status": "invalid"},
        ]
        normalized = normalize_phase_manifest_phases(
            manifest_phases,
            phase_timestamp="2026-01-01T00:00:00Z",
        )
        self.assertEqual(
            [phase["name"] for phase in normalized],
            list(_AUTONOMY_PHASE_ORDER),
        )
        self.assertEqual(normalized[5]["status"], "pass")
        self.assertEqual(normalized[6]["status"], "skipped")
        rollback_proof_gate_map = {
            gate["id"]: gate.get("status")
            for gate in normalized[6].get("slo_gates", [])
            if isinstance(gate, dict)
        }
        self.assertIn(
            "slo_rollback_evidence_required_when_triggered",
            rollback_proof_gate_map,
        )
        self.assertEqual(
            rollback_proof_gate_map["slo_rollback_evidence_required_when_triggered"],
            "skipped",
        )
        runtime_gate_map = {
            gate["id"]: gate.get("status")
            for gate in normalized[5].get("slo_gates", [])
            if isinstance(gate, dict)
        }
        self.assertEqual(
            set(required_slo_gate_ids("runtime-governance")),
            set(runtime_gate_map),
            "runtime-governance requires explicit SLO gates",
        )
        gate_evaluation_gate_map = {
            gate["id"]: gate.get("status")
            for gate in normalized[0].get("slo_gates", [])
            if isinstance(gate, dict)
        }
        self.assertEqual(
            set(required_slo_gate_ids("gate-evaluation")),
            set(gate_evaluation_gate_map),
            "gate-evaluation requires explicit SLO gates",
        )

    def test_build_runtime_governance_phase_carries_gate_status_and_reasons(
        self,
    ) -> None:
        phase = build_runtime_governance_phase(
            requested_promotion_target="paper",
            observed_at="2026-01-01T00:00:00Z",
            governance_status="invalid",
            drift_status="drift_detected",
            action_type="quarantine",
            action_triggered=True,
            rollback_triggered=True,
            reasons=[" evi", "", "evi"],
            artifact_refs=["artifact.json"],
        )
        self.assertEqual(phase["status"], "skipped")
        self.assertEqual(phase["artifact_refs"], ["artifact.json"])
        self.assertEqual(phase["reasons"], ["evi"])
        self.assertEqual(
            phase["slo_gates"][0]["id"], "slo_runtime_rollback_not_triggered"
        )
        self.assertEqual(phase["slo_gates"][0]["status"], "fail")

    def test_build_runtime_and_rollback_governance_bundle_enforces_evidence_rules(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            evidence_path = Path(tmpdir) / "rollback-evidence.json"
            evidence_path.write_text("{}", encoding="utf-8")

            triggered_bundle = build_runtime_and_rollback_governance_payloads(
                requested_promotion_target="paper",
                observed_at="2026-01-01T00:00:00Z",
                governance_status="pass",
                drift_status="drift_detected",
                action_type="quarantine",
                action_triggered=True,
                rollback_triggered=True,
                rollback_incident_evidence_path=str(evidence_path),
                reasons=["rollback", "drift_detected"],
                evidence_artifact_refs=[str(evidence_path), "drift/metric.json"],
            )
            self.assertEqual(
                triggered_bundle["runtime_phase"]["status"],
                "pass",
            )
            self.assertEqual(
                triggered_bundle["rollback_proof_phase"]["status"],
                "pass",
            )
            self.assertEqual(
                triggered_bundle["runtime_governance"][
                    "rollback_incident_evidence_path"
                ],
                str(evidence_path),
            )
            self.assertIn(
                str(evidence_path),
                triggered_bundle["rollback_proof"]["artifact_refs"],
            )
            self.assertEqual(
                triggered_bundle["rollback_proof_phase"]["status"],
                "pass",
            )

            untriggered_bundle = build_runtime_and_rollback_governance_payloads(
                requested_promotion_target="paper",
                observed_at="2026-01-01T00:00:00Z",
                governance_status="pass",
                drift_status="stable",
                action_type="none",
                action_triggered=False,
                rollback_triggered=False,
                rollback_incident_evidence_path=str(evidence_path),
                reasons=[],
                evidence_artifact_refs=[str(evidence_path)],
            )
            self.assertEqual(
                untriggered_bundle["runtime_phase"]["status"],
                "pass",
            )
            self.assertEqual(
                untriggered_bundle["rollback_proof_phase"]["status"],
                "pass",
            )
            self.assertEqual(
                untriggered_bundle["rollback_proof"]["rollback_incident_evidence_path"],
                "",
            )
            self.assertNotIn(
                str(evidence_path),
                untriggered_bundle["rollback_proof"]["artifact_refs"],
            )

            missing_evidence_bundle = build_runtime_and_rollback_governance_payloads(
                requested_promotion_target="paper",
                observed_at="2026-01-01T00:00:00Z",
                governance_status="fail",
                drift_status="drift_detected",
                action_type="retrain",
                action_triggered=True,
                rollback_triggered=True,
                rollback_incident_evidence_path="",
                reasons=["drift_detected"],
                evidence_artifact_refs=["drift/metric.json"],
            )
            self.assertEqual(
                missing_evidence_bundle["rollback_proof_phase"]["status"],
                "fail",
            )

    def test_build_phase_manifest_payload_with_runtime_and_rollback_merges_runtime_and_rollback_stages(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            evidence_path = Path(tmpdir) / "rollback-evidence.json"
            evidence_path.write_text("{}", encoding="utf-8")
            phase_manifest = build_phase_manifest_payload_with_runtime_and_rollback(
                run_id="run-legacy",
                candidate_id="cand-legacy",
                execution_context={
                    "repository": "acme/torghut",
                    "base": "main",
                    "head": "legacy/run",
                    "artifactPath": str(Path(tmpdir)),
                },
                requested_promotion_target="paper",
                phase_timestamp="2026-01-01T00:00:00Z",
                phase_payloads=[
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": ["gates/gate-evaluation.json"],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": ["gates/promotion-prerequisites.json"],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": ["gates/rollback-readiness.json"],
                    },
                    {
                        "name": "drift-gate",
                        "status": "pass",
                        "artifact_refs": ["gates/drift-gate.json"],
                    },
                    {
                        "name": "paper-canary",
                        "status": "pass",
                        "artifact_refs": ["gates/paper-canary.json"],
                    },
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": ["old/runtime.json"],
                    },
                    {
                        "name": "rollback-proof",
                        "status": "pass",
                        "artifact_refs": ["old/rollback.json"],
                    },
                ],
                governance_status="fail",
                drift_status="drift_detected",
                action_type="quarantine",
                action_triggered=True,
                rollback_triggered=True,
                rollback_incident_evidence_path=str(evidence_path),
                reasons=["drift_detected", "evidence_anomaly"],
                evidence_artifact_refs=[str(evidence_path), "drift/evidence.json"],
                observation_summary={"decision": "unit-test"},
                artifact_refs=["artifact-root.json"],
                created_at="2026-01-01T00:00:00Z",
                updated_at="2026-01-01T00:00:01Z",
            )

            self.assertEqual(
                [phase["name"] for phase in phase_manifest["phases"]],
                list(_AUTONOMY_PHASE_ORDER),
            )
            self.assertEqual(phase_manifest["phases"][5]["status"], "fail")
            self.assertEqual(phase_manifest["phases"][6]["status"], "pass")
            self.assertIn(
                {
                    "from": "runtime-governance",
                    "to": "rollback-proof",
                    "status": "pass",
                },
                phase_manifest["phase_transitions"],
            )
            self.assertEqual(
                phase_manifest["runtime_governance"]["governance_status"],
                "fail",
            )
            self.assertEqual(
                phase_manifest["rollback_proof"]["rollback_incident_evidence_path"],
                str(evidence_path),
            )
            self.assertIn(str(evidence_path), phase_manifest["artifact_refs"])

    def test_build_phase_manifest_payload_with_runtime_and_rollback_fails_without_evidence(
        self,
    ) -> None:
        phase_manifest = build_phase_manifest_payload_with_runtime_and_rollback(
            run_id="run-legacy-fail",
            candidate_id="cand-legacy-fail",
            execution_context={"repository": "acme/torghut"},
            requested_promotion_target="paper",
            phase_timestamp="2026-01-01T00:00:00Z",
            phase_payloads=[
                {
                    "name": "gate-evaluation",
                    "status": "pass",
                    "artifact_refs": [],
                },
                {"name": "promotion-prerequisites", "status": "pass"},
                {"name": "rollback-readiness", "status": "pass"},
                {"name": "drift-gate", "status": "pass"},
                {"name": "paper-canary", "status": "pass"},
            ],
            governance_status="pass",
            drift_status="drift_detected",
            action_type="none",
            action_triggered=False,
            rollback_triggered=True,
            rollback_incident_evidence_path="",
            reasons=[],
            evidence_artifact_refs=["evidence/metric.json"],
            observation_summary=None,
            artifact_refs=["artifact-root.json"],
        )
        self.assertEqual(phase_manifest["phases"][6]["status"], "fail")
        self.assertEqual(phase_manifest["status"], "fail")
        self.assertEqual(
            phase_manifest["rollback_proof"]["rollback_incident_evidence"],
            "",
        )
        self.assertIn(
            {"from": "runtime-governance", "to": "rollback-proof", "status": "fail"},
            phase_manifest["phase_transitions"],
        )

    def test_build_rollback_proof_phase_fails_without_evidence(self) -> None:
        phase = build_rollback_proof_phase(
            observed_at="2026-01-01T00:00:00Z",
            rollback_triggered=True,
            rollback_incident_evidence_path="",
            reasons=["triggered"],
            artifact_refs=["artifact.json"],
        )
        self.assertEqual(phase["status"], "fail")
        self.assertEqual(phase["artifact_refs"], ["artifact.json"])
        self.assertEqual(
            phase["slo_gates"][0],
            {
                "id": "slo_rollback_evidence_required_when_triggered",
                "status": "fail",
                "threshold": True,
                "value": False,
            },
        )

    def test_build_phase_manifest_defaults_execution_context_artifact_path(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-default-artifact-path"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-126",
                candidate_id="cand-4",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=output_dir
                / "paper-candidate"
                / "strategy-configmap-patch.yaml",
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs=None,
                drift_promotion_evidence=None,
            )

            self.assertEqual(
                manifest["execution_context"]["artifactPath"],
                str(output_dir),
            )
