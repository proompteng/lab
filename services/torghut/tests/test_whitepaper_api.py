from __future__ import annotations

import os
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
        self._saved_whitepaper_token = os.environ.get("WHITEPAPER_WORKFLOW_API_TOKEN")
        self._saved_jangar_api_key = os.environ.get("JANGAR_API_KEY")
        os.environ.pop("WHITEPAPER_WORKFLOW_API_TOKEN", None)
        os.environ.pop("JANGAR_API_KEY", None)

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
        if self._saved_whitepaper_token is not None:
            os.environ["WHITEPAPER_WORKFLOW_API_TOKEN"] = self._saved_whitepaper_token
        else:
            os.environ.pop("WHITEPAPER_WORKFLOW_API_TOKEN", None)
        if self._saved_jangar_api_key is not None:
            os.environ["JANGAR_API_KEY"] = self._saved_jangar_api_key
        else:
            os.environ.pop("JANGAR_API_KEY", None)

    @patch("app.main.whitepaper_workflow_enabled", return_value=True)
    @patch("app.main.whitepaper_kafka_enabled", return_value=False)
    def test_whitepaper_status_endpoint(
        self,
        _mock_kafka_enabled: object,
        _mock_workflow_enabled: object,
    ) -> None:
        response = self.client.get("/whitepapers/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["workflow_enabled"])
        self.assertFalse(payload["kafka_enabled"])

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

    def test_control_endpoints_require_token_when_configured(self) -> None:
        with patch.dict(os.environ, {"WHITEPAPER_WORKFLOW_API_TOKEN": "secret-token"}, clear=False):
            response = self.client.post("/whitepapers/runs/wp-1/finalize", json={"status": "completed"})
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["detail"], "whitepaper_control_auth_required")

    @patch(
        "app.main.WHITEPAPER_WORKFLOW.finalize_run",
        return_value={"run_id": "wp-1", "status": "completed"},
    )
    def test_control_endpoints_accept_valid_token(self, _mock_finalize: object) -> None:
        with patch.dict(os.environ, {"WHITEPAPER_WORKFLOW_API_TOKEN": "secret-token"}, clear=False):
            response = self.client.post(
                "/whitepapers/runs/wp-1/finalize",
                json={"status": "completed"},
                headers={"Authorization": "Bearer secret-token"},
            )
            self.assertEqual(response.status_code, 200)

    @patch(
        "app.main.WHITEPAPER_WORKFLOW.approve_for_engineering",
        return_value={"run_id": "wp-1", "status": "completed", "engineering_trigger": {"decision": "dispatched"}},
    )
    def test_manual_approve_endpoint(self, _mock_approve: object) -> None:
        response = self.client.post(
            "/whitepapers/runs/wp-1/approve-implementation",
            json={
                "approved_by": "ops@example.com",
                "approval_reason": "Manual override for B1 engineering dispatch.",
                "approval_source": "jangar_ui",
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["engineering_trigger"]["decision"], "dispatched")
