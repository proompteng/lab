from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.whitepaper_workflow.support import *


class TestWhitepaperWorkflowPart1(_TestWhitepaperWorkflowBase):
    def test_marker_and_attachment_parsing(self) -> None:
        body = """
foo
<!-- TORGHUT_WHITEPAPER:START -->
workflow: whitepaper-analysis-v1
repo: proompteng/lab
<!-- TORGHUT_WHITEPAPER:END -->
https://example.com/paper.pdf
"""
        marker = parse_marker_block(body)
        self.assertIsNotNone(marker)
        assert marker is not None
        self.assertEqual(marker["workflow"], "whitepaper-analysis-v1")

        urls = extract_pdf_urls(body)
        self.assertEqual(urls, ["https://example.com/paper.pdf"])

    def test_extract_pdf_text_uses_pypdf_fallback(self) -> None:
        from pypdf import PdfWriter

        writer = PdfWriter()
        writer.add_blank_page(width=300, height=300)

        with tempfile.NamedTemporaryFile(suffix=".pdf") as handle:
            writer.write(handle)
            handle.flush()
            handle.seek(0)
            pdf_bytes = handle.read()

        with patch.object(
            WhitepaperWorkflowService,
            "_extract_pdf_text_with_pdftotext",
            return_value=None,
        ):
            extracted = WhitepaperWorkflowService()._extract_pdf_text(pdf_bytes)

        self.assertEqual(extracted["metadata"]["extract_method"], "pypdf")
        self.assertEqual(extracted["metadata"]["page_count"], 1)

    def test_normalize_github_issue_event(self) -> None:
        event = normalize_github_issue_event(self._issue_payload())
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.repository, "proompteng/lab")
        self.assertEqual(event.issue_number, 42)

    def test_normalize_issue_comment_event_with_requeue_keyword(self) -> None:
        payload = self._issue_comment_payload(comment_body="research whitepaper")
        event = normalize_github_issue_event(payload)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.event_name, "issue_comment")
        self.assertTrue(event.requeue_requested)

    def test_comment_requeue_keyword_match(self) -> None:
        self.assertTrue(
            comment_requests_requeue("Please retry with research whitepaper")
        )
        self.assertFalse(comment_requests_requeue("No retry keyword here"))

    def test_run_id_is_deterministic_for_same_issue_and_pdf(self) -> None:
        run_id_one = build_whitepaper_run_id(
            source_identifier="proompteng/lab#42",
            attachment_url="https://github.com/user-attachments/files/12345/sample-paper.pdf",
        )
        run_id_two = build_whitepaper_run_id(
            source_identifier="proompteng/lab#42",
            attachment_url="https://github.com/user-attachments/files/12345/sample-paper.pdf",
        )
        self.assertEqual(run_id_one, run_id_two)

    def test_ceph_client_prefers_mounted_secret_and_config_over_stale_env(self) -> None:
        with (
            tempfile.TemporaryDirectory() as secret_dir,
            tempfile.TemporaryDirectory() as config_dir,
        ):
            os.environ["WHITEPAPER_CEPH_SECRET_DIR"] = secret_dir
            os.environ["WHITEPAPER_CEPH_CONFIG_DIR"] = config_dir
            os.environ["WHITEPAPER_CEPH_ACCESS_KEY"] = "stale-access"
            os.environ["WHITEPAPER_CEPH_SECRET_KEY"] = "stale-secret"
            os.environ["WHITEPAPER_CEPH_BUCKET_HOST"] = "stale-host"
            os.environ["WHITEPAPER_CEPH_BUCKET_PORT"] = "9000"

            with open(
                os.path.join(secret_dir, "AWS_ACCESS_KEY_ID"), "w", encoding="utf-8"
            ) as handle:
                handle.write("fresh-access\n")
            with open(
                os.path.join(secret_dir, "AWS_SECRET_ACCESS_KEY"), "w", encoding="utf-8"
            ) as handle:
                handle.write("fresh-secret\n")
            with open(
                os.path.join(config_dir, "BUCKET_HOST"), "w", encoding="utf-8"
            ) as handle:
                handle.write("rook-ceph-rgw-objectstore.rook-ceph.svc\n")
            with open(
                os.path.join(config_dir, "BUCKET_PORT"), "w", encoding="utf-8"
            ) as handle:
                handle.write("80\n")

            client = CephS3Client.from_env()

            self.assertIsNotNone(client)
            assert client is not None
            self.assertEqual(client.access_key, "fresh-access")
            self.assertEqual(client.secret_key, "fresh-secret")
            self.assertEqual(
                client.endpoint, "http://rook-ceph-rgw-objectstore.rook-ceph.svc:80"
            )

    @patch("app.whitepapers.workflow.CephS3Client.from_env")
    def test_store_issue_pdf_refreshes_runtime_ceph_client_and_bucket_name(
        self, mock_from_env: Any
    ) -> None:
        with tempfile.TemporaryDirectory() as config_dir:
            os.environ["WHITEPAPER_CEPH_CONFIG_DIR"] = config_dir
            os.environ["WHITEPAPER_CEPH_BUCKET"] = "stale-bucket"
            with open(
                os.path.join(config_dir, "BUCKET_NAME"), "w", encoding="utf-8"
            ) as handle:
                handle.write("fresh-bucket\n")

            fake_ceph = _FakeCephClient()
            mock_from_env.side_effect = [None, fake_ceph]

            service = WhitepaperWorkflowService()
            service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]

            outcome = service._store_issue_pdf(
                attachment_url="https://example.com/paper.pdf"
            )

            self.assertEqual(mock_from_env.call_count, 2)
            self.assertEqual(outcome.ceph_bucket, "fresh-bucket")
            self.assertEqual(outcome.parse_status, "stored")

    def test_dispatch_uses_github_issue_number_from_issue_url_for_replay_payloads(
        self,
    ) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]

        submitted_payloads: list[dict[str, Any]] = []

        def _fake_submit(
            payload: dict[str, Any], *, idempotency_key: str
        ) -> dict[str, Any]:
            submitted_payloads.append(payload)
            return {
                "ok": True,
                "resource": {
                    "metadata": {"name": f"agentrun-{idempotency_key}", "uid": "uid-1"},
                    "status": {"phase": "Pending"},
                },
            }

        service._submit_agents_agentrun = _fake_submit  # type: ignore[method-assign]
        replay_payload = self._issue_payload(issue_number=900000004)
        replay_issue = cast(dict[str, Any], replay_payload["issue"])
        replay_issue["html_url"] = "https://github.com/proompteng/lab/issues/3592"

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                replay_payload,
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            self.assertEqual(len(submitted_payloads), 1)
            self.assertEqual(submitted_payloads[0]["parameters"]["issueNumber"], "3592")
            self.assertEqual(
                submitted_payloads[0]["parameters"]["issueUrl"],
                "https://github.com/proompteng/lab/issues/3592",
            )

    def test_comment_without_keyword_is_ignored(self) -> None:
        service = WhitepaperWorkflowService()
        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_comment_payload(comment_body="please rerun"),
                source="api",
            )
            self.assertFalse(kickoff.accepted)
            self.assertEqual(kickoff.reason, "comment_without_requeue_keyword")

    def test_ingest_and_finalize_flow(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        service._submit_agents_agentrun = (  # type: ignore[method-assign]
            lambda _payload, *, idempotency_key: {
                "ok": True,
                "resource": {
                    "metadata": {"name": f"agentrun-{idempotency_key}", "uid": "uid-1"},
                    "status": {"phase": "Pending"},
                },
            }
        )

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            self.assertEqual(kickoff.reason, "queued")
            self.assertIsNotNone(kickoff.run_id)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            self.assertEqual(run_row.status, "agentrun_dispatched")

            doc_row = session.execute(select(WhitepaperDocument)).scalar_one()
            self.assertEqual(doc_row.source, "github_issue")

            version_row = session.execute(
                select(WhitepaperDocumentVersion)
            ).scalar_one()
            self.assertEqual(version_row.parse_status, "stored")

            agentrun_row = session.execute(select(WhitepaperCodexAgentRun)).scalar_one()
            self.assertTrue(agentrun_row.agentrun_name.startswith("agentrun-"))

            finalize_payload = {
                "status": "completed",
                "synthesis": {
                    "executive_summary": "Strong approach with reproducible results.",
                    "key_findings": ["f1", "f2"],
                    "implementation_implications": [
                        "Capture deterministic manifests.",
                        "Add walk-forward gates.",
                    ],
                    "confidence": "0.87",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.81",
                    "confidence": "0.84",
                    "requires_followup": False,
                },
                "design_pull_request": {
                    "attempt": 1,
                    "status": "opened",
                    "repository": "proompteng/lab",
                    "base_branch": "main",
                    "head_branch": "codex/whitepaper-42",
                    "pr_number": 1234,
                    "pr_url": "https://github.com/proompteng/lab/pull/1234",
                },
            }
            result = service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            self.assertEqual(result["status"], "completed")
            session.commit()

            synthesis_row = session.execute(select(WhitepaperSynthesis)).scalar_one()
            self.assertIn("Strong approach", synthesis_row.executive_summary)
            self.assertEqual(
                synthesis_row.implementation_plan_md,
                "- Capture deterministic manifests.\n- Add walk-forward gates.",
            )
            self.assertIsInstance(synthesis_row.synthesis_json, dict)
            assert isinstance(synthesis_row.synthesis_json, dict)
            self.assertEqual(
                synthesis_row.synthesis_json.get("implementation_plan_md"),
                "- Capture deterministic manifests.\n- Add walk-forward gates.",
            )

            verdict_row = session.execute(
                select(WhitepaperViabilityVerdict)
            ).scalar_one()
            self.assertEqual(verdict_row.verdict, "implement")

            pr_row = session.execute(select(WhitepaperDesignPullRequest)).scalar_one()
            self.assertEqual(pr_row.pr_number, 1234)

    def test_finalize_preserves_explicit_implementation_plan_md(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        service._submit_agents_agentrun = (  # type: ignore[method-assign]
            lambda _payload, *, idempotency_key: {
                "ok": True,
                "resource": {
                    "metadata": {"name": f"agentrun-{idempotency_key}", "uid": "uid-1"},
                    "status": {"phase": "Pending"},
                },
            }
        )

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
                    "executive_summary": "Strong approach with reproducible results.",
                    "implementation_plan_md": "### Delivery Plan\n- Keep explicit plan",
                    "implementation_implications": [
                        "Should not overwrite explicit value."
                    ],
                    "confidence": "0.87",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.81",
                    "confidence": "0.84",
                    "requires_followup": False,
                },
            }
            service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            session.commit()

            synthesis_row = session.execute(select(WhitepaperSynthesis)).scalar_one()
            self.assertEqual(
                synthesis_row.implementation_plan_md,
                "### Delivery Plan\n- Keep explicit plan",
            )
            self.assertIsInstance(synthesis_row.synthesis_json, dict)
            assert isinstance(synthesis_row.synthesis_json, dict)
            self.assertEqual(
                synthesis_row.synthesis_json.get("implementation_plan_md"),
                "### Delivery Plan\n- Keep explicit plan",
            )

    def test_finalize_falls_back_to_local_indexing_when_finalize_enqueue_fails(
        self,
    ) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_SEMANTIC_INDEXING_ENABLED"] = "true"
        os.environ["WHITEPAPER_INNGEST_ENABLED"] = "true"
        service.set_inngest_client(cast(Any, _FakeInngestClient()))

        indexed_run_ids: list[str] = []
        service._enqueue_finalized_inngest_event = lambda _session, *, run: False  # type: ignore[method-assign]
        service.index_synthesis_semantic_content = (  # type: ignore[method-assign]
            lambda _session, *, run_id: (
                indexed_run_ids.append(run_id)
                or {"run_id": run_id, "indexed_chunks": 0}
            )
        )

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
                    "executive_summary": "Strong approach with reproducible results.",
                    "confidence": "0.87",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.81",
                    "confidence": "0.84",
                    "requires_followup": False,
                },
            }
            result = service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            self.assertEqual(result["status"], "completed")
            session.commit()

            self.assertEqual(indexed_run_ids, [run_row.run_id])

    def test_finalize_persists_claim_graph_and_compiled_experiments(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        service._submit_agents_agentrun = (  # type: ignore[method-assign]
            lambda _payload, *, idempotency_key: {
                "ok": True,
                "resource": {
                    "metadata": {"name": f"agentrun-{idempotency_key}", "uid": "uid-1"},
                    "status": {"phase": "Pending"},
                },
            }
        )

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
                    "executive_summary": "Normalization and activity constraints matter.",
                    "confidence": "0.88",
                    "claims": [
                        {
                            "claim_id": "claim-1",
                            "claim_type": "normalization_rule",
                            "claim_text": "Normalization should match the execution mechanism.",
                            "asset_scope": "us_equities_intraday",
                            "horizon_scope": "intraday",
                            "expected_direction": "positive",
                            "confidence": "0.74",
                        },
                        {
                            "claim_id": "claim-2",
                            "claim_type": "negative_result",
                            "claim_text": "The same rule fails under stressed quote-quality regimes.",
                            "asset_scope": "us_equities_intraday",
                            "horizon_scope": "intraday",
                            "expected_direction": "negative",
                            "confidence": "0.69",
                        },
                    ],
                    "claim_relations": [
                        {
                            "relation_id": "rel-1",
                            "relation_type": "contradicts",
                            "source_claim_id": "claim-2",
                            "target_claim_id": "claim-1",
                            "target_run_id": "prior-run",
                            "rationale": "Stress regimes invalidate the earlier broad claim.",
                            "confidence": "0.81",
                        }
                    ],
                    "strategy_templates": [
                        {
                            "template_id": "template-1",
                            "family_template_id": "microstructure_continuation_matched_filter_v1",
                            "economic_mechanism": "Continuation after information-arrival bursts with matched-filter normalization.",
                            "hypothesis": "Matched-filter normalization improves continuation robustness.",
                            "allowed_normalizations": [
                                "trading_value_scaled",
                                "market_cap_scaled",
                            ],
                            "day_veto_rules": [
                                {"rule": "quote_quality", "action": "block_day"}
                            ],
                        }
                    ],
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.80",
                    "confidence": "0.82",
                    "requires_followup": False,
                },
            }
            result = service.finalize_run(
                session, run_id=run_row.run_id, payload=finalize_payload
            )
            self.assertEqual(result["status"], "completed")
            session.commit()

            claims = session.execute(select(WhitepaperClaim)).scalars().all()
            self.assertEqual(len(claims), 2)

            relations = session.execute(select(WhitepaperClaimRelation)).scalars().all()
            self.assertEqual(len(relations), 1)
            self.assertEqual(relations[0].relation_type, "contradicts")

            templates = (
                session.execute(select(WhitepaperStrategyTemplate)).scalars().all()
            )
            self.assertEqual(len(templates), 1)
            self.assertEqual(
                templates[0].family_template_id,
                "microstructure_continuation_matched_filter_v1",
            )

            experiment_specs = (
                session.execute(select(WhitepaperExperimentSpec)).scalars().all()
            )
            self.assertEqual(len(experiment_specs), 1)
            self.assertEqual(
                experiment_specs[0].family_template_id,
                "microstructure_continuation_matched_filter_v1",
            )
            self.assertIsInstance(experiment_specs[0].payload_json, dict)

            mirrored_vnext = (
                session.execute(select(VNextExperimentSpec)).scalars().all()
            )
            self.assertEqual(len(mirrored_vnext), 1)
            self.assertEqual(mirrored_vnext[0].run_id, run_row.run_id)

            contradiction_events = (
                session.execute(select(WhitepaperContradictionEvent)).scalars().all()
            )
            self.assertEqual(len(contradiction_events), 1)
            self.assertEqual(
                contradiction_events[0].required_action, "revalidate_linked_family"
            )

    def test_structured_output_helpers_cover_direct_nested_and_gating_merge(
        self,
    ) -> None:
        service = WhitepaperWorkflowService()
        direct = service._structured_output_list(  # type: ignore[attr-defined]
            {"claims": [{"claim_id": "claim-1"}]},
            key="claims",
        )
        nested = service._structured_output_list(  # type: ignore[attr-defined]
            {"synthesis": {"claims": [{"claim_id": "claim-2"}]}},
            key="claims",
        )
        compiled = service._compiled_experiment_specs_from_templates(  # type: ignore[attr-defined]
            run_id="run-1",
            claims=[{"claim_id": "claim-1"}],
            relations=[],
            templates=[
                {
                    "template_id": "template-1",
                    "family_template_id": "family-1",
                    "allowed_normalizations": ["matched_filter"],
                    "day_veto_rules": [{"rule": "quote_quality"}],
                }
            ],
        )
        contradictions = service._inferred_contradiction_events(  # type: ignore[attr-defined]
            [
                {
                    "relation_id": "rel-ignore",
                    "relation_type": "supports",
                    "source_claim_id": "claim-1",
                },
                {
                    "relation_id": "rel-missing-source",
                    "relation_type": "conflicts_with",
                },
                {
                    "relation_id": "rel-1",
                    "relation_type": "conflicts_with",
                    "source_claim_id": "claim-2",
                    "target_claim_id": "claim-1",
                },
            ]
        )
        merged = service._build_verdict_gating_payload(  # type: ignore[attr-defined]
            {"dspy_eval_report": {"score": 0.8}}
        )

        self.assertEqual(direct[0]["claim_id"], "claim-1")
        self.assertEqual(nested[0]["claim_id"], "claim-2")
        self.assertEqual(compiled[0]["feature_variants"], ["matched_filter"])
        self.assertEqual(len(contradictions), 1)
        self.assertEqual(contradictions[0]["source_claim_id"], "claim-2")
        self.assertEqual(merged, {"dspy_eval_report": {"score": 0.8}})

    def test_structured_outputs_compile_claims_when_experiment_specs_are_absent(
        self,
    ) -> None:
        service = WhitepaperWorkflowService()
        compiled = service._compiled_experiment_specs_from_templates(  # type: ignore[attr-defined]
            run_id="run-claim-compiler",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
            relations=[],
            templates=[],
        )

        expected_family_profiles = {
            family_template_id: _profile_ids_for_family(family_template_id)
            for family_template_id in candidate_specs_module._FAMILY_EXECUTION_PROFILES
        }
        self.assertEqual(
            len(compiled),
            sum(len(profiles) for profiles in expected_family_profiles.values()),
        )
        family_profiles: dict[str, list[str]] = {}
        for item in compiled:
            candidate_spec = item["candidate_spec"]
            feature_contract = candidate_spec["feature_contract"]
            execution_profile = feature_contract["execution_profile"]
            family_profiles.setdefault(str(item["family_template_id"]), []).append(
                str(execution_profile["profile_id"])
            )
        self.assertEqual(family_profiles, expected_family_profiles)
        self.assertEqual(
            {
                item["selection_objectives"]["target_net_pnl_per_day"]
                for item in compiled
            },
            {"500"},
        )

    def test_sync_structured_outputs_skips_incomplete_records(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(issue_number=43),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(
                select(WhitepaperAnalysisRun).where(
                    WhitepaperAnalysisRun.run_id == kickoff.run_id
                )
            ).scalar_one()

            service._sync_structured_research_outputs(  # type: ignore[attr-defined]
                session,
                run_row,
                {
                    "claims": [
                        {"claim_id": "claim-missing-text"},
                        {"claim_id": "claim-valid", "claim_text": "valid claim"},
                    ],
                    "claim_relations": [
                        {
                            "relation_id": "rel-missing-target",
                            "source_claim_id": "claim-valid",
                        },
                        {
                            "relation_id": "rel-valid",
                            "source_claim_id": "claim-valid",
                            "target_claim_id": "claim-valid",
                        },
                    ],
                    "strategy_templates": [
                        {
                            "template_id": "template-missing-mechanism",
                            "family_template_id": "family-1",
                        },
                        {
                            "template_id": "template-valid",
                            "family_template_id": "family-1",
                            "economic_mechanism": "valid mechanism",
                        },
                    ],
                    "experiment_specs": [
                        {"experiment_id": "exp-missing-family"},
                        {
                            "experiment_id": "exp-valid",
                            "family_template_id": "family-1",
                        },
                    ],
                    "contradiction_events": [
                        {"event_id": "event-missing-source"},
                        {"event_id": "event-valid", "source_claim_id": "claim-valid"},
                        {"event_id": "event-valid", "source_claim_id": "claim-valid"},
                    ],
                },
            )
            session.commit()

            self.assertEqual(
                session.execute(select(WhitepaperClaim)).scalars().all()[0].claim_id,
                "claim-valid",
            )
            self.assertEqual(
                len(session.execute(select(WhitepaperClaimRelation)).scalars().all()), 1
            )
            self.assertEqual(
                len(
                    session.execute(select(WhitepaperStrategyTemplate)).scalars().all()
                ),
                1,
            )
            self.assertEqual(
                len(session.execute(select(WhitepaperExperimentSpec)).scalars().all()),
                1,
            )
            self.assertEqual(
                len(
                    session.execute(select(WhitepaperContradictionEvent))
                    .scalars()
                    .all()
                ),
                1,
            )

    def test_finalize_run_propagates_synthesis_indexing_failures(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"
        os.environ["WHITEPAPER_SEMANTIC_INDEXING_ENABLED"] = "true"
        os.environ["WHITEPAPER_INNGEST_ENABLED"] = "true"
        service.set_inngest_client(cast(Any, _FakeInngestClient()))

        service._enqueue_finalized_inngest_event = lambda _session, *, run: False  # type: ignore[method-assign]
        service.index_synthesis_semantic_content = (  # type: ignore[method-assign]
            lambda _session, *, run_id: (_ for _ in ()).throw(
                RuntimeError(f"index failure for run {run_id}")
            )
        )

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            prior_status = run_row.status
            finalize_payload = {
                "status": "completed",
                "synthesis": {
                    "executive_summary": "Strong approach with reproducible results.",
                    "confidence": "0.87",
                },
                "verdict": {
                    "verdict": "implement",
                    "score": "0.81",
                    "confidence": "0.84",
                    "requires_followup": False,
                },
            }
            with self.assertRaises(RuntimeError):
                service.finalize_run(
                    session, run_id=run_row.run_id, payload=finalize_payload
                )
            session.rollback()

            persisted_run = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            self.assertEqual(persisted_run.status, prior_status)
