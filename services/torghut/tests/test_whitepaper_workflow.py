from __future__ import annotations

import os
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


class _AsyncSendInngestClient:
    async def send(self, _event: object) -> list[str]:
        return ["evt-async"]


class _RunStub:
    run_id = "wp-test-async-send"


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
        service.enqueue_inngest_run = (  # type: ignore[method-assign]
            lambda *, run, issue_event, attachment_url: {
                "event_name": "torghut/whitepaper.analysis.requested",
                "event_ids": ["evt-dispatch"],
                "event_payload": {
                    "run_id": run.run_id,
                    "issue_url": issue_event.issue_url,
                    "attachment_url": attachment_url,
                },
            }
        )
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
            self.assertEqual(run_row.status, "inngest_dispatched")

            service.dispatch_codex_agentrun(session, run_row.run_id)
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

    def test_ingest_queues_inngest_when_enabled(self) -> None:
        service = WhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        service._download_pdf = lambda _url: b"%PDF-1.7 sample"  # type: ignore[method-assign]
        service.enqueue_inngest_run = (  # type: ignore[method-assign]
            lambda *, run, issue_event, attachment_url: {
                "event_name": "torghut/whitepaper.analysis.requested",
                "event_ids": ["evt-1"],
                "event_payload": {
                    "run_id": run.run_id,
                    "issue_url": issue_event.issue_url,
                    "attachment_url": attachment_url,
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
            session.commit()

            run_row = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
            self.assertEqual(run_row.status, "inngest_dispatched")
            self.assertEqual(run_row.inngest_event_id, "evt-1")
            self.assertEqual(
                run_row.inngest_function_id,
                "torghut-whitepaper-analysis-v1",
            )
            self.assertIsNone(
                session.execute(select(WhitepaperCodexAgentRun)).scalar_one_or_none()
            )

    def test_enqueue_inngest_run_supports_async_send(self) -> None:
        service = WhitepaperWorkflowService()
        service.build_inngest_client = (  # type: ignore[method-assign]
            lambda: _AsyncSendInngestClient()
        )
        issue_event = normalize_github_issue_event(self._issue_payload())
        self.assertIsNotNone(issue_event)
        assert issue_event is not None

        result = service.enqueue_inngest_run(
            run=_RunStub(),  # type: ignore[arg-type]
            issue_event=issue_event,
            attachment_url="https://arxiv.org/pdf/2402.03755.pdf",
        )

        self.assertEqual(result["event_ids"], ["evt-async"])
