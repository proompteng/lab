# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from subprocess import CalledProcessError, run
from typing import Any, Mapping, cast
from urllib.parse import quote, urljoin, urlparse

import inngest
from sqlalchemy import case, delete, func, select, text
from sqlalchemy.orm import Session

from ...models import (
    VNextExperimentSpec,
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperArtifact,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperContradictionEvent,
    WhitepaperCodexAgentRun,
    WhitepaperContent,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperEngineeringTrigger,
    WhitepaperExperimentSpec,
    WhitepaperRolloutTransition,
    WhitepaperStrategyTemplate,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
    coerce_json_payload,
)
from ...trading.discovery.whitepaper_candidate_compiler import (
    compile_claim_payloads_to_whitepaper_experiments,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    EngineeringGradeDecision,
    GithubIssueEvent,
    ManualApprovalPayload,
    _ELIGIBLE_AUTO_VERDICTS,
    _GITHUB_ISSUE_ACTIONS,
    _GITHUB_ISSUE_COMMENT_ACTIONS,
    _MAX_SEMANTIC_RELEVANT_DISTANCE,
    _PASS_GATE_STATUSES,
    _REJECT_VERDICTS,
    _RETRYABLE_AGENTRUN_STATUSES,
    _SEMANTIC_RELATIVE_DISTANCE_WINDOW,
    _WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
    _WHITEPAPER_CEPH_DEFAULT_SECRET_DIR,
    _bool_env,
    _coerce_issue_number,
    _extract_github_event_metadata,
    _extract_github_issue_payload,
    _extract_sender_login,
    _float_env,
    _http_request_bytes,
    _int_env,
    _mounted_or_env_value,
    _normalize_identifier,
    _read_text_file,
    _sorted_unique,
    _str_env,
    _whitepaper_ceph_bucket_name,
    build_whitepaper_run_id,
    comment_requests_requeue,
    extract_pdf_urls,
    github_issue_number_from_url,
    logger,
    marker_end,
    marker_start,
    normalize_analysis_mode,
    normalize_attachment_url,
    normalize_github_issue_event,
    parse_marker_block,
    parse_marker_tags,
    whitepaper_inngest_enabled,
    whitepaper_kafka_enabled,
    whitepaper_requeue_comment_keyword,
    whitepaper_semantic_indexing_enabled,
    whitepaper_semantic_required,
    whitepaper_workflow_enabled,
)
from .ceph_s3_client import (
    CephS3Client,
    IssueKickoffResult,
    _IssueRunIdentity,
    _PdfStorageOutcome,
    _WhitepaperWorkflowServiceFields,
)
from .whitepaper_workflow_ingestion_methods import (
    _WhitepaperWorkflowIngestionMethods,
)
from .whitepaper_workflow_persistence_methods import (
    _WhitepaperWorkflowPersistenceMethods,
)
from .whitepaper_workflow_agent_methods import (
    _WhitepaperWorkflowAgentMethods,
)
from .whitepaper_workflow_verdict_methods import (
    _EmbeddingRequestConfig,
    _EngineeringDecisionOutcome,
    _EngineeringDecisionPolicy,
    _EngineeringDecisionSignals,
    _WhitepaperWorkflowVerdictMethods,
)
from .whitepaper_workflow_rollout_methods import (
    _WhitepaperWorkflowRolloutMethods,
)
from .whitepaper_workflow_api_methods import (
    _WhitepaperWorkflowApiMethods,
)


class WhitepaperWorkflowService(
    _WhitepaperWorkflowServiceFields,
    _WhitepaperWorkflowIngestionMethods,
    _WhitepaperWorkflowPersistenceMethods,
    _WhitepaperWorkflowAgentMethods,
    _WhitepaperWorkflowVerdictMethods,
    _WhitepaperWorkflowRolloutMethods,
    _WhitepaperWorkflowApiMethods,
    object,
):
    pass


