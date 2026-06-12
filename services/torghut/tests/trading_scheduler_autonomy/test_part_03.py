from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.trading_scheduler_autonomy.support import *


class TestTradingSchedulerAutonomyPart3(_TestTradingSchedulerAutonomyBase):
    def test_append_runtime_governance_ignores_stale_rollback_evidence_when_not_triggered(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            stale_incident_path = Path(tmpdir) / "stale-incident.json"
            stale_incident_path.write_text(
                json.dumps({"trigger": "historical-stop"}),
                encoding="utf-8",
            )
            scheduler.state.drift_last_detection_path = str(stale_incident_path)
            scheduler.state.drift_last_action_path = str(stale_incident_path)
            scheduler.state.drift_last_outcome_path = str(stale_incident_path)
            scheduler.state.rollback_incident_evidence_path = str(stale_incident_path)

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-stale",
                "candidate_id": "cand-stale",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "rollback-proof", "status": "pass", "artifact_refs": []},
                ],
                "runtime_governance": {"rollback_triggered": False},
                "rollback_proof": {"rollback_triggered": False},
                "artifact_refs": [],
                "phase_count": 7,
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2),
                encoding="utf-8",
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={"drift_status": "stable", "reasons": []},
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"],
                "",
            )
            self.assertNotIn(
                str(stale_incident_path),
                updated_manifest["rollback_proof"]["artifact_refs"],
            )
            self.assertNotIn(
                str(stale_incident_path), updated_manifest["artifact_refs"]
            )
            self.assertEqual(updated_manifest["phases"][-1]["status"], "pass")
            self.assertEqual(updated_manifest["status"], "pass")

    def test_append_runtime_governance_ignores_non_triggered_payload_rollback_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, _deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )
            explicit_evidence_path = Path(tmpdir) / "explicit-incident.json"
            explicit_evidence_path.write_text(
                json.dumps({"rollback": "expected_if_triggered"}),
                encoding="utf-8",
            )

            manifest_path = Path(tmpdir) / "rollout" / "phase-manifest.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_payload = {
                "schema_version": "autonomy-phase-manifest-v1",
                "run_id": "run-evidence-ignore",
                "candidate_id": "cand-evidence-ignore",
                "phases": [
                    {
                        "name": "gate-evaluation",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "promotion-prerequisites",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-readiness",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {"name": "drift-gate", "status": "pass", "artifact_refs": []},
                    {"name": "paper-canary", "status": "pass", "artifact_refs": []},
                    {
                        "name": "runtime-governance",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                    {
                        "name": "rollback-proof",
                        "status": "pass",
                        "artifact_refs": [],
                    },
                ],
                "runtime_governance": {"rollback_triggered": False},
                "rollback_proof": {
                    "rollback_triggered": False,
                    "rollback_incident_evidence": "",
                    "rollback_incident_evidence_path": "",
                },
                "artifact_refs": [],
                "phase_count": 7,
            }
            manifest_path.write_text(
                json.dumps(manifest_payload, indent=2),
                encoding="utf-8",
            )

            scheduler._append_runtime_governance_to_phase_manifest(
                manifest_path=manifest_path,
                requested_promotion_target="paper",
                drift_governance_payload={
                    "drift_status": "stable",
                    "reasons": [],
                    "rollback_triggered": False,
                    "rollback_incident_evidence": str(explicit_evidence_path),
                    "action": {"action_type": "none", "triggered": False},
                    "detection": {"reason_codes": []},
                },
                now=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            updated_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(updated_manifest["status"], "pass")
            self.assertEqual(
                updated_manifest["rollback_proof"]["rollback_incident_evidence"],
                "",
            )
            self.assertNotIn(
                str(explicit_evidence_path),
                updated_manifest["rollback_proof"]["artifact_refs"],
            )
            self.assertNotIn(
                str(explicit_evidence_path),
                updated_manifest["artifact_refs"],
            )
            self.assertEqual(updated_manifest["phases"][-1]["status"], "pass")

    def test_run_autonomy_cycle_appends_runtime_governance_with_canary_failure(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            scheduler, deps = self._build_scheduler_with_fixtures(
                tmpdir,
                allow_live=False,
                approval_token=None,
            )

            def _fake_run_autonomous_lane_with_canary_failure(
                **kwargs: Any,
            ) -> SimpleNamespace:
                deps.call_kwargs = kwargs
                deps.call_kwargs["promotion_target"] = kwargs.get("promotion_target")
                deps.call_kwargs["approval_token"] = kwargs.get("approval_token")

                output_dir = kwargs["output_dir"]
                gate_report_path = output_dir / "gate-evaluation.json"
                gate_payload = {
                    "recommended_mode": "paper",
                    "gates": [],
                    "throughput": {
                        "signal_count": 4,
                        "decision_count": 3,
                        "trade_count": 1,
                    },
                }
                gate_report_path.write_text(
                    json.dumps(gate_payload, indent=2),
                    encoding="utf-8",
                )
                deps.gate_report_path = gate_report_path

                gates_dir = output_dir / "gates"
                gates_dir.mkdir(parents=True, exist_ok=True)
                actuation_intent_path = gates_dir / "actuation-intent.json"
                actuation_payload = {
                    "schema_version": "torghut.autonomy.actuation-intent.v1",
                    "run_id": "canary-fail",
                    "candidate_id": "cand-canary-fail",
                    "actuation_allowed": True,
                    "gates": {
                        "recommendation_trace_id": "rec-trace-canary-fail",
                        "gate_report_trace_id": "gate-trace-canary-fail",
                        "recommendation_reasons": ["unit-test"],
                    },
                }
                actuation_intent_path.write_text(
                    json.dumps(actuation_payload, indent=2),
                    encoding="utf-8",
                )
                deps.actuation_intent_path = actuation_intent_path

                rollout_dir = output_dir / "rollout"
                rollout_dir.mkdir(parents=True, exist_ok=True)
                phase_manifest_path = rollout_dir / "phase-manifest.json"
                phase_manifest_path.write_text(
                    json.dumps(
                        {
                            "schema_version": "autonomy-phase-manifest-v1",
                            "run_id": "canary-fail",
                            "candidate_id": "cand-canary-fail",
                            "phases": [
                                {
                                    "name": "gate-evaluation",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "promotion-prerequisites",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "rollback-readiness",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "drift-gate",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "paper-canary",
                                    "status": "fail",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "runtime-governance",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                                {
                                    "name": "rollback-proof",
                                    "status": "pass",
                                    "artifact_refs": [],
                                },
                            ],
                            "runtime_governance": {"rollback_triggered": False},
                            "rollback_proof": {"rollback_triggered": False},
                            "artifact_refs": [str(phase_manifest_path)],
                            "phase_count": 7,
                        },
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                deps.phase_manifest_path = phase_manifest_path

                return SimpleNamespace(
                    run_id="canary-fail",
                    candidate_id="cand-canary-fail",
                    output_dir=output_dir,
                    gate_report_path=gate_report_path,
                    actuation_intent_path=actuation_intent_path,
                    paper_patch_path=None,
                    phase_manifest_path=phase_manifest_path,
                )

            drift_payload = {
                "drift_status": "stable",
                "reasons": ["drift_stable"],
                "detection": {"reason_codes": []},
                "action": {"action_type": "none", "triggered": False},
                "rollback_triggered": False,
            }

            with patch(
                "app.trading.scheduler.governance.run_autonomous_lane",
                side_effect=_fake_run_autonomous_lane_with_canary_failure,
            ):
                with patch(
                    "app.trading.scheduler.runtime.TradingScheduler._evaluate_drift_governance",
                    return_value=drift_payload,
                ):
                    scheduler._run_autonomous_cycle()

            manifest_path = deps.phase_manifest_path
            self.assertIsNotNone(manifest_path)
            assert manifest_path is not None
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["phases"][4]["status"],
                "fail",
            )
            phase_transitions_by_to = {
                (transition.get("from"), transition.get("to")): transition.get("status")
                for transition in manifest["phase_transitions"]
                if isinstance(transition, dict)
            }
            self.assertEqual(
                phase_transitions_by_to[("drift-gate", "paper-canary")],
                "fail",
            )
            self.assertEqual(
                phase_transitions_by_to[("paper-canary", "runtime-governance")],
                "pass",
            )
            self.assertEqual(manifest["status"], "fail")
