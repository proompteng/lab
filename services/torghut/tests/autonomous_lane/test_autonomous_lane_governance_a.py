from __future__ import annotations

# ruff: noqa: F403,F405
from tests.autonomous_lane.autonomous_lane_support import *


class TestAutonomousLaneGovernanceA(AutonomousLaneTestCaseBase):
    def test_lane_propagates_design_doc_to_profitability_manifest(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-design-doc"
            design_doc = "docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                design_doc=design_doc,
                priority_id="P-2002",
            )

            profitability_manifest = json.loads(
                result.profitability_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                profitability_manifest["run_context"]["design_doc"],
                design_doc,
            )
            self.assertEqual(
                profitability_manifest["run_context"]["priority_id"],
                "P-2002",
            )

    def test_lane_defaults_design_doc_to_governing_doc_when_omitted(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-default-design-doc"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            profitability_manifest = json.loads(
                result.profitability_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                profitability_manifest["run_context"]["design_doc"],
                "docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md",
            )

    def test_lane_top_level_execution_context_args_are_honored(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-top-level"
            artifact_path = Path(tmpdir) / "top-level-notes-root"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                repository="override/repo",
                base="feature/base",
                head="run/head",
                artifact_path=str(artifact_path),
                priority_id="P-2002",
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
                "iteration notes should be written under explicit artifactPath",
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
            self.assertEqual(phase_manifest["execution_context"]["head"], "run/head")

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            governance_payload = actuation_payload["governance"]
            self.assertEqual(governance_payload["repository"], "override/repo")
            self.assertEqual(governance_payload["base"], "feature/base")
            self.assertEqual(governance_payload["head"], "run/head")
            self.assertEqual(governance_payload["artifact_path"], str(artifact_path))
            self.assertEqual(governance_payload["priority_id"], "P-2002")

    def test_lane_supports_camelcase_artifact_and_priority_inputs(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-top-level-camelcase"
            artifact_path = Path(tmpdir) / "camel-notes-root"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                repository="override/repo",
                base="feature/base",
                head="run/head",
                artifactPath=str(artifact_path),
                priorityId="P-2003",
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
                "iteration notes should be written under explicit artifactPath",
            )
            phase_manifest = json.loads(
                result.phase_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                phase_manifest["execution_context"]["artifactPath"],
                str(artifact_path),
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
            self.assertEqual(actuation_payload["governance"]["priority_id"], "P-2003")

    def test_lane_prefers_governance_artifact_override_over_execution_context_artifact(
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
            output_dir = Path(tmpdir) / "lane-override-notes"
            execution_artifact_path = Path(tmpdir) / "execution-notes-root"
            explicit_artifact_path = Path(tmpdir) / "explicit-notes-root"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                governance_artifact_path=str(explicit_artifact_path),
                governance_inputs={
                    "execution_context": {
                        "artifactPath": str(execution_artifact_path),
                    }
                },
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertEqual(
                actuation_payload["governance"]["artifact_path"],
                str(explicit_artifact_path),
            )
            phase_manifest = json.loads(
                result.phase_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                phase_manifest["execution_context"]["artifactPath"],
                str(explicit_artifact_path),
            )
            notes = sorted((execution_artifact_path / "notes").glob("iteration-*.md"))
            self.assertEqual(
                len(notes),
                0,
                "execution context artifactPath should be overridden by governance_artifact_path",
            )
            notes = sorted((explicit_artifact_path / "notes").glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)

    def test_lane_supports_governance_override_for_actuation_intent(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-overrides"
            custom_artifact_dir = output_dir / "artifacts"
            custom_head = "agentruns/torghut-autonomy-custom"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                governance_repository="alt-org/lab",
                governance_base="release",
                governance_head=custom_head,
                governance_artifact_path=str(custom_artifact_dir),
                priority_id="priority-123",
                governance_change="manual-review",
                governance_reason="manual override",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            governance_payload = actuation_payload["governance"]
            self.assertEqual(governance_payload["repository"], "alt-org/lab")
            self.assertEqual(governance_payload["base"], "release")
            self.assertEqual(governance_payload["head"], custom_head)
            self.assertEqual(
                governance_payload["artifact_path"], str(custom_artifact_dir)
            )
            self.assertEqual(governance_payload["change"], "manual-review")
            self.assertEqual(governance_payload["priority_id"], "priority-123")
            self.assertEqual(governance_payload["reason"], "manual override")

    def test_lane_blocks_promotion_when_runbook_evidence_is_missing(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-missing-runbook"
            missing_strategy_configmap = (
                Path(tmpdir) / "missing-strategy-configmap.yaml"
            )
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                strategy_configmap_path=missing_strategy_configmap,
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertIn(
                "runbook_not_validated",
                gate_payload["promotion_decision"]["reason_codes"],
            )
            self.assertIsNone(result.paper_patch_path)

    def test_lane_blocks_promotion_when_runbook_evidence_is_invalid(self) -> None:
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
            invalid_strategy_configmap = Path(tmpdir) / "strategy-configmap.yaml"
            invalid_strategy_configmap.write_text("{kind: [", encoding="utf-8")
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=Path(tmpdir) / "lane-invalid-runbook",
                promotion_target="paper",
                code_version="test-sha",
                strategy_configmap_path=invalid_strategy_configmap,
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertIn(
                "runbook_not_validated",
                gate_payload["promotion_decision"]["reason_codes"],
            )
            self.assertIsNone(result.paper_patch_path)

    def test_lane_blocks_live_without_policy_enablement(self) -> None:
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
            output_dir = Path(tmpdir) / "lane-live"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="live",
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_allowed"])
            self.assertIn("live_rollout_disabled_by_policy", gate_payload["reasons"])
            self.assertIsNone(result.paper_patch_path)
            self.assertIsNotNone(result.actuation_intent_path)
            assert result.actuation_intent_path is not None
            self.assertTrue(result.actuation_intent_path.exists())
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertEqual(actuation_payload["promotion_target"], "live")
            self.assertTrue(actuation_payload["confirmation_phrase_required"])

    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=False,
            reasons=["rollback_checks_missing_or_failed"],
            required_checks=["killSwitchDryRunPassed"],
            missing_checks=["killSwitchDryRunPassed"],
        ),
    )
    def test_lane_marks_actuation_not_allowed_when_rollback_readiness_fails(
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

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-rollback-block"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertIsNone(result.paper_patch_path)
            self.assertEqual(
                actuation_payload["audit"]["rollback_evidence_missing_checks"],
                ["killSwitchDryRunPassed"],
            )
            self.assertIn(
                "rollback_checks_missing_or_failed",
                actuation_payload["gates"]["recommendation_reasons"],
            )
            self.assertIn(
                str(output_dir / "gates" / "rollback-readiness.json"),
                actuation_payload["artifact_refs"],
            )

    @patch(
        "app.trading.autonomy.lane.evaluate_promotion_prerequisites",
        return_value=PromotionPrerequisiteResult(
            allowed=False,
            reasons=["profitability_stage_manifest_stage_chain_not_passed"],
            required_artifacts=[],
            missing_artifacts=[],
            reason_details=[
                {"reason": "profitability_stage_manifest_stage_chain_not_passed"}
            ],
            artifact_refs=[],
            required_throughput={"signal_count": 1, "decision_count": 1},
            observed_throughput={"signal_count": 1, "decision_count": 1},
        ),
    )
    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=True,
            reasons=[],
            required_checks=[],
            missing_checks=[],
        ),
    )
    def test_lane_marks_actuation_not_allowed_when_profitability_stage_manifest_chain_fails(
        self,
        _mock_rollback: object,
        _mock_promotion_prerequisites: object,
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
            output_dir = Path(tmpdir) / "lane-manifest-chain-fail"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertIn(
                "profitability_stage_manifest_stage_chain_not_passed",
                actuation_payload["gates"]["recommendation_reasons"],
            )
            self.assertIn(
                "profitability_stage_manifest_stage_chain_not_passed",
                actuation_payload["audit"]["promotion_check"]["reasons"],
            )

    @patch(
        "app.trading.autonomy.lane.evaluate_promotion_prerequisites",
    )
    def test_lane_forces_profitability_stage_manifest_requirement_for_policy_check(
        self,
        mock_promotion_prerequisites: object,
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

        call_payload: dict[str, object] = {}

        def _mock_evaluate_promotion_prerequisites(
            *,
            policy_payload: dict[str, Any],
            gate_report_payload: dict[str, Any],
            candidate_state_payload: dict[str, Any],
            promotion_target: str,
            artifact_root: Path,
            now: Any | None = None,
        ) -> PromotionPrerequisiteResult:
            call_payload["policy_payload"] = dict(policy_payload)
            call_payload["artifact_root"] = str(artifact_root)
            call_payload["candidate_state_payload"] = dict(candidate_state_payload)
            return PromotionPrerequisiteResult(
                allowed=False,
                reasons=["profitability_stage_manifest_stage_chain_not_passed"],
                required_artifacts=[],
                missing_artifacts=[],
                reason_details=[],
                artifact_refs=[],
                required_throughput={"signal_count": 1, "decision_count": 1},
                observed_throughput={"signal_count": 1, "decision_count": 1},
            )

        mock_promotion_prerequisites.side_effect = (
            _mock_evaluate_promotion_prerequisites
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-manifest-enforced"
            run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

        policy_payload = call_payload["policy_payload"]
        assert isinstance(policy_payload, dict)
        self.assertTrue(
            policy_payload.get("promotion_require_profitability_stage_manifest")
        )
        self.assertFalse(
            policy_payload.get("promotion_require_jangar_dependency_quorum")
        )
        self.assertNotIn(
            "promotion_jangar_dependency_quorum_required_targets",
            policy_payload,
        )
        self.assertTrue(
            policy_payload.get("promotion_require_alpha_readiness_contract")
        )
        self.assertEqual(
            policy_payload.get("promotion_profitability_stage_manifest_artifact"),
            "profitability/profitability-stage-manifest-v1.json",
        )
        candidate_state_payload = call_payload["candidate_state_payload"]
        assert isinstance(candidate_state_payload, dict)
        self.assertIn("dependencyQuorum", candidate_state_payload)
        self.assertIn("alphaReadiness", candidate_state_payload)

    @patch(
        "app.trading.autonomy.lane.hypothesis_registry_requires_dependency_capability",
        return_value=True,
    )
    @patch(
        "app.trading.autonomy.lane.evaluate_promotion_prerequisites",
    )
    def test_lane_keeps_jangar_policy_targets_when_registry_requires_quorum(
        self,
        mock_promotion_prerequisites: object,
        _mock_requires_dependency_capability: object,
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

        call_payload: dict[str, object] = {}

        def _mock_evaluate_promotion_prerequisites(
            *,
            policy_payload: dict[str, Any],
            gate_report_payload: dict[str, Any],
            candidate_state_payload: dict[str, Any],
            promotion_target: str,
            artifact_root: Path,
            now: Any | None = None,
        ) -> PromotionPrerequisiteResult:
            call_payload["policy_payload"] = dict(policy_payload)
            return PromotionPrerequisiteResult(
                allowed=False,
                reasons=["jangar_dependency_quorum_delay"],
                required_artifacts=[],
                missing_artifacts=[],
                reason_details=[],
                artifact_refs=[],
                required_throughput={"signal_count": 1, "decision_count": 1},
                observed_throughput={"signal_count": 1, "decision_count": 1},
            )

        mock_promotion_prerequisites.side_effect = (
            _mock_evaluate_promotion_prerequisites
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-jangar-policy-enforced"
            run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

        policy_payload = call_payload["policy_payload"]
        assert isinstance(policy_payload, dict)
        self.assertTrue(
            policy_payload.get("promotion_require_jangar_dependency_quorum")
        )
        self.assertEqual(
            policy_payload.get("promotion_jangar_dependency_quorum_required_targets"),
            ["paper", "live"],
        )

    @patch(
        "app.trading.autonomy.lane._evaluate_drift_promotion_gate",
        return_value={
            "allowed": False,
            "artifact_refs": [],
            "eligible_for_live_promotion": False,
            "reasons": ["drift_gate_rejected"],
        },
    )
    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=True,
            reasons=[],
            required_checks=[],
            missing_checks=[],
        ),
    )
    def test_lane_marks_actuation_not_allowed_when_recommendation_ineligible_for_drift(
        self,
        _mock_rollback: object,
        _mock_drift: object,
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
            output_dir = Path(tmpdir) / "lane-drift-ineligible"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertIsNone(result.paper_patch_path)

    @patch(
        "app.trading.autonomy.lane.evaluate_promotion_prerequisites",
    )
    @patch(
        "app.trading.autonomy.lane._resolve_paper_patch_path",
    )
    def test_resolve_paper_patch_path_before_promotion_prerequisites(
        self,
        mock_resolve_patch: object,
        mock_promotion_prerequisites: object,
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
            output_dir = Path(tmpdir) / "lane-order"
            output_dir.mkdir(parents=True, exist_ok=True)

            patch_path = (
                output_dir / "paper-candidate" / "strategy-configmap-patch.yaml"
            )
            patch_path.parent.mkdir(parents=True, exist_ok=True)

            def _mock_resolve_patch(*_args, **_kwargs) -> Path:
                patch_path.write_text(
                    "apiVersion: v1\\nkind: ConfigMap", encoding="utf-8"
                )
                return patch_path

            def _mock_promotion_prerequisites(
                *,
                policy_payload: dict[str, Any],
                gate_report_payload: dict[str, Any],
                candidate_state_payload: dict[str, Any],
                promotion_target: str,
                artifact_root: Path,
                now: datetime | None = None,
            ) -> PromotionPrerequisiteResult:
                self.assertTrue(
                    policy_payload.get("promotion_require_profitability_stage_manifest")
                )
                self.assertEqual(
                    policy_payload.get(
                        "promotion_profitability_stage_manifest_artifact",
                        "profitability/profitability-stage-manifest-v1.json",
                    ),
                    "profitability/profitability-stage-manifest-v1.json",
                )
                self.assertTrue(
                    (
                        artifact_root
                        / "paper-candidate"
                        / "strategy-configmap-patch.yaml"
                    ).exists()
                )
                return PromotionPrerequisiteResult(
                    allowed=False,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                )

            mock_resolve_patch.side_effect = _mock_resolve_patch
            mock_promotion_prerequisites.side_effect = _mock_promotion_prerequisites

            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                strategy_configmap_path=strategy_configmap_path,
                code_version="test-sha",
            )

            self.assertIsNotNone(result.paper_patch_path)
            self.assertTrue(patch_path.exists())

    def test_resolve_paper_patch_path_respects_recommendation_mode(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            strategy_config_path = Path(tmpdir) / "strategy-configmap.yaml"
            strategy_config_path.write_text("{}", encoding="utf-8")
            patch_path = _resolve_paper_patch_path(
                gate_report=GateEvaluationReport(
                    policy_version="v3-gates-1",
                    promotion_target="paper",
                    promotion_allowed=True,
                    recommended_mode="shadow",
                    gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                    reasons=[],
                    uncertainty_gate_action="pass",
                    coverage_error="0.01",
                    conformal_interval_width="1.0",
                    shift_score="0.1",
                    recalibration_run_id=None,
                    evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    code_version="test-sha",
                ),
                strategy_configmap_path=strategy_config_path,
                runtime_strategies=[],
                candidate_id="cand-no-patch",
                promotion_target="paper",
                paper_dir=Path(tmpdir) / "paper-candidate",
            )
            self.assertIsNone(patch_path)

    def test_resolve_paper_patch_path_resolves_for_live_target_when_recommended(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            strategy_config_path = Path(tmpdir) / "strategy-configmap.yaml"
            strategy_config_path.write_text("{}", encoding="utf-8")
            paper_candidate_dir = Path(tmpdir) / "paper-candidate"
            paper_candidate_dir.mkdir(parents=True, exist_ok=True)
            patch_path = _resolve_paper_patch_path(
                gate_report=GateEvaluationReport(
                    policy_version="v3-gates-1",
                    promotion_target="live",
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
                ),
                strategy_configmap_path=strategy_config_path,
                runtime_strategies=[],
                candidate_id="cand-live-patch",
                promotion_target="live",
                paper_dir=paper_candidate_dir,
            )
            self.assertIsNotNone(patch_path)
            self.assertTrue(patch_path.exists())