class WhitepaperKafkaIssueIngestor:
    """Kafka consumer for GitHub issue webhook events relayed by Froussard."""

    def __init__(
        self, *, workflow_service: WhitepaperWorkflowService | None = None
    ) -> None:
        self.workflow_service = workflow_service or WhitepaperWorkflowService()
        self._consumer: Any | None = None

    def ingest_once(self, session: Session) -> dict[str, int]:
        counters = {
            "messages_total": 0,
            "accepted_total": 0,
            "ignored_total": 0,
            "failed_total": 0,
            "consumer_errors_total": 0,
        }

        if not whitepaper_workflow_enabled() or not whitepaper_kafka_enabled():
            return counters

        consumer = self._ensure_consumer()
        if consumer is None:
            counters["consumer_errors_total"] += 1
            return counters

        try:
            polled = consumer.poll(
                timeout_ms=_int_env("WHITEPAPER_KAFKA_POLL_MS", 500),
                max_records=_int_env("WHITEPAPER_KAFKA_BATCH_SIZE", 50),
            )
        except Exception as exc:  # pragma: no cover - external Kafka failure
            counters["consumer_errors_total"] += 1
            logger.warning("Whitepaper Kafka poll failed: %s", exc)
            return counters

        records = self._flatten_poll_records(polled)
        if not records:
            return counters

        for record in records:
            counters["messages_total"] += 1
            try:
                payload = self._decode_record_json(record)
            except Exception:
                counters["ignored_total"] += 1
                continue
            try:
                result = self.workflow_service.ingest_github_issue_event(
                    session,
                    payload,
                    source="kafka",
                )
                if result.accepted:
                    counters["accepted_total"] += 1
                    session.commit()
                else:
                    counters["ignored_total"] += 1
                    session.rollback()
            except Exception as exc:
                session.rollback()
                counters["failed_total"] += 1
                logger.warning("Whitepaper issue intake failed: %s", exc)

        if counters["failed_total"] == 0:
            self._commit_consumer(consumer)
        else:
            logger.warning(
                "Whitepaper issue intake had %s failed messages; skipping offset commit",
                counters["failed_total"],
            )
        if counters["messages_total"] or counters["consumer_errors_total"]:
            logger.info(
                "Whitepaper Kafka ingest cycle messages=%s accepted=%s ignored=%s failed=%s consumer_errors=%s",
                counters["messages_total"],
                counters["accepted_total"],
                counters["ignored_total"],
                counters["failed_total"],
                counters["consumer_errors_total"],
            )
        return counters

    def close(self) -> None:
        if self._consumer is None:
            return
        run_close = cast(Any, getattr(self._consumer, "close", None))
        consumer = self._consumer
        self._consumer = None
        if callable(run_close):
            try:
                run_close()
            except Exception:
                logger.debug("Whitepaper consumer close failed", exc_info=True)
        else:
            del consumer

    def _ensure_consumer(self) -> Any | None:
        if self._consumer is not None:
            return self._consumer
        try:
            self._consumer = self._build_consumer()
            return self._consumer
        except Exception as exc:  # pragma: no cover - depends on Kafka runtime
            logger.warning("Failed to initialize whitepaper kafka consumer: %s", exc)
            return None

    @staticmethod
    def _build_consumer() -> Any:
        from kafka import KafkaConsumer  # type: ignore[import-not-found]

        bootstrap = (
            _str_env("WHITEPAPER_KAFKA_BOOTSTRAP_SERVERS")
            or _str_env("TRADING_ORDER_FEED_BOOTSTRAP_SERVERS")
            or ""
        )
        if not bootstrap:
            raise RuntimeError("whitepaper_kafka_bootstrap_missing")

        topic = (
            _str_env("WHITEPAPER_KAFKA_TOPIC", "github.webhook.events")
            or "github.webhook.events"
        )
        security_protocol = _str_env("WHITEPAPER_KAFKA_SECURITY_PROTOCOL")
        sasl_mechanism = _str_env("WHITEPAPER_KAFKA_SASL_MECHANISM")
        sasl_username = _str_env("WHITEPAPER_KAFKA_SASL_USERNAME")
        sasl_password = _str_env("WHITEPAPER_KAFKA_SASL_PASSWORD")
        kwargs: dict[str, Any] = {}
        if security_protocol:
            kwargs["security_protocol"] = security_protocol
        if sasl_mechanism:
            kwargs["sasl_mechanism"] = sasl_mechanism
        if sasl_username:
            kwargs["sasl_plain_username"] = sasl_username
        if sasl_password:
            kwargs["sasl_plain_password"] = sasl_password
        return KafkaConsumer(
            topic,
            bootstrap_servers=[
                item.strip() for item in bootstrap.split(",") if item.strip()
            ],
            group_id=_str_env("WHITEPAPER_KAFKA_GROUP_ID", "torghut-whitepaper-v1"),
            client_id=_str_env("WHITEPAPER_KAFKA_CLIENT_ID", "torghut-whitepaper"),
            enable_auto_commit=False,
            auto_offset_reset=_str_env("WHITEPAPER_KAFKA_AUTO_OFFSET_RESET", "latest"),
            consumer_timeout_ms=max(_int_env("WHITEPAPER_KAFKA_POLL_MS", 500), 1000),
            value_deserializer=None,
            key_deserializer=None,
            **kwargs,
        )

    @staticmethod
    def _flatten_poll_records(polled: Any) -> list[Any]:
        if isinstance(polled, Mapping):
            records: list[Any] = []
            for bucket in cast(Mapping[Any, Any], polled).values():
                if isinstance(bucket, list):
                    records.extend(bucket)
            return records
        if isinstance(polled, list):
            return cast(list[Any], polled)
        return []

    @staticmethod
    def _decode_record_json(record: Any) -> dict[str, Any]:
        value = getattr(record, "value", None)
        if value is None:
            raise ValueError("missing_value")
        if isinstance(value, bytes):
            payload = json.loads(value.decode("utf-8"))
        elif isinstance(value, str):
            payload = json.loads(value)
        elif isinstance(value, Mapping):
            payload = dict(cast(dict[str, Any], value))
        else:
            raise ValueError("unsupported_payload")
        if not isinstance(payload, dict):
            raise ValueError("payload_not_object")
        return cast(dict[str, Any], payload)

    @staticmethod
    def _commit_consumer(consumer: Any) -> None:
        run_commit = getattr(consumer, "commit", None)
        if callable(run_commit):
            try:
                run_commit()
            except Exception as exc:  # pragma: no cover - external Kafka runtime
                logger.warning("Whitepaper consumer commit failed: %s", exc)


