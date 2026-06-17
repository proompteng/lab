# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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
    ELIGIBLE_AUTO_VERDICTS as _ELIGIBLE_AUTO_VERDICTS,
    GITHUB_ISSUE_ACTIONS as _GITHUB_ISSUE_ACTIONS,
    GITHUB_ISSUE_COMMENT_ACTIONS as _GITHUB_ISSUE_COMMENT_ACTIONS,
    MAX_SEMANTIC_RELEVANT_DISTANCE as _MAX_SEMANTIC_RELEVANT_DISTANCE,
    PASS_GATE_STATUSES as _PASS_GATE_STATUSES,
    REJECT_VERDICTS as _REJECT_VERDICTS,
    RETRYABLE_AGENTRUN_STATUSES as _RETRYABLE_AGENTRUN_STATUSES,
    SEMANTIC_RELATIVE_DISTANCE_WINDOW as _SEMANTIC_RELATIVE_DISTANCE_WINDOW,
    WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR as _WHITEPAPER_CEPH_DEFAULT_CONFIG_DIR,
    WHITEPAPER_CEPH_DEFAULT_SECRET_DIR as _WHITEPAPER_CEPH_DEFAULT_SECRET_DIR,
    bool_env as _bool_env,
    coerce_issue_number as _coerce_issue_number,
    extract_github_event_metadata as _extract_github_event_metadata,
    extract_github_issue_payload as _extract_github_issue_payload,
    extract_sender_login as _extract_sender_login,
    float_env as _float_env,
    http_request_bytes as _http_request_bytes,
    int_env as _int_env,
    mounted_or_env_value as _mounted_or_env_value,
    normalize_identifier as _normalize_identifier,
    read_text_file as _read_text_file,
    sorted_unique as _sorted_unique,
    str_env as _str_env,
    whitepaper_ceph_bucket_name as _whitepaper_ceph_bucket_name,
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
    IssueRunIdentity as _IssueRunIdentity,
    PdfStorageOutcome as _PdfStorageOutcome,
    WhitepaperWorkflowServiceFields as _WhitepaperWorkflowServiceFields,
)
from .whitepaper_workflow_ingestion_methods import (
    WhitepaperWorkflowIngestionMethods as _WhitepaperWorkflowIngestionMethods,
)
from .whitepaper_workflow_persistence_methods import (
    WhitepaperWorkflowPersistenceMethods as _WhitepaperWorkflowPersistenceMethods,
)
from .whitepaper_workflow_agent_methods import (
    WhitepaperWorkflowAgentMethods as _WhitepaperWorkflowAgentMethods,
)


@dataclass(frozen=True)
class EmbeddingRequestConfig:
    base_url: str
    api_key: str | None
    embedding_model: str
    configured_dimension: int
    timeout_seconds: int
    batch_size: int
    is_ollama_embed: bool
    endpoint: str
    truncate: str | None
    keep_alive: str | None
    headers: dict[str, str]


@dataclass(frozen=True)
class EngineeringDecisionPolicy:
    policy_ref: str
    rollout_profile: str
    min_confidence: float
    min_score: float
    priority_confidence: float
    priority_score: float
    auto_dispatch_enabled: bool


@dataclass(frozen=True)
class EngineeringDecisionSignals:
    gate_snapshot: dict[str, Any] | None
    gate_snapshot_hash: str | None
    gate_missing_codes: list[str]
    blocking_reason_codes: list[str]
    verdict_text: str
    score_value: float | None
    confidence_value: float | None
    requires_followup: bool
    hypothesis_id: str | None


@dataclass(frozen=True)
class EngineeringDecisionOutcome:
    implementation_grade: str
    dispatch_decision: str


