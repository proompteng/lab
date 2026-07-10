from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db import get_session
from app.main import app
from app.models import Base
from app.whitepapers.workflow import IssueKickoffResult


class TestWhitepaperApi(TestCase):
    command_token = "test-command-token"

    def setUp(self) -> None:
        self._saved_command_token = settings.torghut_command_api_token
        settings.torghut_command_api_token = self.command_token

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
        settings.torghut_command_api_token = self._saved_command_token
        app.dependency_overrides.clear()
        self.engine.dispose()

    @patch("app.api.whitepaper.whitepaper_workflow_enabled", return_value=True)
    @patch("app.api.whitepaper.whitepaper_kafka_enabled", return_value=False)
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
        self.assertTrue(payload["control_auth_enabled"])

    @patch(
        "app.api.whitepaper.WHITEPAPER_WORKFLOW.ingest_github_issue_event",
        return_value=IssueKickoffResult(
            accepted=True,
            reason="queued",
            run_id="wp-123",
            document_key="doc-123",
            agentrun_name="agentrun-wp-123",
        ),
    )
    def test_ingest_issue_endpoint(self, _mock_ingest: object) -> None:
        response = self.client.post(
            "/whitepapers/events/github-issue",
            json={"event": "issues"},
            headers={"Authorization": f"Bearer {self.command_token}"},
        )
        self.assertEqual(response.status_code, 202)
        payload = response.json()
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["run_id"], "wp-123")

    @patch(
        "app.api.whitepaper.WHITEPAPER_WORKFLOW.dispatch_codex_agentrun",
        return_value={"agentrun_name": "agentrun-1", "status": "pending"},
    )
    def test_dispatch_agentrun_endpoint(self, _mock_dispatch: object) -> None:
        response = self.client.post(
            "/whitepapers/runs/wp-1/dispatch-agentrun",
            headers={"X-Torghut-Command-Token": self.command_token},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["agentrun_name"], "agentrun-1")

    @patch(
        "app.api.whitepaper.WHITEPAPER_WORKFLOW.finalize_run",
        return_value={"run_id": "wp-1", "status": "completed"},
    )
    def test_finalize_endpoint(self, _mock_finalize: object) -> None:
        response = self.client.post(
            "/whitepapers/runs/wp-1/finalize",
            json={"status": "completed"},
            headers={"Authorization": f"Bearer {self.command_token}"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "completed")

    def test_control_endpoints_fail_closed_without_configured_token(self) -> None:
        with patch.object(settings, "torghut_command_api_token", None):
            response = self.client.post(
                "/whitepapers/runs/wp-1/finalize", json={"status": "completed"}
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "command_auth_not_configured")

    def test_control_endpoints_reject_wrong_token(self) -> None:
        response = self.client.post(
            "/whitepapers/runs/wp-1/finalize",
            json={"status": "completed"},
            headers={"Authorization": "Bearer wrong-token"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "command_auth_required")

    @patch(
        "app.api.whitepaper.WHITEPAPER_WORKFLOW.finalize_run",
        return_value={"run_id": "wp-1", "status": "completed"},
    )
    def test_control_endpoints_accept_valid_token(self, _mock_finalize: object) -> None:
        response = self.client.post(
            "/whitepapers/runs/wp-1/finalize",
            json={"status": "completed"},
            headers={"Authorization": f"Bearer {self.command_token}"},
        )
        self.assertEqual(response.status_code, 200)

    @patch(
        "app.api.whitepaper.WHITEPAPER_WORKFLOW.approve_for_engineering",
        return_value={
            "run_id": "wp-1",
            "status": "completed",
            "engineering_trigger": {"decision": "dispatched"},
        },
    )
    def test_manual_approve_endpoint(self, _mock_approve: object) -> None:
        response = self.client.post(
            "/whitepapers/runs/wp-1/approve-implementation",
            json={
                "approved_by": "ops@example.com",
                "approval_reason": "Manual override for B1 engineering dispatch.",
                "approval_source": "jangar_ui",
            },
            headers={"Authorization": f"Bearer {self.command_token}"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["engineering_trigger"]["decision"], "dispatched")

    @patch(
        "app.api.whitepaper.whitepaper_semantic_indexing_enabled", return_value=False
    )
    def test_semantic_search_rejected_when_disabled(
        self, _mock_semantic_enabled: object
    ) -> None:
        response = self.client.get("/whitepapers/search?q=quant+signal")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json()["detail"], "whitepaper_semantic_search_disabled"
        )

    @patch("app.api.whitepaper.whitepaper_semantic_indexing_enabled", return_value=True)
    @patch(
        "app.api.whitepaper.WHITEPAPER_WORKFLOW.search_semantic",
        return_value={
            "items": [
                {
                    "run_id": "wp-1",
                    "chunk": {
                        "source_scope": "synthesis",
                        "chunk_index": 0,
                        "snippet": "alpha discovery",
                    },
                    "semantic_distance": 0.18,
                    "lexical_score": 0.31,
                    "hybrid_score": 0.029,
                }
            ],
            "total": 1,
            "limit": 15,
            "offset": 0,
            "query": "alpha discovery",
            "scope": "all",
            "status": "completed",
            "subject": None,
        },
    )
    def test_semantic_search_returns_ranked_payload(
        self,
        _mock_search_semantic: object,
        _mock_semantic_enabled: object,
    ) -> None:
        response = self.client.get(
            "/whitepapers/search?q=alpha+discovery&limit=15&offset=0&status=completed&scope=all"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["run_id"], "wp-1")