class WhitepaperKafkaWorker:
    """Background worker that polls Kafka and triggers whitepaper issue intake."""

    def __init__(
        self,
        *,
        session_factory: Any,
        ingestor: WhitepaperKafkaIssueIngestor | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._ingestor = ingestor or WhitepaperKafkaIssueIngestor()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._task is not None:
            return
        if not whitepaper_workflow_enabled() or not whitepaper_kafka_enabled():
            logger.info("Whitepaper Kafka worker disabled; not starting")
            return
        interval_seconds = max(
            0.25,
            float(_int_env("WHITEPAPER_KAFKA_LOOP_INTERVAL_MS", 1000)) / 1000.0,
        )
        logger.info(
            "Whitepaper Kafka worker starting topic=%s group_id=%s client_id=%s interval_seconds=%s",
            _str_env("WHITEPAPER_KAFKA_TOPIC", "github.webhook.events")
            or "github.webhook.events",
            _str_env("WHITEPAPER_KAFKA_GROUP_ID", "torghut-whitepaper-v1"),
            _str_env("WHITEPAPER_KAFKA_CLIENT_ID", "torghut-whitepaper"),
            interval_seconds,
        )
        self._task = asyncio.create_task(self._run(), name="whitepaper-kafka-worker")

    async def stop(self) -> None:
        if self._task is None:
            self._ingestor.close()
            return
        logger.info("Whitepaper Kafka worker stopping")
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            logger.debug("whitepaper kafka worker cancelled")
        finally:
            self._task = None
            self._ingestor.close()
            logger.info("Whitepaper Kafka worker stopped")

    async def _run(self) -> None:
        interval = max(
            0.25, float(_int_env("WHITEPAPER_KAFKA_LOOP_INTERVAL_MS", 1000)) / 1000.0
        )
        while True:
            try:
                await asyncio.to_thread(self._ingest_once)
            except Exception:
                logger.exception("Whitepaper kafka worker loop failure")
            await asyncio.sleep(interval)

    def _ingest_once(self) -> None:
        with self._session_factory() as session:
            self._ingestor.ingest_once(session)


__all__ = [
    "IssueKickoffResult",
    "WhitepaperKafkaIssueIngestor",
    "WhitepaperKafkaWorker",
    "WhitepaperWorkflowService",
    "build_whitepaper_run_id",
    "comment_requests_requeue",
    "extract_pdf_urls",
    "normalize_github_issue_event",
    "parse_marker_block",
    "whitepaper_inngest_enabled",
    "whitepaper_kafka_enabled",
    "whitepaper_semantic_indexing_enabled",
    "whitepaper_workflow_enabled",
]


__all__ = [name for name in globals() if not name.startswith("__")]
