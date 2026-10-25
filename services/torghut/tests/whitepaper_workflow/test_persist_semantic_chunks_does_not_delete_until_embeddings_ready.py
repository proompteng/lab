from __future__ import annotations

from tests.whitepaper_workflow.support import (
    Any,
    Session,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDocument,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
    WhitepaperViabilityVerdict,
    _FakeCephClient,
    _TestWhitepaperWorkflowBase,
    _TestWhitepaperWorkflowService,
    cast,
    os,
    patch,
    select,
)


class TestPersistSemanticChunksDoesNotDeleteUntilEmbeddingsReady(
    _TestWhitepaperWorkflowBase
):
    def test_persist_semantic_chunks_does_not_delete_until_embeddings_ready(
        self,
    ) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            self.assertIsNotNone(run_row.document_version)

            statement_log: list[str] = []

            def _fake_execute(statement: Any, *args: Any, **kwargs: Any):
                statement_log.append(str(statement))

                class _DummyResult:
                    def mappings(self) -> "_DummyResult":
                        return self

                    def first(self) -> None:
                        return None

                return _DummyResult()

            with patch.object(session, "execute", side_effect=_fake_execute):
                service.embed_texts_handler = lambda _texts: (_ for _ in ()).throw(
                    RuntimeError("embedding service unavailable")
                )
                with self.assertRaises(RuntimeError):
                    service.persist_semantic_chunks_and_embeddings(
                        session,
                        run=run_row,
                        source_scope="synthesis",
                        chunks=[{"content": "synthetic finding"}],
                    )

            self.assertEqual(statement_log, [])

    def test_finalize_merges_dspy_eval_report_into_verdict_gating(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            finalize_payload = {
                "status": "completed",
                "synthesis": {
                    "executive_summary": "summary",
                    "confidence": "0.87",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.81",
                    "confidence": "0.84",
                    "requires_followup": False,
                    "gating": {"policy_passed": True},
                    "dspy_eval_report": {
                        "artifact_hash": "a" * 64,
                        "gate_compatibility": "pass",
                        "promotion_recommendation": "paper",
                    },
                },
            }
            service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            session.commit()

            verdict_row = session.execute(
                select(WhitepaperViabilityVerdict)
            ).scalar_one()
            self.assertIsInstance(verdict_row.gating_json, dict)
            assert isinstance(verdict_row.gating_json, dict)
            self.assertIn("dspy_eval_report", verdict_row.gating_json)

    def test_finalize_auto_dispatches_engineering_candidate_and_scales_live(
        self,
    ) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED"] = "true"
        os.environ["WHITEPAPER_ENGINEERING_ROLLOUT_PROFILE"] = "automatic"
        service.submit_agents_agentrun_handler = lambda _payload, *, idempotency_key: {
            "resource": {
                "metadata": {
                    "name": f"engineering-{idempotency_key}",
                    "uid": "uid-eng",
                },
                "status": {"phase": "Pending"},
            }
        }

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session, self._issue_payload(), source="api"
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            finalize_payload = {
                "status": "completed",
                "synthesis": {
                    "executive_summary": "Candidate appears robust and reproducible.",
                    "implementation_plan_md": "Implement candidate and validate deterministically.",
                    "confidence": "0.95",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.96",
                    "confidence": "0.97",
                    "requires_followup": False,
                    "gating_json": {
                        "gates": {
                            "G1": {"status": "pass"},
                            "G2": {"status": "pass"},
                            "G3": {"status": "pass"},
                            "G4": {"status": "pass"},
                            "G5": {"status": "pass"},
                            "G6": {"status": "pass"},
                            "G7": {"status": "pass"},
                        }
                    },
                },
            }
            result = service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            session.commit()

            trigger_payload = result.get("engineering_trigger", {})
            self.assertEqual(
                trigger_payload.get("implementation_grade"), "engineering_priority"
            )
            self.assertEqual(trigger_payload.get("decision"), "dispatched")
            self.assertEqual(trigger_payload.get("rollout_profile"), "automatic")
            rollout = cast(
                list[dict[str, Any]], trigger_payload.get("rollout_transitions") or []
            )
            self.assertGreaterEqual(len(rollout), 4)
            self.assertEqual(rollout[-1].get("to_stage"), "scaled_live")
            self.assertEqual(rollout[-1].get("status"), "passed")

            trigger_row = session.execute(
                select(WhitepaperEngineeringTrigger)
            ).scalar_one()
            self.assertEqual(trigger_row.implementation_grade, "engineering_priority")
            self.assertEqual(trigger_row.decision, "dispatched")
            self.assertEqual(trigger_row.rollout_profile, "automatic")

            rollout_rows = (
                session.execute(select(WhitepaperRolloutTransition)).scalars().all()
            )
            self.assertTrue(
                any(
                    row.to_stage == "scaled_live" and row.status == "passed"
                    for row in rollout_rows
                )
            )

    def test_finalize_uses_persisted_verdict_fields_for_deterministic_reason_codes(
        self,
    ) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED"] = "true"

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session, self._issue_payload(), source="api"
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            first_result = service.finalize_run(
                session,
                run_id=run_row.run_id,
                payload={
                    "status": "completed",
                    "synthesis": {
                        "executive_summary": "Candidate requires more evidence and confidence uplift.",
                        "implementation_plan_md": "Hold implementation pending manual review.",
                    },
                    "verdict": {
                        "verdict": "conditional_implement",
                        "score": "0.61",
                        "confidence": "0.52",
                        "requires_followup": True,
                        "gating_json": {
                            "blocked": True,
                            "blocking_reasons": ["Needs external validation"],
                            "gates": {
                                "G1": {"status": "pass"},
                                "G2": {"status": "pass"},
                                "G3": {"status": "pass"},
                                "G4": {"status": "pass"},
                                "G5": {"status": "pass"},
                            },
                        },
                    },
                },
            )
            session.commit()

            second_result = service.finalize_run(
                session,
                run_id=run_row.run_id,
                payload={"status": "completed"},
            )
            session.commit()

            first_trigger = cast(dict[str, Any], first_result["engineering_trigger"])
            second_trigger = cast(dict[str, Any], second_result["engineering_trigger"])
            expected_reason_codes = [
                "confidence_below_min",
                "gating_blocked_flag_true",
                "gating_blocker_needs_external_validation",
                "requires_followup_true",
                "score_below_min",
            ]

            self.assertEqual(first_trigger["implementation_grade"], "reject")
            self.assertEqual(first_trigger["decision"], "suppressed")
            self.assertEqual(
                sorted(cast(list[str], first_trigger["reason_codes"])),
                sorted(expected_reason_codes),
            )
            self.assertEqual(
                first_trigger["reason_codes"], second_trigger["reason_codes"]
            )
            self.assertEqual(
                second_trigger["gate_snapshot_hash"],
                first_trigger["gate_snapshot_hash"],
            )

            trigger_row = session.execute(
                select(WhitepaperEngineeringTrigger)
            ).scalar_one()
            self.assertEqual(
                sorted(cast(list[str], trigger_row.reason_codes_json or [])),
                sorted(expected_reason_codes),
            )
            self.assertEqual(trigger_row.implementation_grade, "reject")
            self.assertEqual(trigger_row.decision, "suppressed")

    def test_finalize_retry_preserves_existing_engineering_dispatch(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED"] = "true"
        os.environ["WHITEPAPER_ENGINEERING_ROLLOUT_PROFILE"] = "automatic"

        submit_calls = {"count": 0}

        def _fake_submit(
            _payload: dict[str, Any], *, idempotency_key: str
        ) -> dict[str, Any]:
            submit_calls["count"] += 1
            return {
                "resource": {
                    "metadata": {
                        "name": f"engineering-{idempotency_key}",
                        "uid": "uid-eng",
                    },
                    "status": {"phase": "Pending"},
                }
            }

        service.submit_agents_agentrun_handler = _fake_submit

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session, self._issue_payload(), source="api"
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            finalize_payload = {
                "status": "completed",
                "synthesis": {
                    "executive_summary": "Candidate appears robust and reproducible.",
                    "implementation_plan_md": "Implement candidate and validate deterministically.",
                    "confidence": "0.95",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.96",
                    "confidence": "0.97",
                    "requires_followup": False,
                    "gating_json": {
                        "gates": {
                            "G1": {"status": "pass"},
                            "G2": {"status": "pass"},
                            "G3": {"status": "pass"},
                            "G4": {"status": "pass"},
                            "G5": {"status": "pass"},
                            "G6": {"status": "pass"},
                            "G7": {"status": "pass"},
                        }
                    },
                },
            }

            first_finalize = service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            session.commit()
            second_finalize = service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            session.commit()

            self.assertEqual(submit_calls["count"], 1)

            first_trigger = cast(dict[str, Any], first_finalize["engineering_trigger"])
            second_trigger = cast(
                dict[str, Any], second_finalize["engineering_trigger"]
            )
            self.assertEqual(first_trigger["decision"], "dispatched")
            self.assertEqual(second_trigger["decision"], "dispatched")
            self.assertEqual(
                second_trigger["dispatched_agentrun_name"],
                first_trigger["dispatched_agentrun_name"],
            )

            trigger_row = session.execute(
                select(WhitepaperEngineeringTrigger)
            ).scalar_one()
            self.assertEqual(trigger_row.decision, "dispatched")
            self.assertIsNotNone(trigger_row.dispatched_agentrun_name)

            agentruns = session.execute(select(WhitepaperCodexAgentRun)).scalars().all()
            self.assertEqual(len(agentruns), 1)

    def test_manual_approval_dispatches_non_eligible_run_with_audit_fields(
        self,
    ) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED"] = "true"
        service.submit_agents_agentrun_handler = lambda _payload, *, idempotency_key: {
            "resource": {
                "metadata": {
                    "name": f"manual-{idempotency_key}",
                    "uid": "uid-manual",
                },
                "status": {"phase": "Pending"},
            }
        }

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session, self._issue_payload(), source="api"
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            service.finalize_run(
                session,
                run_id=run_row.run_id,
                payload={
                    "status": "completed",
                    "synthesis": {
                        "executive_summary": "Needs human judgement due weak confidence.",
                        "implementation_plan_md": "Hold for manual decision.",
                    },
                    "verdict": {
                        "verdict": "conditional_implement",
                        "score": "0.52",
                        "confidence": "0.45",
                        "requires_followup": True,
                        "gating_json": {
                            "gates": {
                                "G1": {"status": "pass"},
                                "G2": {"status": "pass"},
                                "G3": {"status": "pass"},
                                "G4": {"status": "pass"},
                                "G5": {"status": "pass"},
                            }
                        },
                    },
                },
            )
            session.commit()

            trigger_before = session.execute(
                select(WhitepaperEngineeringTrigger)
            ).scalar_one()
            self.assertEqual(trigger_before.decision, "suppressed")
            self.assertEqual(trigger_before.implementation_grade, "reject")

            approval_result = service.approve_for_engineering(
                session,
                run_id=run_row.run_id,
                approved_by="ops@example.com",
                approval_reason="Manual override after reviewing citations and constraints.",
                approval_source="jangar_ui",
                target_scope="B1 candidate only",
            )
            session.commit()

            trigger_payload = cast(
                dict[str, Any], approval_result["engineering_trigger"]
            )
            self.assertEqual(trigger_payload["decision"], "dispatched")
            self.assertEqual(trigger_payload["approval_source"], "jangar_ui")
            self.assertEqual(trigger_payload["approved_by"], "ops@example.com")
            self.assertIn(
                "manual_override_applied",
                cast(list[str], trigger_payload["reason_codes"]),
            )

            trigger_after = session.execute(
                select(WhitepaperEngineeringTrigger)
            ).scalar_one()
            self.assertEqual(trigger_after.approval_source, "jangar_ui")
            self.assertEqual(trigger_after.approved_by, "ops@example.com")
            self.assertIsNotNone(trigger_after.approved_at)
            self.assertEqual(
                trigger_after.approval_reason,
                "Manual override after reviewing citations and constraints.",
            )
            self.assertEqual(trigger_after.decision, "dispatched")

    def test_manual_approval_automatic_rollout_blocks_and_rolls_back_on_gate_failure(
        self,
    ) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED"] = "true"
        service.submit_agents_agentrun_handler = lambda _payload, *, idempotency_key: {
            "resource": {
                "metadata": {
                    "name": f"manual-{idempotency_key}",
                    "uid": "uid-manual",
                },
                "status": {"phase": "Pending"},
            }
        }

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session, self._issue_payload(), source="api"
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            service.finalize_run(
                session,
                run_id=run_row.run_id,
                payload={
                    "status": "completed",
                    "synthesis": {
                        "executive_summary": "Candidate needs manual approval due live ramp gate concern.",
                        "implementation_plan_md": "Allow B1 with strict rollout checks.",
                    },
                    "verdict": {
                        "verdict": "implement",
                        "score": "0.95",
                        "confidence": "0.96",
                        "requires_followup": False,
                        "gating_json": {
                            "gates": {
                                "G1": {"status": "pass"},
                                "G2": {"status": "pass"},
                                "G3": {"status": "pass"},
                                "G4": {"status": "pass"},
                                "G5": {"status": "pass"},
                                "G6": {"status": "pass"},
                                "G7": {"status": "fail"},
                            }
                        },
                    },
                },
            )
            session.commit()

            approval_result = service.approve_for_engineering(
                session,
                run_id=run_row.run_id,
                approved_by="ops@example.com",
                approval_reason="Proceed with automatic rollout profile to validate fail-closed rollback.",
                approval_source="jangar_ui",
                rollout_profile="automatic",
            )
            session.commit()

            trigger_payload = cast(
                dict[str, Any], approval_result["engineering_trigger"]
            )
            self.assertEqual(trigger_payload["decision"], "dispatched")
            rollout = cast(list[dict[str, Any]], trigger_payload["rollout_transitions"])
            self.assertTrue(
                any(item.get("transition_type") == "rollback" for item in rollout)
            )
            self.assertTrue(
                any(item.get("transition_type") == "halt" for item in rollout)
            )
            self.assertTrue(any(item.get("status") == "halted" for item in rollout))

            rollout_rows = (
                session.execute(select(WhitepaperRolloutTransition)).scalars().all()
            )
            self.assertTrue(
                any(row.transition_type == "rollback" for row in rollout_rows)
            )
            self.assertTrue(any(row.status == "halted" for row in rollout_rows))

    def test_build_whitepaper_prompt_requires_implementation_plan_md(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            agentrun_row = session.execute(select(WhitepaperCodexAgentRun)).scalar_one()
            self.assertIn("implementation_plan_md", agentrun_row.prompt_text or "")

    def test_marker_subject_tags_and_analysis_mode_are_persisted(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(
                    marker_overrides={
                        "subject": "healthcare",
                        "tags": "biostats, causality , paper-review",
                        "analysis_mode": "analysis_only",
                    }
                ),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            document = session.execute(select(WhitepaperDocument)).scalar_one()
            self.assertEqual(
                document.tags_json, ["biostats", "causality", "paper_review"]
            )
            self.assertIsInstance(document.metadata_json, dict)
            assert isinstance(document.metadata_json, dict)
            self.assertEqual(document.metadata_json.get("subject"), "healthcare")
            self.assertEqual(
                document.metadata_json.get("analysis_mode"), "analysis_only"
            )

            run = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            self.assertIsInstance(run.analysis_profile_json, dict)
            assert isinstance(run.analysis_profile_json, dict)
            self.assertEqual(run.analysis_profile_json.get("subject"), "healthcare")
            self.assertEqual(
                run.analysis_profile_json.get("tags"),
                ["biostats", "causality", "paper_review"],
            )
            self.assertEqual(
                run.analysis_profile_json.get("analysis_mode"), "analysis_only"
            )

    def test_analysis_only_prompt_omits_pr_requirement(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(
                    marker_overrides={
                        "analysis_mode": "analysis_only",
                        "subject": "economics",
                    }
                ),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            agentrun_row = session.execute(select(WhitepaperCodexAgentRun)).scalar_one()
            prompt_text = agentrun_row.prompt_text or ""
            self.assertIn("Analysis mode: analysis_only", prompt_text)
            self.assertIn("Do not open a PR in analysis-only mode.", prompt_text)
            self.assertNotIn("Open a PR from a codex/* branch", prompt_text)

    def test_failed_run_replay_is_idempotent_without_duplicate_rows(self) -> None:
        service = _TestWhitepaperWorkflowService()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"

        with Session(self.engine) as session:
            service.ceph_client = None
            service.download_pdf_handler = lambda _url: b"%PDF-1.7 first"
            first = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(first.accepted)
            self.assertEqual(first.reason, "failed")
            self.assertIsNotNone(first.run_id)
            session.commit()

            service.ceph_client = _FakeCephClient()
            service.download_pdf_handler = lambda _url: b"%PDF-1.7 retry"
            replay = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(replay.accepted)
            self.assertEqual(replay.reason, "idempotent_replay")
            assert first.run_id is not None
            self.assertEqual(replay.run_id, first.run_id)
            session.commit()

            runs = session.execute(select(WhitepaperAnalysisRun)).scalars().all()
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].run_id, first.run_id)
            self.assertEqual(runs[0].status, "failed")
