from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

from app.db import get_session
from app.main import app
from app.models import Base
from app.whitepapers.workflow import IssueKickoffResult


class TestWhitepaperApi(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.session_local = sessionmaker(
            bind=self.engine,
            expire_on_commit=False,
            future=True,
        )

        def _override_session() -> Session:
            with self.session_local() as session:
                yield session

        app.dependency_overrides[get_session] = _override_session
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.engine.dispose()

    @patch("app.main.whitepaper_workflow_enabled", return_value=True)
    def test_whitepaper_status_endpoint(self, _mock_enabled: object) -> None:
        response = self.client.get("/whitepapers/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["workflow_enabled"])
        self.assertTrue(payload["kafka_enabled"])

    @patch(
        "app.main.WHITEPAPER_WORKFLOW.ingest_github_issue_event",
        return_value=IssueKickoffResult(
            accepted=True,
            reason="queued",
            run_id="wp-123",
            document_key="doc-123",
            agentrun_name="agentrun-wp-123",
        ),
    )
    def test_ingest_issue_endpoint(self, _mock_ingest: object) -> None:
        response = self.client.post("/whitepapers/events/github-issue", json={"event": "issues"})
        self.assertEqual(response.status_code, 202)
        payload = response.json()
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["run_id"], "wp-123")

    @patch(
        "app.main.WHITEPAPER_WORKFLOW.dispatch_codex_agentrun",
        return_value={"agentrun_name": "agentrun-1", "status": "pending"},
    )
    def test_dispatch_agentrun_endpoint(self, _mock_dispatch: object) -> None:
        response = self.client.post("/whitepapers/runs/wp-1/dispatch-agentrun")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["agentrun_name"], "agentrun-1")

    @patch(
        "app.main.WHITEPAPER_WORKFLOW.finalize_run",
        return_value={"run_id": "wp-1", "status": "completed"},
    )
    def test_finalize_endpoint(self, _mock_finalize: object) -> None:
        response = self.client.post("/whitepapers/runs/wp-1/finalize", json={"status": "completed"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "completed")
