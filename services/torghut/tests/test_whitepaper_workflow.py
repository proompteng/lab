from __future__ import annotations

import json
import os
from dataclasses import dataclass
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import (
    Base,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
)
from app.whitepapers.workflow import (
    IssueKickoffResult,
    WhitepaperKafkaIssueIngestor,
    WhitepaperWorkflowService,
    extract_pdf_urls,
    normalize_github_issue_event,
    parse_marker_block,
)


class _FakeCephClient:
    def put_object(self, *, bucket: str, key: str, body: bytes, content_type: str):
        return {
            "bucket": bucket,
            "key": key,
            "etag": "etag-1",
            "size_bytes": len(body),
            "sha256": "sha256",
            "uri": f"s3://{bucket}/{key}",
        }


@dataclass
class _FakeKafkaRecord:
    value: bytes


class _FakeKafkaConsumer:
    def __init__(self, records: list[_FakeKafkaRecord]) -> None:
        self._records = records
        self.commit_calls = 0

    def poll(self, *, timeout_ms: int, max_records: int):
        del timeout_ms
        batch = self._records[:max_records]
        self._records = self._records[max_records:]
        if not batch:
            return {}
        return {("github.webhook.events", 0): batch}

    def commit(self) -> None:
        self.commit_calls += 1


class _FakeKafkaSession:
    def __init__(self) -> None:
        self.commit_calls = 0
        self.rollback_calls = 0

    def commit(self) -> None:
        self.commit_calls += 1

    def rollback(self) -> None:
        self.rollback_calls += 1


class _FakeKafkaWorkflowService:
    def ingest_github_issue_event(
        self,
        _session: object,
        payload: dict[str, object],
        *,
        source: str,
    ) -> IssueKickoffResult:
        if source != "kafka":
            raise ValueError("unexpected_source")
        if payload.get("raise_error"):
            raise RuntimeError("forced_failure")
        accepted = not bool(payload.get("ignored"))
        return IssueKickoffResult(
            accepted=accepted,
            reason="queued" if accepted else "ignored_event",
            run_id="wp-test" if accepted else None,
            document_key="doc-test" if accepted else None,
        )


class TestWhitepaperWorkflow(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)
        self._saved_env = dict(os.environ)
        os.environ["WHITEPAPER_WORKFLOW_ENABLED"] = "true"
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "true"
        os.environ["WHITEPAPER_AGENTRUN_NAMESPACE"] = "agents"
        os.environ["WHITEPAPER_AGENT_NAME"] = "codex-whitepaper-agent"
        os.environ["WHITEPAPER_AGENTRUN_VCS_REF"] = "github"

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._saved_env)
        self.engine.dispose()

    def _issue_payload(self) -> dict[str, object]:
        return {
            "event": "issues",
            "action": "opened",
            "repository": {"full_name": "proompteng/lab"},
            "issue": {
                "number": 42,
                "title": "Analyze new whitepaper",
                "body": """
<!-- TORGHUT_WHITEPAPER:START -->
workflow: whitepaper-analysis-v1
base_branch: main
<!-- TORGHUT_WHITEPAPER:END -->

Attachment: https://github.com/user-attachments/files/12345/sample-paper.pdf
                """,
                "html_url": "https://github.com/proompteng/lab/issues/42",
            },
            "sender": {"login": "alice"},
        }

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

    def test_normalize_github_issue_event(self) -> None:
        event = normalize_github_issue_event(self._issue_payload())
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.repository, "proompteng/lab")
        self.assertEqual(event.issue_number, 42)

    def test_ingest_and_finalize_flow(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        service._submit_jangar_agentrun = (  # type: ignore[method-assign]
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

            version_row = session.execute(select(WhitepaperDocumentVersion)).scalar_one()
            self.assertEqual(version_row.parse_status, "stored")

            agentrun_row = session.execute(select(WhitepaperCodexAgentRun)).scalar_one()
            self.assertTrue(agentrun_row.agentrun_name.startswith("agentrun-"))

            finalize_payload = {
                "status": "completed",
                "synthesis": {
                    "executive_summary": "Strong approach with reproducible results.",
                    "key_findings": ["f1", "f2"],
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
            result = service.finalize_run(session, run_id=run_row.run_id, payload=finalize_payload)
            self.assertEqual(result["status"], "completed")
            session.commit()

            synthesis_row = session.execute(select(WhitepaperSynthesis)).scalar_one()
            self.assertIn("Strong approach", synthesis_row.executive_summary)

            verdict_row = session.execute(select(WhitepaperViabilityVerdict)).scalar_one()
            self.assertEqual(verdict_row.verdict, "implement")

            pr_row = session.execute(select(WhitepaperDesignPullRequest)).scalar_one()
            self.assertEqual(pr_row.pr_number, 1234)

    def test_failed_run_can_retry_and_replay_latest_non_failed_run(self) -> None:
        service = WhitepaperWorkflowService()
        os.environ["WHITEPAPER_AGENTRUN_AUTO_DISPATCH"] = "false"

        with Session(self.engine) as session:
            service.ceph_client = None
            service._download_pdf = lambda _url: b"%PDF-1.7 first"  # type: ignore[method-assign]
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
            service._download_pdf = lambda _url: b"%PDF-1.7 retry"  # type: ignore[method-assign]
            retry = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(retry.accepted)
            self.assertEqual(retry.reason, "queued")
            self.assertIsNotNone(retry.run_id)
            assert first.run_id is not None
            assert retry.run_id is not None
            self.assertNotEqual(retry.run_id, first.run_id)
            self.assertTrue(retry.run_id.endswith("-r1"))
            session.commit()

            run_rows = {
                row.run_id: row
                for row in session.execute(select(WhitepaperAnalysisRun)).scalars().all()
            }
            self.assertEqual(len(run_rows), 2)
            self.assertEqual(run_rows[first.run_id].status, "failed")
            self.assertEqual(run_rows[retry.run_id].status, "queued")
            self.assertEqual(run_rows[retry.run_id].retry_of_run_id, first.run_id)

            replay = service.ingest_github_issue_event(
                session,
                self._issue_payload(),
                source="api",
            )
            self.assertTrue(replay.accepted)
            self.assertEqual(replay.reason, "idempotent_replay")
            self.assertEqual(replay.run_id, retry.run_id)

    def test_kafka_ingestor_skips_offset_commit_when_any_record_fails(self) -> None:
        os.environ["WHITEPAPER_KAFKA_ENABLED"] = "true"
        consumer = _FakeKafkaConsumer(
            [
                _FakeKafkaRecord(value=json.dumps({"ignored": False}).encode("utf-8")),
                _FakeKafkaRecord(value=json.dumps({"raise_error": True}).encode("utf-8")),
            ]
        )
        ingestor = WhitepaperKafkaIssueIngestor(workflow_service=_FakeKafkaWorkflowService())
        ingestor._consumer = consumer
        session = _FakeKafkaSession()

        counters = ingestor.ingest_once(session)  # type: ignore[arg-type]
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
        ingestor = WhitepaperKafkaIssueIngestor(workflow_service=_FakeKafkaWorkflowService())
        ingestor._consumer = consumer
        session = _FakeKafkaSession()

        counters = ingestor.ingest_once(session)  # type: ignore[arg-type]
        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["accepted_total"], 1)
        self.assertEqual(counters["ignored_total"], 1)
        self.assertEqual(counters["failed_total"], 0)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(session.commit_calls, 1)
        self.assertEqual(session.rollback_calls, 1)
