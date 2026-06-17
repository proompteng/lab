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


class _WhitepaperWorkflowApiMethods:
    def _compiled_experiment_specs_from_templates(
        self,
        *,
        run_id: str,
        claims: list[dict[str, Any]],
        relations: list[dict[str, Any]],
        templates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not templates and claims:
            family_template_dir = Path(
                os.getenv(
                    "TORGHUT_WHITEPAPER_FAMILY_TEMPLATE_DIR",
                    "config/trading/families",
                )
            )
            seed_sweep_dir = Path(
                os.getenv(
                    "TORGHUT_WHITEPAPER_SEED_SWEEP_DIR",
                    "config/trading",
                )
            )
            compilation = compile_claim_payloads_to_whitepaper_experiments(
                run_id=run_id,
                claims=claims,
                relations=relations,
                target_net_pnl_per_day=Decimal("500"),
                family_template_dir=family_template_dir,
                seed_sweep_dir=seed_sweep_dir,
            )
            return [dict(item) for item in compilation.whitepaper_experiment_payloads]
        if not templates:
            return []
        linked_claim_ids = [
            str(item.get("claim_id") or "").strip()
            for item in claims
            if str(item.get("claim_id") or "").strip()
        ]
        results: list[dict[str, Any]] = []
        for index, template in enumerate(templates, start=1):
            template_id = (
                self._optional_text(template.get("template_id")) or f"template-{index}"
            )
            family_template_id = (
                self._optional_text(template.get("family_template_id"))
                or "unspecified_family"
            )
            hypothesis = (
                self._optional_text(template.get("hypothesis"))
                or self._optional_text(template.get("economic_mechanism"))
                or f"Experiment for {family_template_id}"
            )
            results.append(
                {
                    "experiment_id": f"{run_id}-{template_id}-exp",
                    "family_template_id": family_template_id,
                    "template_id": template_id,
                    "hypothesis": hypothesis,
                    "paper_claim_links": linked_claim_ids,
                    "dataset_snapshot_policy": {
                        "source": "historical_market_replay",
                        "window_size": "PT1S",
                    },
                    "template_overrides": {},
                    "feature_variants": template.get("allowed_normalizations") or [],
                    "veto_controller_variants": template.get("day_veto_rules") or [],
                    "selection_objectives": template.get("selection_objectives") or {},
                    "hard_vetoes": template.get("hard_vetoes") or {},
                    "expected_failure_modes": [],
                    "promotion_contract": {
                        "requires_claim_review": True,
                        "source": "whitepaper_research_factory",
                    },
                }
            )
        return results

    def _inferred_contradiction_events(
        self,
        relations: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for relation in relations:
            relation_type = _normalize_identifier(
                self._optional_text(relation.get("relation_type")) or ""
            )
            if relation_type not in {
                "contradicts",
                "contradicting",
                "conflicts_with",
                "conflict",
            }:
                continue
            relation_id = self._optional_text(relation.get("relation_id")) or str(
                uuid.uuid4()
            )
            source_claim_id = self._optional_text(relation.get("source_claim_id"))
            if not source_claim_id:
                continue
            events.append(
                {
                    "event_id": f"contradiction-{relation_id}",
                    "source_claim_id": source_claim_id,
                    "target_claim_id": self._optional_text(
                        relation.get("target_claim_id")
                    ),
                    "target_run_id": self._optional_text(relation.get("target_run_id")),
                    "status": "open",
                    "required_action": "revalidate_linked_family",
                    "rationale": self._optional_text(relation.get("rationale")),
                    "metadata": {"derived_from_relation_id": relation_id},
                }
            )
        return events

    def _sync_structured_research_outputs(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        payload: Mapping[str, Any],
    ) -> None:
        claims = self._structured_output_list(payload, key="claims")
        relations = self._structured_output_list(payload, key="claim_relations")
        templates = self._structured_output_list(payload, key="strategy_templates")
        experiment_specs = self._structured_output_list(payload, key="experiment_specs")
        contradiction_events = self._structured_output_list(
            payload, key="contradiction_events"
        )
        if not experiment_specs:
            experiment_specs = self._compiled_experiment_specs_from_templates(
                run_id=run.run_id,
                claims=claims,
                relations=relations,
                templates=templates,
            )
        contradiction_events = [
            *contradiction_events,
            *self._inferred_contradiction_events(relations),
        ]

        session.execute(
            delete(WhitepaperClaimRelation).where(
                WhitepaperClaimRelation.analysis_run_id == run.id
            )
        )
        session.execute(
            delete(WhitepaperClaim).where(WhitepaperClaim.analysis_run_id == run.id)
        )
        session.execute(
            delete(WhitepaperStrategyTemplate).where(
                WhitepaperStrategyTemplate.analysis_run_id == run.id
            )
        )
        session.execute(
            delete(WhitepaperExperimentSpec).where(
                WhitepaperExperimentSpec.analysis_run_id == run.id
            )
        )
        session.execute(
            delete(WhitepaperContradictionEvent).where(
                WhitepaperContradictionEvent.analysis_run_id == run.id
            )
        )
        session.execute(
            delete(VNextExperimentSpec).where(
                VNextExperimentSpec.run_id == run.run_id,
                VNextExperimentSpec.candidate_id.is_(None),
            )
        )

        for claim in claims:
            claim_id = self._optional_text(claim.get("claim_id"))
            claim_text = self._optional_text(
                claim.get("claim_text")
            ) or self._optional_text(claim.get("claim"))
            if not claim_id or not claim_text:
                continue
            session.add(
                WhitepaperClaim(
                    analysis_run_id=run.id,
                    claim_id=claim_id,
                    claim_type=self._optional_text(claim.get("claim_type"))
                    or "signal_mechanism",
                    claim_text=claim_text,
                    asset_scope=self._optional_text(claim.get("asset_scope")),
                    horizon_scope=self._optional_text(claim.get("horizon_scope")),
                    data_requirements_json=self._optional_json(
                        claim.get("data_requirements")
                    ),
                    expected_direction=self._optional_text(
                        claim.get("expected_direction")
                    ),
                    required_activity_conditions_json=self._optional_json(
                        claim.get("required_activity_conditions")
                    ),
                    liquidity_constraints_json=self._optional_json(
                        claim.get("liquidity_constraints")
                    ),
                    validation_notes=self._optional_text(claim.get("validation_notes")),
                    confidence=self._optional_decimal(claim.get("confidence")),
                    metadata_json=self._optional_json(claim.get("metadata")),
                )
            )

        for relation in relations:
            relation_id = self._optional_text(relation.get("relation_id"))
            source_claim_id = self._optional_text(relation.get("source_claim_id"))
            target_claim_id = self._optional_text(relation.get("target_claim_id"))
            if not relation_id or not source_claim_id or not target_claim_id:
                continue
            session.add(
                WhitepaperClaimRelation(
                    analysis_run_id=run.id,
                    relation_id=relation_id,
                    relation_type=self._optional_text(relation.get("relation_type"))
                    or "supports",
                    source_claim_id=source_claim_id,
                    target_claim_id=target_claim_id,
                    target_run_id=self._optional_text(relation.get("target_run_id")),
                    rationale=self._optional_text(relation.get("rationale")),
                    confidence=self._optional_decimal(relation.get("confidence")),
                    metadata_json=self._optional_json(relation.get("metadata")),
                )
            )

        for template in templates:
            template_id = self._optional_text(template.get("template_id"))
            family_template_id = self._optional_text(template.get("family_template_id"))
            economic_mechanism = self._optional_text(template.get("economic_mechanism"))
            if not template_id or not family_template_id or not economic_mechanism:
                continue
            session.add(
                WhitepaperStrategyTemplate(
                    analysis_run_id=run.id,
                    template_id=template_id,
                    family_template_id=family_template_id,
                    economic_mechanism=economic_mechanism,
                    hypothesis=self._optional_text(template.get("hypothesis")),
                    supported_markets_json=self._optional_json(
                        template.get("supported_markets")
                    ),
                    required_features_json=self._optional_json(
                        template.get("required_features")
                    ),
                    allowed_normalizations_json=self._optional_json(
                        template.get("allowed_normalizations")
                    ),
                    entry_motifs_json=self._optional_json(template.get("entry_motifs")),
                    exit_motifs_json=self._optional_json(template.get("exit_motifs")),
                    risk_controls_json=self._optional_json(
                        template.get("risk_controls")
                    ),
                    activity_model_json=self._optional_json(
                        template.get("activity_model")
                    ),
                    liquidity_assumptions_json=self._optional_json(
                        template.get("liquidity_assumptions")
                    ),
                    regime_activation_rules_json=self._optional_json(
                        template.get("regime_activation_rules")
                    ),
                    day_veto_rules_json=self._optional_json(
                        template.get("day_veto_rules")
                    ),
                    metadata_json=self._optional_json(template.get("metadata")),
                )
            )

        for experiment in experiment_specs:
            experiment_id = self._optional_text(experiment.get("experiment_id"))
            family_template_id = self._optional_text(
                experiment.get("family_template_id")
            )
            if not experiment_id or not family_template_id:
                continue
            payload_json = coerce_json_payload(dict(experiment))
            session.add(
                WhitepaperExperimentSpec(
                    analysis_run_id=run.id,
                    experiment_id=experiment_id,
                    family_template_id=family_template_id,
                    template_id=self._optional_text(experiment.get("template_id")),
                    hypothesis=self._optional_text(experiment.get("hypothesis")),
                    paper_claim_links_json=self._optional_json(
                        experiment.get("paper_claim_links")
                    ),
                    dataset_snapshot_policy_json=self._optional_json(
                        experiment.get("dataset_snapshot_policy")
                    ),
                    template_overrides_json=self._optional_json(
                        experiment.get("template_overrides")
                    ),
                    feature_variants_json=self._optional_json(
                        experiment.get("feature_variants")
                    ),
                    veto_controller_variants_json=self._optional_json(
                        experiment.get("veto_controller_variants")
                    ),
                    selection_objectives_json=self._optional_json(
                        experiment.get("selection_objectives")
                    ),
                    hard_vetoes_json=self._optional_json(experiment.get("hard_vetoes")),
                    expected_failure_modes_json=self._optional_json(
                        experiment.get("expected_failure_modes")
                    ),
                    promotion_contract_json=self._optional_json(
                        experiment.get("promotion_contract")
                    ),
                    payload_json=payload_json,
                )
            )
            session.add(
                VNextExperimentSpec(
                    run_id=run.run_id,
                    candidate_id=None,
                    experiment_id=experiment_id,
                    payload_json=payload_json,
                )
            )

        seen_event_ids: set[str] = set()
        for event in contradiction_events:
            event_id = self._optional_text(event.get("event_id"))
            source_claim_id = self._optional_text(event.get("source_claim_id"))
            if not event_id or not source_claim_id or event_id in seen_event_ids:
                continue
            seen_event_ids.add(event_id)
            session.add(
                WhitepaperContradictionEvent(
                    analysis_run_id=run.id,
                    event_id=event_id,
                    source_claim_id=source_claim_id,
                    target_claim_id=self._optional_text(event.get("target_claim_id")),
                    target_run_id=self._optional_text(event.get("target_run_id")),
                    status=self._optional_text(event.get("status")) or "open",
                    required_action=self._optional_text(event.get("required_action")),
                    rationale=self._optional_text(event.get("rationale")),
                    metadata_json=self._optional_json(event.get("metadata")),
                )
            )

    @staticmethod
    def _coerce_pr_payloads(pr_payload_raw: Any) -> list[dict[str, Any]]:
        if isinstance(pr_payload_raw, Mapping):
            return [cast(dict[str, Any], pr_payload_raw)]
        if isinstance(pr_payload_raw, list):
            return [
                cast(dict[str, Any], item)
                for item in pr_payload_raw
                if isinstance(item, Mapping)
            ]
        return []

    def _upsert_design_pull_requests(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        pr_payload_raw: Any,
    ) -> None:
        for index, pr_payload in enumerate(
            self._coerce_pr_payloads(pr_payload_raw), start=1
        ):
            self._upsert_design_pull_request(session, run, pr_payload, index)

    def _upsert_design_pull_request(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        pr_payload: dict[str, Any],
        index: int,
    ) -> None:
        attempt = int(pr_payload.get("attempt") or index)
        pr_row = session.execute(
            select(WhitepaperDesignPullRequest).where(
                WhitepaperDesignPullRequest.analysis_run_id == run.id,
                WhitepaperDesignPullRequest.attempt == attempt,
            )
        ).scalar_one_or_none()

        if pr_row is None:
            repository = (
                self._optional_text(pr_payload.get("repository"))
                or self._optional_text(
                    cast(dict[str, Any], run.orchestration_context_json or {}).get(
                        "repository"
                    )
                )
                or "proompteng/lab"
            )
            pr_row = WhitepaperDesignPullRequest(
                analysis_run_id=run.id,
                attempt=attempt,
                status=self._optional_text(pr_payload.get("status")) or "opened",
                repository=repository,
                base_branch=self._optional_text(pr_payload.get("base_branch"))
                or "main",
                head_branch=self._optional_text(pr_payload.get("head_branch"))
                or "codex/whitepaper",
                pr_number=self._optional_int(pr_payload.get("pr_number")),
                pr_url=self._optional_text(pr_payload.get("pr_url")),
                title=self._optional_text(pr_payload.get("title")),
                body=self._optional_text(pr_payload.get("body")),
                commit_sha=self._optional_text(pr_payload.get("commit_sha")),
                merge_commit_sha=self._optional_text(
                    pr_payload.get("merge_commit_sha")
                ),
                checks_url=self._optional_text(pr_payload.get("checks_url")),
                ci_status=self._optional_text(pr_payload.get("ci_status")),
                is_merged=bool(pr_payload.get("is_merged")),
                merged_at=datetime.now(timezone.utc)
                if pr_payload.get("is_merged")
                else None,
                metadata_json=coerce_json_payload(pr_payload),
            )
            session.add(pr_row)
            return

        pr_row.status = self._optional_text(pr_payload.get("status")) or pr_row.status
        pr_row.pr_number = (
            self._optional_int(pr_payload.get("pr_number")) or pr_row.pr_number
        )
        pr_row.pr_url = self._optional_text(pr_payload.get("pr_url")) or pr_row.pr_url
        pr_row.title = self._optional_text(pr_payload.get("title")) or pr_row.title
        pr_row.body = self._optional_text(pr_payload.get("body")) or pr_row.body
        pr_row.commit_sha = (
            self._optional_text(pr_payload.get("commit_sha")) or pr_row.commit_sha
        )
        pr_row.merge_commit_sha = (
            self._optional_text(pr_payload.get("merge_commit_sha"))
            or pr_row.merge_commit_sha
        )
        pr_row.checks_url = (
            self._optional_text(pr_payload.get("checks_url")) or pr_row.checks_url
        )
        pr_row.ci_status = (
            self._optional_text(pr_payload.get("ci_status")) or pr_row.ci_status
        )
        pr_row.is_merged = bool(pr_payload.get("is_merged"))
        if pr_row.is_merged and pr_row.merged_at is None:
            pr_row.merged_at = datetime.now(timezone.utc)
        pr_row.metadata_json = coerce_json_payload(pr_payload)
        session.add(pr_row)

    def _ingest_artifacts(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        artifact_payload_raw: Any,
    ) -> None:
        if not isinstance(artifact_payload_raw, list):
            return

        for item in artifact_payload_raw:
            if not isinstance(item, Mapping):
                continue
            artifact = cast(dict[str, Any], item)
            bucket = self._optional_text(artifact.get("ceph_bucket"))
            key = self._optional_text(artifact.get("ceph_object_key"))
            if bucket and key:
                existing_artifact = session.execute(
                    select(WhitepaperArtifact).where(
                        WhitepaperArtifact.ceph_bucket == bucket,
                        WhitepaperArtifact.ceph_object_key == key,
                    )
                ).scalar_one_or_none()
                if existing_artifact is not None:
                    continue
            session.add(
                WhitepaperArtifact(
                    document_id=run.document_id,
                    document_version_id=run.document_version_id,
                    analysis_run_id=run.id,
                    artifact_scope=self._optional_text(artifact.get("artifact_scope"))
                    or "run",
                    artifact_type=self._optional_text(artifact.get("artifact_type"))
                    or "generic",
                    artifact_role=self._optional_text(artifact.get("artifact_role")),
                    ceph_bucket=bucket,
                    ceph_object_key=key,
                    artifact_uri=self._optional_text(artifact.get("artifact_uri")),
                    checksum_sha256=self._optional_text(
                        artifact.get("checksum_sha256")
                    ),
                    size_bytes=self._optional_int(artifact.get("size_bytes")),
                    content_type=self._optional_text(artifact.get("content_type")),
                    metadata_json=coerce_json_payload(artifact),
                )
            )

    def _upsert_steps(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        steps_raw: Any,
    ) -> None:
        if not isinstance(steps_raw, list):
            return

        for index, step_raw in enumerate(steps_raw, start=1):
            if not isinstance(step_raw, Mapping):
                continue
            self._upsert_single_step(
                session, run, cast(dict[str, Any], step_raw), index
            )

    def _upsert_single_step(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        step_payload: dict[str, Any],
        index: int,
    ) -> None:
        step_name = (
            self._optional_text(step_payload.get("step_name")) or f"step_{index}"
        )
        attempt = int(step_payload.get("attempt") or 1)
        step = session.execute(
            select(WhitepaperAnalysisStep).where(
                WhitepaperAnalysisStep.analysis_run_id == run.id,
                WhitepaperAnalysisStep.step_name == step_name,
                WhitepaperAnalysisStep.attempt == attempt,
            )
        ).scalar_one_or_none()
        if step is None:
            step = WhitepaperAnalysisStep(
                analysis_run_id=run.id,
                step_name=step_name,
                step_order=int(step_payload.get("step_order") or index),
                attempt=attempt,
                status=self._optional_text(step_payload.get("status")) or "completed",
                executor=self._optional_text(step_payload.get("executor")),
                idempotency_key=self._optional_text(
                    step_payload.get("idempotency_key")
                ),
                trace_id=self._optional_text(step_payload.get("trace_id")),
                started_at=datetime.now(timezone.utc),
                completed_at=datetime.now(timezone.utc),
                duration_ms=self._optional_int(step_payload.get("duration_ms")),
                input_json=self._optional_json(step_payload.get("input_json")),
                output_json=self._optional_json(step_payload.get("output_json")),
                error_json=self._optional_json(step_payload.get("error_json")),
            )
            session.add(step)
            return

        step.status = self._optional_text(step_payload.get("status")) or step.status
        step.duration_ms = (
            self._optional_int(step_payload.get("duration_ms")) or step.duration_ms
        )
        step.input_json = (
            self._optional_json(step_payload.get("input_json")) or step.input_json
        )
        step.output_json = (
            self._optional_json(step_payload.get("output_json")) or step.output_json
        )
        step.error_json = (
            self._optional_json(step_payload.get("error_json")) or step.error_json
        )
        step.completed_at = datetime.now(timezone.utc)
        session.add(step)

    def _complete_run(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        payload: Mapping[str, Any],
    ) -> None:
        target_status = self._optional_text(payload.get("status")) or "completed"
        run.status = target_status
        run.result_payload_json = coerce_json_payload(cast(dict[str, Any], payload))
        run.completed_at = datetime.now(timezone.utc)
        run.failure_reason = (
            None
            if target_status == "completed"
            else self._optional_text(payload.get("failure_reason"))
        )
        session.add(run)

        if run.document is None:
            return
        run.document.status = "analyzed" if target_status == "completed" else "failed"
        run.document.last_processed_at = datetime.now(timezone.utc)
        session.add(run.document)

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_decimal(value: Any) -> Decimal | None:
        if value is None:
            return None
        try:
            return Decimal(str(value))
        except Exception:
            return None

    @staticmethod
    def _optional_json(value: Any) -> Any:
        if value is None:
            return None
        return coerce_json_payload(value)

    @staticmethod
    def _download_pdf(url: str) -> bytes:
        token = _str_env("WHITEPAPER_GITHUB_TOKEN")
        max_bytes = _int_env("WHITEPAPER_MAX_PDF_BYTES", 50 * 1024 * 1024)
        timeout = _int_env("WHITEPAPER_DOWNLOAD_TIMEOUT_SECONDS", 30)
        status, _, payload = _http_request_bytes(
            url,
            method="GET",
            headers={
                "Accept": "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
            timeout_seconds=timeout,
            max_response_bytes=max_bytes,
            follow_redirects=True,
        )
        if status < 200 or status >= 300:
            raise RuntimeError(f"pdf_download_http_{status}")
        if len(payload) > max_bytes:
            raise RuntimeError("pdf_too_large")
        return payload

    def _submit_agents_agentrun(
        self, payload: Mapping[str, Any], *, idempotency_key: str
    ) -> dict[str, Any]:
        submit_url = _str_env("WHITEPAPER_AGENTRUN_SUBMIT_URL")
        if not submit_url:
            agents_base_url = _str_env("AGENTS_BASE_URL") or _str_env(
                "JANGAR_BASE_URL", "http://agents.agents.svc.cluster.local"
            )
            if not agents_base_url:
                raise RuntimeError("agents_endpoint_not_configured")
            submit_url = f"{agents_base_url.rstrip('/')}/v1/agent-runs"

        auth_token = (
            _str_env("WHITEPAPER_AGENTRUN_API_TOKEN")
            or _str_env("AGENTS_API_KEY")
            or _str_env("JANGAR_API_KEY")
        )
        timeout = _int_env("WHITEPAPER_AGENTRUN_TIMEOUT_SECONDS", 20)
        status, _, raw_bytes = _http_request_bytes(
            submit_url,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Idempotency-Key": idempotency_key,
                **({"Authorization": f"Bearer {auth_token}"} if auth_token else {}),
            },
            body=json.dumps(payload).encode("utf-8"),
            timeout_seconds=timeout,
        )
        raw = raw_bytes.decode("utf-8", errors="replace")
        if status < 200 or status >= 300:
            raise RuntimeError(f"agents_submit_http_{status}:{raw[:200]}")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError("invalid_agents_response")
        return cast(dict[str, Any], parsed)

    @staticmethod
    def _build_whitepaper_prompt(
        *,
        run_id: str,
        repository: str,
        issue_url: str,
        issue_title: str,
        attachment_url: str,
        ceph_uri: str,
        subject: str | None,
        tags: list[str],
        analysis_mode: str,
    ) -> str:
        normalized_mode = normalize_analysis_mode(analysis_mode)
        subject_line = f"Subject: {subject}" if subject else "Subject: not specified"
        tags_line = f"Tags: {', '.join(tags)}" if tags else "Tags: none"

        mode_specific_requirements = [
            "4) Create/update a design document in this repository under docs/whitepapers/<run-id>/design.md.",
            "5) Open a PR from a codex/* branch into main with a production-ready design document.",
            "6) Emit machine-readable outputs exactly as synthesis.json and verdict.json in your run artifacts.",
        ]
        if normalized_mode == "analysis_only":
            mode_specific_requirements = [
                "4) Do not open a PR in analysis-only mode.",
                "5) Keep outputs machine-readable exactly as synthesis.json and verdict.json in your run artifacts.",
                "6) Include explicit 'implementation candidates' and 'blocked_by' sections inside synthesis output.",
            ]

        return "\n".join(
            [
                f"Objective: Analyze whitepaper run {run_id} and deliver high-signal conclusions.",
                f"Repository: {repository}",
                f"Issue: {issue_url}",
                f"Issue title: {issue_title}",
                f"Primary PDF URL: {attachment_url}",
                f"Ceph object URI: {ceph_uri}",
                f"Analysis mode: {normalized_mode}",
                subject_line,
                tags_line,
                "",
                "Requirements:",
                "1) Read the full whitepaper end-to-end (no abstract-only shortcuts).",
                "2) Produce synthesis.json with required keys: executive_summary, problem_statement, methodology_summary, key_findings, novelty_claims, risk_assessment, citations, implementation_plan_md, confidence.",
                "3) Include structured research outputs in synthesis.json: claims, claim_relations, strategy_templates, experiment_specs, contradiction_events.",
                "4) Produce a viability verdict with score, confidence, rejection reasons (if any), and follow-up recommendations.",
                *mode_specific_requirements,
                "",
                "Quality bar:",
                "- Be explicit about assumptions and unresolved risks.",
                "- Include concrete references to whitepaper sections/claims.",
                "- Keep behavior deterministic and auditable.",
            ]
        )


__all__ = [name for name in globals() if not name.startswith("__")]
