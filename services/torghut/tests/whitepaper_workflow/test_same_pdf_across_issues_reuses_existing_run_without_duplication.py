from __future__ import annotations

from tests.whitepaper_workflow.support import (
    Any,
    Session,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperKafkaIssueIngestor,
    WhitepaperWorkflowService,
    _FakeCephClient,
    _FakeInngestClient,
    _FakeKafkaConsumer,
    _FakeKafkaRecord,
    _FakeKafkaSession,
    _FakeKafkaWorkflowService,
    _TestWhitepaperWorkflowBase,
    _TestWhitepaperWorkflowService,
    cast,
    json,
    os,
    patch,
    select,
)


class TestSamePdfAcrossIssuesReusesExistingRunWithoutDuplication(
    _TestWhitepaperWorkflowBase
):
    def test_same_pdf_across_issues_reuses_existing_run_without_duplication(
        self,
    ) -> None:
        service = _TestWhitepaperWorkflowService(
            download_pdf_handler=lambda _url: b"%PDF-1.7 identical-content",
        )
        service.ceph_client = _FakeCephClient()

        submit_attempts = {"count": 0}

        def _fake_submit(
            _payload: dict[str, Any], *, idempotency_key: str
        ) -> dict[str, Any]:
            submit_attempts["count"] += 1
            return {
                "ok": True,
                "resource": {
                    "metadata": {
                        "name": f"agentrun-{idempotency_key}",
                        "uid": f"uid-{submit_attempts['count']}",
                    },
                    "status": {"phase": "Pending"},
                },
            }

        service.submit_agents_agentrun_handler = _fake_submit

        with Session(self.engine) as session:
            first = service.ingest_github_issue_event(
                session,
                self._issue_payload(
                    issue_number=42,
                    attachment_url="https://example.com/papers/a.pdf",
                    issue_title="Analyze paper A",
                ),
                source="api",
            )
            self.assertTrue(first.accepted)
            self.assertEqual(first.reason, "queued")
            self.assertIsNotNone(first.run_id)
            session.commit()

            replay = service.ingest_github_issue_event(
                session,
                self._issue_payload(
                    issue_number=84,
                    attachment_url="https://mirror.example.net/files/same-content.pdf",
                    issue_title="Analyze paper A duplicate",
                ),
                source="api",
            )
            self.assertTrue(replay.accepted)
            self.assertEqual(replay.reason, "idempotent_file_replay")
            self.assertEqual(replay.run_id, first.run_id)
            session.commit()

            runs = session.execute(select(WhitepaperAnalysisRun)).scalars().all()
            self.assertEqual(len(runs), 1)

            docs = session.execute(select(WhitepaperDocument)).scalars().all()
            self.assertEqual(len(docs), 1)

            versions = (
                session.execute(select(WhitepaperDocumentVersion)).scalars().all()
            )
            self.assertEqual(len(versions), 1)
            self.assertEqual(
                versions[0].ceph_object_key,
                f"raw/checksum/{versions[0].checksum_sha256[:2]}/{versions[0].checksum_sha256}/source.pdf",
            )

            agentruns = session.execute(select(WhitepaperCodexAgentRun)).scalars().all()
            self.assertEqual(len(agentruns), 1)
            self.assertEqual(submit_attempts["count"], 1)

    def test_kafka_ingestor_skips_offset_commit_when_any_record_fails(self) -> None:
        os.environ["WHITEPAPER_KAFKA_ENABLED"] = "true"
        consumer = _FakeKafkaConsumer(
            [
                _FakeKafkaRecord(value=json.dumps({"ignored": False}).encode("utf-8")),
                _FakeKafkaRecord(
                    value=json.dumps({"raise_error": True}).encode("utf-8")
                ),
            ]
        )
        ingestor = WhitepaperKafkaIssueIngestor(
            workflow_service=_FakeKafkaWorkflowService()
        )
        ingestor._consumer = consumer
        session = _FakeKafkaSession()

        counters = ingestor.ingest_once(session)
        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["accepted_total"], 1)
        self.assertEqual(counters["failed_total"], 1)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(session.commit_calls, 1)
        self.assertEqual(session.rollback_calls, 1)

    def test_kafka_ingestor_commits_offsets_when_batch_has_no_failures(self) -> None:
        os.environ["WHITEPAPER_KAFKA_ENABLED"] = "true"
        consumer = _FakeKafkaConsumer(
            [
                _FakeKafkaRecord(value=json.dumps({"ignored": True}).encode("utf-8")),
                _FakeKafkaRecord(value=json.dumps({"ignored": False}).encode("utf-8")),
            ]
        )
        ingestor = WhitepaperKafkaIssueIngestor(
            workflow_service=_FakeKafkaWorkflowService()
        )
        ingestor._consumer = consumer
        session = _FakeKafkaSession()

        counters = ingestor.ingest_once(session)
        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["accepted_total"], 1)
        self.assertEqual(counters["ignored_total"], 1)
        self.assertEqual(counters["failed_total"], 0)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(session.commit_calls, 1)
        self.assertEqual(session.rollback_calls, 1)

    @patch(
        "app.whitepapers.workflow.whitepaper_workflow_api_methods._http_request_bytes"
    )
    def test_download_pdf_requests_redirect_following(
        self, mock_http_request: Any
    ) -> None:
        os.environ["WHITEPAPER_MAX_PDF_BYTES"] = "123"
        mock_http_request.return_value = (200, {}, b"%PDF-1.7 redirected")

        payload = WhitepaperWorkflowService._download_pdf(
            "https://example.com/paper.pdf"
        )

        self.assertEqual(payload, b"%PDF-1.7 redirected")
        kwargs = mock_http_request.call_args.kwargs
        self.assertEqual(kwargs["method"], "GET")
        self.assertEqual(kwargs["max_response_bytes"], 123)
        self.assertTrue(kwargs["follow_redirects"])

    def test_comment_requeue_reuses_existing_run_without_duplication(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()

        submit_attempts = {"count": 0}

        def _fake_submit(
            _payload: dict[str, Any], *, idempotency_key: str
        ) -> dict[str, Any]:
            submit_attempts["count"] += 1
            phase = "failed" if submit_attempts["count"] == 1 else "pending"
            return {
                "resource": {
                    "metadata": {
                        "name": f"agentrun-{submit_attempts['count']}",
                        "uid": f"uid-{idempotency_key}",
                    },
                    "status": {"phase": phase},
                }
            }

        service.submit_agents_agentrun_handler = _fake_submit

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            session.commit()

            requeue = service.ingest_github_issue_event(
                session,
                self._issue_comment_payload(comment_body="research whitepaper"),
                source="api",
            )
            self.assertTrue(requeue.accepted)
            self.assertEqual(requeue.reason, "requeued")
            session.commit()

            runs = session.execute(select(WhitepaperAnalysisRun)).scalars().all()
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].status, "agentrun_dispatched")

            agentruns = (
                session.execute(
                    select(WhitepaperCodexAgentRun).where(
                        WhitepaperCodexAgentRun.analysis_run_id == runs[0].id
                    )
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(agentruns), 2)

    def test_inngest_requeue_uses_new_enqueue_key_per_attempt(self) -> None:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        os.environ["WHITEPAPER_INNGEST_ENABLED"] = "true"
        fake_inngest = _FakeInngestClient()
        service.set_inngest_client(cast(Any, fake_inngest))

        with Session(self.engine) as session:
            kickoff = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(kickoff.accepted)
            self.assertEqual(kickoff.reason, "queued")
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()

            requeue = service.ingest_github_issue_event(
                session,
                self._issue_comment_payload(comment_body="research whitepaper"),
                source="api",
            )
            self.assertTrue(requeue.accepted)
            self.assertEqual(requeue.reason, "requeued")
            session.commit()

            self.assertEqual(len(fake_inngest.events), 2)
            self.assertEqual(fake_inngest.events[0]["run_id"], run_row.run_id)
            self.assertEqual(fake_inngest.events[0]["enqueue_attempt"], 1)
            self.assertEqual(
                fake_inngest.events[0]["enqueue_key"], f"{run_row.run_id}:1"
            )
            self.assertEqual(fake_inngest.events[1]["run_id"], run_row.run_id)
            self.assertEqual(fake_inngest.events[1]["enqueue_attempt"], 2)
            self.assertEqual(
                fake_inngest.events[1]["enqueue_key"], f"{run_row.run_id}:2"
            )
