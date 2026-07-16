from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import WhitepaperAnalysisRun, WhitepaperCodexAgentRun
from tests.whitepaper_workflow.support import (
    _FakeCephClient,
    _TestWhitepaperWorkflowBase,
    _TestWhitepaperWorkflowService,
)


class TestAgentRunFinalization(_TestWhitepaperWorkflowBase):
    def _seed_dispatched_run(
        self, session: Session
    ) -> tuple[_TestWhitepaperWorkflowService, WhitepaperAnalysisRun]:
        service = _TestWhitepaperWorkflowService()
        service.ceph_client = _FakeCephClient()
        kickoff = service.ingest_github_issue_event(
            session,
            self._issue_payload(),
            source="api",
        )
        self.assertTrue(kickoff.accepted)
        session.flush()
        run = session.execute(select(WhitepaperAnalysisRun)).scalar_one()
        return service, run

    def test_complete_run_terminalizes_only_active_workflow_agentruns(self) -> None:
        with Session(self.engine) as session:
            service, run = self._seed_dispatched_run(session)
            active = session.execute(select(WhitepaperCodexAgentRun)).scalar_one()
            active.status = "Running"
            session.add(active)

            prior_completed_at = datetime.now(timezone.utc) - timedelta(hours=1)
            prior_attempts = [
                WhitepaperCodexAgentRun(
                    analysis_run_id=run.id,
                    agentrun_name=f"agentrun-prior-{status}",
                    status=status,
                    execution_mode="workflow",
                    completed_at=prior_completed_at,
                    failure_reason=f"prior_{status}",
                )
                for status in ("failed", "error", "timeout", "timed_out")
            ]
            engineering = WhitepaperCodexAgentRun(
                analysis_run_id=run.id,
                agentrun_name="agentrun-engineering",
                status="Pending",
                execution_mode="engineering_candidate",
            )
            session.add_all([*prior_attempts, engineering])
            session.flush()

            payload = {"status": "completed", "synthesis": {"summary": "done"}}
            service._complete_run(session, run, payload)
            session.flush()

            self.assertEqual(active.status, "completed")
            self.assertIsNotNone(active.completed_at)
            self.assertIsNone(active.failure_reason)
            self.assertEqual(active.output_context_json, payload)
            self.assertEqual(active.completed_at, run.completed_at)

            for prior in prior_attempts:
                self.assertIn(prior.status, {"failed", "error", "timeout", "timed_out"})
                self.assertEqual(prior.completed_at, prior_completed_at)
                self.assertEqual(prior.failure_reason, f"prior_{prior.status}")
            self.assertEqual(engineering.status, "Pending")
            self.assertIsNone(engineering.completed_at)

    def test_failed_run_propagates_failure_to_active_workflow_agentrun(self) -> None:
        with Session(self.engine) as session:
            service, run = self._seed_dispatched_run(session)
            agentrun = session.execute(select(WhitepaperCodexAgentRun)).scalar_one()
            payload = {
                "status": "failed",
                "failure_reason": "analysis_failed",
            }

            service._complete_run(session, run, payload)
            session.flush()

            self.assertEqual(run.status, "failed")
            self.assertEqual(agentrun.status, "failed")
            self.assertEqual(agentrun.failure_reason, "analysis_failed")
            self.assertEqual(agentrun.output_context_json, payload)
            self.assertEqual(agentrun.completed_at, run.completed_at)
