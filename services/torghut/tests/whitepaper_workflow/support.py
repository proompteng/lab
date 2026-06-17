from __future__ import annotations

# ruff: noqa: F401

import json
import os
import tempfile
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import app.trading.discovery.candidate_specs as candidate_specs_module
from app.models import (
    Base,
    VNextExperimentSpec,
    WhitepaperAnalysisRun,
    WhitepaperCodexAgentRun,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperContradictionEvent,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperEngineeringTrigger,
    WhitepaperExperimentSpec,
    WhitepaperRolloutTransition,
    WhitepaperStrategyTemplate,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
)
from app.whitepapers.workflow import (
    CephS3Client,
    IssueKickoffResult,
    WhitepaperKafkaIssueIngestor,
    WhitepaperWorkflowService,
    build_whitepaper_run_id,
    comment_requests_requeue,
    extract_pdf_urls,
    normalize_github_issue_event,
    parse_marker_block,
)


def _profile_ids_for_family(family_template_id: str) -> list[str]:
    return [
        f"{family_template_id}:profile-{index + 1}"
        for index in range(
            len(
                candidate_specs_module._execution_profiles_for_target(
                    family_template_id=family_template_id,
                    target_net_pnl_per_day=Decimal("500"),
                )
            )
        )
    ]


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


class _FakeInngestClient:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def send_sync(self, event: Any) -> list[str]:
        data = getattr(event, "data", None)
        payload = dict(data) if isinstance(data, dict) else {}
        self.events.append(payload)
        return [f"evt-{len(self.events)}"]


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


class _TestWhitepaperWorkflowBase(TestCase):
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

    def _issue_payload(
        self,
        *,
        issue_number: int = 42,
        attachment_url: str = "https://github.com/user-attachments/files/12345/sample-paper.pdf",
        issue_title: str = "Analyze new whitepaper",
        marker_overrides: dict[str, str] | None = None,
    ) -> dict[str, object]:
        marker_lines = [
            "workflow: whitepaper-analysis-v1",
            "base_branch: main",
        ]
        for key, value in (marker_overrides or {}).items():
            marker_lines.append(f"{key}: {value}")
        marker_block = "\n".join(marker_lines)
        payload = {
            "event": "issues",
            "action": "opened",
            "repository": {"full_name": "proompteng/lab"},
            "issue": {
                "number": issue_number,
                "title": issue_title,
                "body": """
<!-- TORGHUT_WHITEPAPER:START -->
{marker_block}
<!-- TORGHUT_WHITEPAPER:END -->

Attachment: {attachment_url}
                """.format(marker_block=marker_block, attachment_url=attachment_url),
                "html_url": f"https://github.com/proompteng/lab/issues/{issue_number}",
            },
            "sender": {"login": "alice"},
        }
        return payload

    def _issue_comment_payload(self, *, comment_body: str) -> dict[str, object]:
        payload = self._issue_payload()
        payload["event"] = "issue_comment"
        payload["action"] = "created"
        payload["comment"] = {"body": comment_body}
        return payload


__all__: tuple[str, ...] = ()