class WhitepaperWorkflowVerdictMethods:
    def _embed_texts(self, texts: list[str]) -> tuple[str, int, list[list[float]]]:
        if not texts:
            raise ValueError("embedding_texts_required")

        config = self._embedding_request_config()
        ordered_embeddings: list[list[float]] = []
        observed_dimension: int | None = None
        for batch_start in range(0, len(texts), config.batch_size):
            batch = texts[batch_start : batch_start + config.batch_size]
            payload = self._embedding_request_payload(config, batch)

            status, _, raw = _http_request_bytes(
                config.endpoint,
                method="POST",
                headers=config.headers,
                body=json.dumps(payload).encode("utf-8"),
                timeout_seconds=config.timeout_seconds,
                max_response_bytes=15 * 1024 * 1024,
            )
            batch_embeddings, observed_dimension = self._parse_embedding_response(
                raw,
                status=status,
                config=config,
                batch_size=len(batch),
                observed_dimension=observed_dimension,
            )
            ordered_embeddings.extend(batch_embeddings)

        dimension = observed_dimension or config.configured_dimension
        if dimension <= 0:
            raise RuntimeError("embedding_dimension_unresolved")
        if config.configured_dimension > 0 and config.configured_dimension != dimension:
            raise RuntimeError(
                f"embedding_dimension_config_mismatch:expected_{config.configured_dimension}:actual_{dimension}"
            )

        return config.embedding_model, dimension, ordered_embeddings

    def _embedding_request_config(self) -> EmbeddingRequestConfig:
        base_url = (
            _str_env("WHITEPAPER_EMBEDDING_API_BASE_URL")
            or _str_env("OPENAI_BASE_URL")
            or "https://api.openai.com/v1"
        ).rstrip("/")
        if not base_url:
            raise RuntimeError("embedding_api_base_url_missing")
        api_key = _str_env("WHITEPAPER_EMBEDDING_API_KEY") or _str_env("OPENAI_API_KEY")
        embedding_model = (
            _str_env("WHITEPAPER_EMBEDDING_MODEL")
            or _str_env("OPENAI_EMBEDDING_MODEL")
            or "text-embedding-3-large"
        )
        is_ollama_embed = base_url.endswith("/api")
        return EmbeddingRequestConfig(
            base_url=base_url,
            api_key=api_key,
            embedding_model=embedding_model,
            configured_dimension=_int_env("WHITEPAPER_EMBEDDING_DIMENSION", 4096),
            timeout_seconds=max(
                1, _int_env("WHITEPAPER_EMBEDDING_TIMEOUT_MS", 20_000) // 1000
            ),
            batch_size=max(1, _int_env("WHITEPAPER_EMBEDDING_BATCH_SIZE", 32)),
            is_ollama_embed=is_ollama_embed,
            endpoint=f"{base_url}/{'embed' if is_ollama_embed else 'embeddings'}",
            truncate=_str_env("WHITEPAPER_EMBEDDING_TRUNCATE"),
            keep_alive=_str_env("WHITEPAPER_EMBEDDING_KEEP_ALIVE"),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
            },
        )

    @staticmethod
    def _embedding_request_payload(
        config: EmbeddingRequestConfig,
        batch: list[str],
    ) -> dict[str, Any]:
        if config.is_ollama_embed:
            payload: dict[str, Any] = {
                "model": config.embedding_model,
                "input": batch,
            }
            if config.truncate is not None:
                payload["truncate"] = config.truncate.lower() in {
                    "1",
                    "true",
                    "yes",
                    "on",
                }
            if config.keep_alive is not None:
                payload["keep_alive"] = config.keep_alive
            return payload
        payload = {
            "model": config.embedding_model,
            "input": batch,
            "encoding_format": "float",
        }
        if config.configured_dimension > 0:
            payload["dimensions"] = config.configured_dimension
        return payload

    def _parse_embedding_response(
        self,
        raw: bytes,
        *,
        status: int,
        config: EmbeddingRequestConfig,
        batch_size: int,
        observed_dimension: int | None,
    ) -> tuple[list[list[float]], int | None]:
        body = raw.decode("utf-8", errors="replace")
        if status < 200 or status >= 300:
            raise RuntimeError(f"embedding_http_{status}:{body[:220]}")
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            raise RuntimeError("embedding_invalid_response")
        if config.is_ollama_embed:
            return self._parse_ollama_embedding_response(
                parsed,
                batch_size=batch_size,
                observed_dimension=observed_dimension,
            )
        return self._parse_openai_embedding_response(
            parsed,
            batch_size=batch_size,
            observed_dimension=observed_dimension,
        )

    def _parse_ollama_embedding_response(
        self,
        parsed: Mapping[str, Any],
        *,
        batch_size: int,
        observed_dimension: int | None,
    ) -> tuple[list[list[float]], int | None]:
        raw_embeddings = parsed.get("embeddings")
        if raw_embeddings is None:
            raw_embeddings = parsed.get("embedding")
        if not isinstance(raw_embeddings, list):
            raise RuntimeError("embedding_invalid_data")
        matrix = (
            raw_embeddings
            if raw_embeddings and isinstance(raw_embeddings[0], list)
            else [raw_embeddings]
        )
        if len(matrix) != batch_size:
            raise RuntimeError("embedding_missing_row")
        return self._coerce_embedding_matrix(
            matrix, observed_dimension=observed_dimension
        )

    def _parse_openai_embedding_response(
        self,
        parsed: Mapping[str, Any],
        *,
        batch_size: int,
        observed_dimension: int | None,
    ) -> tuple[list[list[float]], int | None]:
        data = parsed.get("data")
        if not isinstance(data, list):
            raise RuntimeError("embedding_invalid_data")
        indexed_batch_embeddings = self._indexed_openai_embedding_rows(
            data,
            observed_dimension=observed_dimension,
        )
        embeddings: list[list[float]] = []
        for local_index in range(batch_size):
            embedding_values = indexed_batch_embeddings.get(local_index)
            if embedding_values is None:
                raise RuntimeError("embedding_missing_row")
            embeddings.append(embedding_values)
        observed = (
            len(next(iter(indexed_batch_embeddings.values())))
            if indexed_batch_embeddings
            else observed_dimension
        )
        return embeddings, observed

    def _indexed_openai_embedding_rows(
        self,
        data: list[Any],
        *,
        observed_dimension: int | None,
    ) -> dict[int, list[float]]:
        indexed_batch_embeddings: dict[int, list[float]] = {}
        current_dimension = observed_dimension
        for row in data:
            if not isinstance(row, Mapping):
                continue
            index_raw = row.get("index")
            embedding_raw = row.get("embedding")
            if not isinstance(index_raw, int) or not isinstance(embedding_raw, list):
                continue
            embedding_values, current_dimension = self._coerce_embedding_row(
                embedding_raw,
                observed_dimension=current_dimension,
            )
            indexed_batch_embeddings[index_raw] = embedding_values
        return indexed_batch_embeddings

    def _coerce_embedding_matrix(
        self,
        matrix: list[Any],
        *,
        observed_dimension: int | None,
    ) -> tuple[list[list[float]], int | None]:
        embeddings: list[list[float]] = []
        current_dimension = observed_dimension
        for row in matrix:
            if not isinstance(row, list):
                raise RuntimeError("embedding_invalid_data")
            embedding_values, current_dimension = self._coerce_embedding_row(
                row,
                observed_dimension=current_dimension,
            )
            embeddings.append(embedding_values)
        return embeddings, current_dimension

    @staticmethod
    def _coerce_embedding_row(
        row: list[Any],
        *,
        observed_dimension: int | None,
    ) -> tuple[list[float], int]:
        embedding_values = [float(value) for value in row]
        dimension = len(embedding_values)
        if observed_dimension is not None and observed_dimension != dimension:
            raise RuntimeError("embedding_dimension_mismatch")
        return embedding_values, dimension

    @staticmethod
    def _vector_to_text(values: list[float]) -> str:
        serialized = ",".join(format(float(value), ".12g") for value in values)
        return f"[{serialized}]"

    @staticmethod
    def _build_search_snippet(content: str, query: str) -> str:
        normalized_content = content.strip()
        if not normalized_content:
            return ""

        terms = [part.strip() for part in re.split(r"\s+", query) if part.strip()]
        focus_term = None
        for term in terms:
            if len(term) >= 3:
                focus_term = re.escape(term)
                break

        if focus_term is None:
            return normalized_content[:220] + (
                "…" if len(normalized_content) > 220 else ""
            )

        match = re.search(focus_term, normalized_content, re.IGNORECASE)
        if match is None:
            return normalized_content[:220] + (
                "…" if len(normalized_content) > 220 else ""
            )

        start = max(0, match.start() - 120)
        end = min(len(normalized_content), match.end() + 120)
        snippet = normalized_content[start:end].strip()
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(normalized_content) else ""
        return f"{prefix}{snippet}{suffix}"

    def _evaluate_and_process_engineering_trigger(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        *,
        manual_approval: ManualApprovalPayload | None,
    ) -> dict[str, Any]:
        verdict = run.viability_verdict
        decision = self._compute_engineering_grade_decision(
            run, verdict, manual_approval=manual_approval
        )
        existing_trigger = session.execute(
            select(WhitepaperEngineeringTrigger).where(
                WhitepaperEngineeringTrigger.analysis_run_id == run.id
            )
        ).scalar_one_or_none()
        already_dispatched = bool(
            existing_trigger is not None
            and self._optional_text(existing_trigger.dispatched_agentrun_name)
        )
        trigger = self._upsert_engineering_trigger(
            session,
            run=run,
            verdict=verdict,
            decision=decision,
            manual_approval=manual_approval,
        )

        should_dispatch = decision.decision == "queued"
        if already_dispatched:
            should_dispatch = False
            trigger.decision = "dispatched"

        if should_dispatch:
            try:
                dispatch_result = self._dispatch_engineering_agentrun(
                    session,
                    run=run,
                    trigger=trigger,
                    manual_approval=manual_approval,
                )
                trigger.decision = "dispatched"
                trigger.dispatched_agentrun_name = self._optional_text(
                    dispatch_result.get("agentrun_name")
                )
            except Exception as exc:
                reason_codes = list(cast(list[str], trigger.reason_codes_json or []))
                reason_codes.append(
                    f"engineering_dispatch_failed_{_normalize_identifier(type(exc).__name__)}"
                )
                trigger.decision = "failed"
                trigger.reason_codes_json = _sorted_unique(reason_codes)
            session.add(trigger)

        rollout_transitions: list[WhitepaperRolloutTransition] = []
        if trigger.decision == "dispatched" and trigger.rollout_profile == "automatic":
            rollout_transitions = self._run_auto_rollout_controller(
                session,
                trigger=trigger,
            )

        return self._build_engineering_trigger_payload(trigger, rollout_transitions)

    def _compute_engineering_grade_decision(
        self,
        run: WhitepaperAnalysisRun,
        verdict: WhitepaperViabilityVerdict | None,
        *,
        manual_approval: ManualApprovalPayload | None,
    ) -> EngineeringGradeDecision:
        policy = self._engineering_decision_policy(manual_approval)
        signals = self._engineering_decision_signals(run, verdict)
        reason_codes: list[str] = []
        reason_codes.extend(signals.gate_missing_codes)
        reason_codes.extend(signals.blocking_reason_codes)
        outcome = self._engineering_decision_outcome(
            run=run,
            verdict=verdict,
            policy=policy,
            signals=signals,
            reason_codes=reason_codes,
        )
        outcome = self._apply_manual_engineering_override(
            outcome,
            manual_approval=manual_approval,
            rollout_profile=policy.rollout_profile,
            reason_codes=reason_codes,
        )
        self._append_engineering_dispatch_reason_codes(
            outcome,
            manual_approval=manual_approval,
            auto_dispatch_enabled=policy.auto_dispatch_enabled,
            reason_codes=reason_codes,
        )

        return EngineeringGradeDecision(
            implementation_grade=outcome.implementation_grade,
            decision=outcome.dispatch_decision,
            reason_codes=_sorted_unique(reason_codes),
            policy_ref=policy.policy_ref,
            rollout_profile=policy.rollout_profile,
            gate_snapshot_hash=signals.gate_snapshot_hash,
            gate_snapshot=signals.gate_snapshot,
            hypothesis_id=signals.hypothesis_id,
            approval_token=self._engineering_approval_token(
                run=run,
                outcome=outcome,
                policy=policy,
                signals=signals,
                manual_approval=manual_approval,
            ),
        )

    def _engineering_decision_policy(
        self,
        manual_approval: ManualApprovalPayload | None,
    ) -> EngineeringDecisionPolicy:
        policy_ref = (
            _str_env(
                "WHITEPAPER_ENGINEERING_TRIGGER_POLICY_REF",
                "torghut-v5-high-confidence-trigger-v1",
            )
            or "torghut-v5-high-confidence-trigger-v1"
        )
        rollout_profile = self._normalize_rollout_profile(
            manual_approval.rollout_profile if manual_approval is not None else None
        )
        if manual_approval is None:
            rollout_profile = self._normalize_rollout_profile(
                _str_env("WHITEPAPER_ENGINEERING_ROLLOUT_PROFILE", rollout_profile)
            )
        min_confidence = _float_env("WHITEPAPER_ENGINEERING_MIN_CONFIDENCE", 0.80)
        min_score = _float_env("WHITEPAPER_ENGINEERING_MIN_SCORE", 0.75)
        return EngineeringDecisionPolicy(
            policy_ref=policy_ref,
            rollout_profile=rollout_profile,
            min_confidence=min_confidence,
            min_score=min_score,
            priority_confidence=_float_env(
                "WHITEPAPER_ENGINEERING_PRIORITY_MIN_CONFIDENCE",
                max(min_confidence, 0.90),
            ),
            priority_score=_float_env(
                "WHITEPAPER_ENGINEERING_PRIORITY_MIN_SCORE",
                max(min_score, 0.90),
            ),
            auto_dispatch_enabled=_bool_env(
                "WHITEPAPER_ENGINEERING_AUTO_DISPATCH_ENABLED",
                default=True,
            ),
        )

    def _engineering_decision_signals(
        self,
        run: WhitepaperAnalysisRun,
        verdict: WhitepaperViabilityVerdict | None,
    ) -> EngineeringDecisionSignals:
        gate_snapshot = self._as_json_record(
            verdict.gating_json if verdict is not None else None
        )
        gate_statuses = self._extract_gate_statuses(gate_snapshot)
        return EngineeringDecisionSignals(
            gate_snapshot=gate_snapshot,
            gate_snapshot_hash=(
                self._compute_json_hash(gate_snapshot)
                if gate_snapshot is not None
                else None
            ),
            gate_missing_codes=self._missing_gate_reason_codes(
                gate_statuses,
                required=("g1", "g2", "g3", "g4", "g5"),
            ),
            blocking_reason_codes=self._gating_blocking_reason_codes(
                gate_snapshot,
                gate_statuses,
            ),
            verdict_text=(
                self._optional_text(verdict.verdict).lower()
                if verdict is not None and verdict.verdict
                else "missing"
            ),
            score_value=(
                float(verdict.score)
                if verdict is not None and verdict.score is not None
                else None
            ),
            confidence_value=(
                float(verdict.confidence)
                if verdict is not None and verdict.confidence is not None
                else None
            ),
            requires_followup=bool(verdict.requires_followup)
            if verdict is not None
            else True,
            hypothesis_id=self._derive_hypothesis_id(run),
        )

    def _engineering_decision_outcome(
        self,
        *,
        run: WhitepaperAnalysisRun,
        verdict: WhitepaperViabilityVerdict | None,
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
        reason_codes: list[str],
    ) -> EngineeringDecisionOutcome:
        if run.status != "completed":
            reason_codes.append("run_status_not_completed")
            return EngineeringDecisionOutcome("research_only", "suppressed")
        if verdict is None:
            reason_codes.append("verdict_missing")
            return EngineeringDecisionOutcome("reject", "suppressed")
        self._append_verdict_quality_reason_codes(policy, signals, reason_codes)
        return self._completed_verdict_engineering_outcome(
            policy, signals, reason_codes
        )

    @staticmethod
    def _append_verdict_quality_reason_codes(
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
        reason_codes: list[str],
    ) -> None:
        if signals.verdict_text not in _ELIGIBLE_AUTO_VERDICTS:
            reason_codes.append(
                f"verdict_not_auto_eligible_{_normalize_identifier(signals.verdict_text)}"
            )
        if signals.confidence_value is None:
            reason_codes.append("confidence_missing")
        elif signals.confidence_value < policy.min_confidence:
            reason_codes.append("confidence_below_min")
        if signals.score_value is None:
            reason_codes.append("score_missing")
        elif signals.score_value < policy.min_score:
            reason_codes.append("score_below_min")
        if signals.requires_followup:
            reason_codes.append("requires_followup_true")

    def _completed_verdict_engineering_outcome(
        self,
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
        reason_codes: list[str],
    ) -> EngineeringDecisionOutcome:
        if self._verdict_should_reject(policy, signals):
            return EngineeringDecisionOutcome("reject", "suppressed")
        if self._verdict_requires_research_only(signals):
            if signals.gate_snapshot is None:
                reason_codes.append("gating_json_missing")
            return EngineeringDecisionOutcome("research_only", "suppressed")
        if self._verdict_queues_engineering(policy, signals):
            return EngineeringDecisionOutcome(
                self._engineering_grade_for_scores(policy, signals),
                "queued" if policy.auto_dispatch_enabled else "suppressed",
            )
        return EngineeringDecisionOutcome("research_only", "suppressed")

    @staticmethod
    def _verdict_should_reject(
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
    ) -> bool:
        return signals.verdict_text in _REJECT_VERDICTS or (
            signals.confidence_value is not None
            and signals.confidence_value < policy.min_confidence
        )

    @staticmethod
    def _verdict_requires_research_only(signals: EngineeringDecisionSignals) -> bool:
        return (
            signals.requires_followup
            or signals.gate_snapshot is None
            or bool(signals.gate_missing_codes)
            or bool(signals.blocking_reason_codes)
        )

    @staticmethod
    def _verdict_queues_engineering(
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
    ) -> bool:
        return (
            signals.verdict_text in _ELIGIBLE_AUTO_VERDICTS
            and signals.confidence_value is not None
            and signals.confidence_value >= policy.min_confidence
            and signals.score_value is not None
            and signals.score_value >= policy.min_score
        )

    @staticmethod
    def _engineering_grade_for_scores(
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
    ) -> str:
        if (
            signals.confidence_value is not None
            and signals.confidence_value >= policy.priority_confidence
            and signals.score_value is not None
            and signals.score_value >= policy.priority_score
        ):
            return "engineering_priority"
        return "engineering_candidate"

    def _apply_manual_engineering_override(
        self,
        outcome: EngineeringDecisionOutcome,
        *,
        manual_approval: ManualApprovalPayload | None,
        rollout_profile: str,
        reason_codes: list[str],
    ) -> EngineeringDecisionOutcome:
        if manual_approval is None:
            return outcome
        if self._manual_approval_allowed(rollout_profile):
            reason_codes.append("manual_override_applied")
            reason_codes.append(
                f"manual_override_source_{_normalize_identifier(manual_approval.approval_source)}"
            )
            return EngineeringDecisionOutcome(
                outcome.implementation_grade,
                "queued",
            )
        reason_codes.append("manual_override_not_allowed_for_profile")
        return EngineeringDecisionOutcome(outcome.implementation_grade, "suppressed")

    @staticmethod
    def _append_engineering_dispatch_reason_codes(
        outcome: EngineeringDecisionOutcome,
        *,
        manual_approval: ManualApprovalPayload | None,
        auto_dispatch_enabled: bool,
        reason_codes: list[str],
    ) -> None:
        if outcome.dispatch_decision == "queued":
            reason_codes.append("engineering_dispatch_queued")
        elif not auto_dispatch_enabled and manual_approval is None:
            reason_codes.append("auto_dispatch_disabled")

    @staticmethod
    def _engineering_approval_token(
        *,
        run: WhitepaperAnalysisRun,
        outcome: EngineeringDecisionOutcome,
        policy: EngineeringDecisionPolicy,
        signals: EngineeringDecisionSignals,
        manual_approval: ManualApprovalPayload | None,
    ) -> str:
        approval_seed = {
            "run_id": run.run_id,
            "grade": outcome.implementation_grade,
            "decision": outcome.dispatch_decision,
            "policy_ref": policy.policy_ref,
            "gate_snapshot_hash": signals.gate_snapshot_hash,
            "manual_override": bool(manual_approval is not None),
        }
        return (
            "wpat-"
            + hashlib.sha256(
                json.dumps(approval_seed, sort_keys=True).encode("utf-8")
            ).hexdigest()[:24]
        )

    def _upsert_engineering_trigger(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        verdict: WhitepaperViabilityVerdict | None,
        decision: EngineeringGradeDecision,
        manual_approval: ManualApprovalPayload | None,
    ) -> WhitepaperEngineeringTrigger:
        trigger = session.execute(
            select(WhitepaperEngineeringTrigger).where(
                WhitepaperEngineeringTrigger.analysis_run_id == run.id
            )
        ).scalar_one_or_none()
        if trigger is None:
            trigger = WhitepaperEngineeringTrigger(
                trigger_id=f"wptrig-{hashlib.sha256(run.run_id.encode('utf-8')).hexdigest()[:24]}",
                whitepaper_run_id=run.run_id,
                analysis_run_id=run.id,
                verdict_id=verdict.id if verdict is not None else None,
                hypothesis_id=decision.hypothesis_id,
                implementation_grade=decision.implementation_grade,
                decision=decision.decision,
                reason_codes_json=decision.reason_codes,
                approval_token=decision.approval_token,
                rollout_profile=decision.rollout_profile,
                policy_ref=decision.policy_ref,
                gate_snapshot_hash=decision.gate_snapshot_hash,
                gate_snapshot_json=decision.gate_snapshot,
            )
            if manual_approval is not None:
                trigger.approval_source = manual_approval.approval_source
                trigger.approved_by = manual_approval.approved_by
                trigger.approval_reason = manual_approval.approval_reason
                trigger.approved_at = datetime.now(timezone.utc)
            session.add(trigger)
            session.flush()
            return trigger

        trigger.verdict_id = verdict.id if verdict is not None else None
        trigger.hypothesis_id = decision.hypothesis_id
        trigger.implementation_grade = decision.implementation_grade
        trigger.decision = decision.decision
        trigger.reason_codes_json = decision.reason_codes
        trigger.approval_token = decision.approval_token
        trigger.rollout_profile = decision.rollout_profile
        trigger.policy_ref = decision.policy_ref
        trigger.gate_snapshot_hash = decision.gate_snapshot_hash
        trigger.gate_snapshot_json = decision.gate_snapshot
        if manual_approval is not None:
            trigger.approval_source = manual_approval.approval_source
            trigger.approved_by = manual_approval.approved_by
            trigger.approved_at = datetime.now(timezone.utc)
            trigger.approval_reason = manual_approval.approval_reason
        session.add(trigger)
        session.flush()
        return trigger

    def _run_auto_rollout_controller(
        self,
        session: Session,
        *,
        trigger: WhitepaperEngineeringTrigger,
    ) -> list[WhitepaperRolloutTransition]:
        existing_with_hash = (
            session.execute(
                select(WhitepaperRolloutTransition)
                .where(
                    WhitepaperRolloutTransition.trigger_id == trigger.id,
                    WhitepaperRolloutTransition.evidence_hash
                    == trigger.gate_snapshot_hash,
                )
                .order_by(WhitepaperRolloutTransition.created_at.asc())
            )
            .scalars()
            .all()
        )
        if existing_with_hash:
            return list(existing_with_hash)

        gate_snapshot = self._as_json_record(trigger.gate_snapshot_json)
        gate_statuses = self._extract_gate_statuses(gate_snapshot)
        transitions: list[WhitepaperRolloutTransition] = []
        current_stage: str | None = None
        stage_requirements: tuple[tuple[str, tuple[str, ...]], ...] = (
            ("paper", ("g1", "g2", "g3", "g4", "g5")),
            ("shadow", ("g1", "g2", "g3", "g4", "g5", "g6")),
            ("constrained_live", ("g1", "g2", "g3", "g4", "g5", "g6")),
            ("scaled_live", ("g1", "g2", "g3", "g4", "g5", "g6", "g7")),
        )

        for target_stage, required_gates in stage_requirements:
            gate_failures = self._required_gate_failures(
                gate_statuses, required=required_gates
            )
            if not gate_failures:
                transitions.append(
                    self._append_rollout_transition(
                        session,
                        trigger=trigger,
                        from_stage=current_stage,
                        to_stage=target_stage,
                        transition_type="advance",
                        status="passed",
                        reason_codes=["all_required_gates_pass"],
                        gate_results={
                            "required_gates": list(required_gates),
                            "gate_statuses": gate_statuses,
                        },
                        blocking_gate=None,
                    )
                )
                current_stage = target_stage
                continue

            blocking_gate = self._first_blocking_gate_id(gate_failures)
            if current_stage in {"shadow", "constrained_live", "scaled_live"}:
                rollback_target = self._rollback_target_stage(current_stage)
                transitions.append(
                    self._append_rollout_transition(
                        session,
                        trigger=trigger,
                        from_stage=current_stage,
                        to_stage=rollback_target,
                        transition_type="rollback",
                        status="rolled_back",
                        reason_codes=gate_failures,
                        gate_results={
                            "required_gates": list(required_gates),
                            "gate_statuses": gate_statuses,
                        },
                        blocking_gate=blocking_gate,
                    )
                )
                current_stage = rollback_target

            transitions.append(
                self._append_rollout_transition(
                    session,
                    trigger=trigger,
                    from_stage=current_stage,
                    to_stage=current_stage,
                    transition_type="halt",
                    status="halted",
                    reason_codes=gate_failures,
                    gate_results={
                        "required_gates": list(required_gates),
                        "gate_statuses": gate_statuses,
                    },
                    blocking_gate=blocking_gate,
                )
            )
            return transitions

        return transitions

    def _append_rollout_transition(
        self,
        session: Session,
        *,
        trigger: WhitepaperEngineeringTrigger,
        from_stage: str | None,
        to_stage: str | None,
        transition_type: str,
        status: str,
        reason_codes: list[str],
        gate_results: dict[str, Any],
        blocking_gate: str | None,
    ) -> WhitepaperRolloutTransition:
        sequence = self._next_rollout_sequence(session, trigger.id)
        transition_seed = (
            f"{trigger.trigger_id}:{trigger.gate_snapshot_hash}:{transition_type}:{from_stage or ''}:"
            f"{to_stage or ''}:{sequence}"
        )
        transition = WhitepaperRolloutTransition(
            transition_id=f"wprt-{hashlib.sha256(transition_seed.encode('utf-8')).hexdigest()[:24]}",
            trigger_id=trigger.id,
            whitepaper_run_id=trigger.whitepaper_run_id,
            from_stage=from_stage,
            to_stage=to_stage,
            transition_type=transition_type,
            status=status,
            gate_results_json=coerce_json_payload(gate_results),
            reason_codes_json=_sorted_unique(reason_codes),
            blocking_gate=blocking_gate,
            evidence_hash=trigger.gate_snapshot_hash,
        )
        session.add(transition)
        session.flush()
        return transition

    def _next_rollout_sequence(self, session: Session, trigger_id: Any) -> int:
        existing_count = session.execute(
            select(func.count())
            .select_from(WhitepaperRolloutTransition)
            .where(WhitepaperRolloutTransition.trigger_id == trigger_id)
        ).scalar_one()
        return int(existing_count or 0) + 1


__all__ = [name for name in globals() if not name.startswith("__")]
