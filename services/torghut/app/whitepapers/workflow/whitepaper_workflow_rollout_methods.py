"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Mapping, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import (
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperCodexAgentRun,
    WhitepaperEngineeringTrigger,
    WhitepaperRolloutTransition,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
    coerce_json_payload,
)


from .shared_context import (
    ManualApprovalPayload,
    PASS_GATE_STATUSES as _PASS_GATE_STATUSES,
    bool_env as _bool_env,
    int_env as _int_env,
    normalize_identifier as _normalize_identifier,
    optional_decimal as _optional_decimal,
    optional_json as _optional_json,
    optional_text as _optional_text,
    sorted_unique as _sorted_unique,
    str_env as _str_env,
    logger,
)
from .ceph_s3_client import (
    WhitepaperWorkflowServiceContract as _WhitepaperWorkflowServiceContract,
)


if TYPE_CHECKING:
    _WhitepaperWorkflowRolloutBase = _WhitepaperWorkflowServiceContract
else:
    _WhitepaperWorkflowRolloutBase = object


class WhitepaperWorkflowRolloutMethods(_WhitepaperWorkflowRolloutBase):
    def _dispatch_engineering_agentrun(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        trigger: WhitepaperEngineeringTrigger,
        manual_approval: ManualApprovalPayload | None,
    ) -> dict[str, Any]:
        context = cast(dict[str, Any], run.orchestration_context_json or {})
        marker = cast(dict[str, Any], context.get("marker") or {})
        repository = (
            _optional_text(
                manual_approval.repository if manual_approval is not None else None
            )
            or _optional_text(context.get("repository"))
            or _str_env("WHITEPAPER_DEFAULT_REPOSITORY", "proompteng/lab")
            or "proompteng/lab"
        )
        base_branch = (
            _optional_text(
                manual_approval.base if manual_approval is not None else None
            )
            or _optional_text(marker.get("base_branch"))
            or _str_env("WHITEPAPER_DEFAULT_BASE_BRANCH", "main")
            or "main"
        )
        head_branch = _optional_text(
            manual_approval.head if manual_approval is not None else None
        ) or self._default_engineering_head_branch(
            run.run_id,
            suffix="manual" if manual_approval is not None else "auto",
        )
        artifact_path = f"docs/whitepapers/{run.run_id}"
        issue_url = _optional_text(context.get("issue_url")) or ""
        issue_title = (
            _optional_text((run.document.title if run.document else None))
            or "Whitepaper analysis"
        )
        prompt = self._build_engineering_trigger_prompt(
            run_id=run.run_id,
            repository=repository,
            issue_url=issue_url,
            issue_title=issue_title,
            implementation_grade=trigger.implementation_grade,
            rollout_profile=trigger.rollout_profile,
            artifact_path=artifact_path,
            approval_reason=manual_approval.approval_reason
            if manual_approval is not None
            else None,
        )
        idempotency_key = (
            f"{run.run_id}-engineering-"
            f"{'manual' if manual_approval is not None else 'auto'}"
        )
        policy_ref = trigger.policy_ref or "torghut-v5-high-confidence-trigger-v1"
        payload: dict[str, Any] = {
            "namespace": _str_env(
                "WHITEPAPER_ENGINEERING_AGENTRUN_NAMESPACE", "agents"
            ),
            "idempotencyKey": idempotency_key,
            "agentRef": {
                "name": _str_env(
                    "WHITEPAPER_ENGINEERING_AGENT_NAME", "codex-whitepaper-agent"
                )
            },
            "runtime": {"type": "job"},
            "implementation": {
                "summary": f"Whitepaper engineering candidate {run.run_id}",
                "text": prompt,
                "source": {
                    "provider": "github",
                    "url": issue_url or f"https://github.com/{repository}",
                },
                "vcsRef": {
                    "name": _str_env(
                        "WHITEPAPER_ENGINEERING_AGENTRUN_VCS_REF", "github"
                    )
                },
                "labels": ["whitepaper", "engineering-candidate", "torghut", "b1"],
            },
            "vcsRef": {
                "name": _str_env("WHITEPAPER_ENGINEERING_AGENTRUN_VCS_REF", "github")
            },
            "vcsPolicy": {"required": True, "mode": "read-write"},
            "parameters": {
                "runId": run.run_id,
                "hypothesisRef": trigger.hypothesis_id or run.run_id,
                "policyRef": policy_ref,
                "repository": repository,
                "base": base_branch,
                "head": head_branch,
                "artifactPath": artifact_path,
                "rolloutProfile": trigger.rollout_profile,
                "approvalToken": trigger.approval_token,
                "approvalSource": trigger.approval_source or "policy_auto",
                "implementationGrade": trigger.implementation_grade,
            },
            "policy": {
                "secretBindingRef": _str_env(
                    "WHITEPAPER_ENGINEERING_AGENTRUN_SECRET_BINDING",
                    "codex-whitepaper-github-token",
                )
            },
            "ttlSecondsAfterFinished": _int_env(
                "WHITEPAPER_ENGINEERING_AGENTRUN_TTL_SECONDS", 7200
            ),
        }
        if manual_approval is not None:
            payload["parameters"]["approvedBy"] = manual_approval.approved_by
            payload["parameters"]["approvalReason"] = manual_approval.approval_reason
            payload["parameters"]["targetScope"] = manual_approval.target_scope or ""

        response_payload = self._submit_agents_agentrun(
            payload, idempotency_key=idempotency_key
        )
        resource = cast(dict[str, Any], response_payload.get("resource") or {})
        metadata = cast(dict[str, Any], resource.get("metadata") or {})
        status = cast(dict[str, Any], resource.get("status") or {})
        agentrun_name = str(metadata.get("name") or "").strip()
        agentrun_uid = str(metadata.get("uid") or "").strip() or None
        phase = str(status.get("phase") or "queued").strip().lower() or "queued"
        if not agentrun_name:
            raise RuntimeError("engineering_dispatch_missing_agentrun_name")

        step = WhitepaperAnalysisStep(
            analysis_run_id=run.id,
            step_name="engineering_dispatch",
            step_order=50,
            attempt=self._next_step_attempt(
                session,
                analysis_run_id=run.id,
                step_name="engineering_dispatch",
            ),
            status="completed",
            executor="torghut",
            idempotency_key=idempotency_key,
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            input_json={"payload": payload},
            output_json=response_payload,
        )
        session.add(step)
        session.flush()

        agentrun_row = WhitepaperCodexAgentRun(
            analysis_run_id=run.id,
            analysis_step_id=step.id,
            agentrun_name=agentrun_name,
            agentrun_namespace=_str_env(
                "WHITEPAPER_ENGINEERING_AGENTRUN_NAMESPACE", "agents"
            ),
            agentrun_uid=agentrun_uid,
            status=phase,
            execution_mode="engineering_candidate",
            requested_by=manual_approval.approved_by
            if manual_approval is not None
            else "policy_auto",
            vcs_provider="github",
            vcs_repository=repository,
            vcs_base_branch=base_branch,
            vcs_head_branch=head_branch,
            workspace_context_json={
                "issue_url": issue_url,
                "artifact_path": artifact_path,
                "trigger_id": trigger.trigger_id,
                "approval_source": trigger.approval_source or "policy_auto",
            },
            prompt_text=prompt,
            prompt_hash=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            input_context_json={"request": payload},
            output_context_json=response_payload,
            started_at=datetime.now(timezone.utc),
        )
        session.add(agentrun_row)
        session.flush()
        return {
            "agentrun_name": agentrun_name,
            "agentrun_uid": agentrun_uid,
            "status": phase,
        }

    def _default_engineering_head_branch(self, run_id: str, *, suffix: str) -> str:
        return f"codex/whitepaper-b1-{run_id[-16:]}-{suffix}"

    def _build_engineering_trigger_payload(
        self,
        trigger: WhitepaperEngineeringTrigger,
        rollout_transitions: list[WhitepaperRolloutTransition],
    ) -> dict[str, Any]:
        transitions_payload: list[dict[str, Any]] = []
        for item in rollout_transitions:
            transitions_payload.append(
                {
                    "transition_id": item.transition_id,
                    "from_stage": item.from_stage,
                    "to_stage": item.to_stage,
                    "transition_type": item.transition_type,
                    "status": item.status,
                    "reason_codes": self._coerce_string_list(item.reason_codes_json),
                    "blocking_gate": item.blocking_gate,
                    "created_at": (
                        item.created_at.isoformat() if item.created_at else None
                    ),
                }
            )
        return {
            "trigger_id": trigger.trigger_id,
            "run_id": trigger.whitepaper_run_id,
            "implementation_grade": trigger.implementation_grade,
            "decision": trigger.decision,
            "reason_codes": trigger.reason_codes_json or [],
            "approval_token": trigger.approval_token,
            "dispatched_agentrun_name": trigger.dispatched_agentrun_name,
            "rollout_profile": trigger.rollout_profile,
            "approval_source": trigger.approval_source,
            "approved_by": trigger.approved_by,
            "approved_at": trigger.approved_at.isoformat()
            if trigger.approved_at
            else None,
            "approval_reason": trigger.approval_reason,
            "policy_ref": trigger.policy_ref,
            "gate_snapshot_hash": trigger.gate_snapshot_hash,
            "rollout_transitions": transitions_payload,
        }

    def _build_engineering_trigger_prompt(
        self,
        *,
        run_id: str,
        repository: str,
        issue_url: str,
        issue_title: str,
        implementation_grade: str,
        rollout_profile: str,
        artifact_path: str,
        approval_reason: str | None,
    ) -> str:
        manual_line = (
            f"Manual approval rationale: {approval_reason}"
            if approval_reason
            else "Dispatch source: policy_auto"
        )
        return "\n".join(
            [
                f"Objective: Execute B1 engineering candidate implementation for whitepaper run {run_id}.",
                f"Repository: {repository}",
                f"Issue: {issue_url}",
                f"Issue title: {issue_title}",
                f"Implementation grade: {implementation_grade}",
                f"Rollout profile: {rollout_profile}",
                f"Artifact path: {artifact_path}",
                manual_line,
                "",
                "Constraints:",
                "1) Implement only B1 engineering candidate work (RFC/code/tests).",
                "2) Do not perform any production rollout or bypass deterministic promotion gates.",
                "3) Keep outputs reproducible with explicit evidence pointers and deterministic reason codes.",
                "4) Preserve fail-closed behavior when required artifacts are missing.",
            ]
        )

    @staticmethod
    def _compute_json_hash(payload: dict[str, Any] | None) -> str | None:
        if payload is None:
            return None
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _as_json_record(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, Mapping):
            return None
        return cast(
            dict[str, Any], coerce_json_payload(dict(cast(Mapping[str, Any], value)))
        )

    def _extract_gate_statuses(
        self, gate_snapshot: dict[str, Any] | None
    ) -> dict[str, str]:
        if gate_snapshot is None:
            return {}
        statuses: dict[str, str] = {}

        gates_raw = gate_snapshot.get("gates")
        if isinstance(gates_raw, Mapping):
            for gate_id_raw, gate_payload in cast(Mapping[Any, Any], gates_raw).items():
                gate_id = _normalize_identifier(str(gate_id_raw))
                if gate_id.startswith("gate"):
                    gate_id = gate_id.replace("gate", "g", 1)
                status_value = None
                if isinstance(gate_payload, Mapping):
                    status_value = _optional_text(
                        cast(Mapping[str, Any], gate_payload).get("status")
                    )
                else:
                    status_value = _optional_text(gate_payload)
                if status_value:
                    statuses[gate_id] = _normalize_identifier(status_value)
        elif isinstance(gates_raw, list):
            for entry in cast(list[object], gates_raw):
                if not isinstance(entry, Mapping):
                    continue
                gate_id_raw = (
                    _optional_text(cast(Mapping[str, Any], entry).get("gate_id"))
                    or _optional_text(cast(Mapping[str, Any], entry).get("id"))
                    or _optional_text(cast(Mapping[str, Any], entry).get("name"))
                )
                status_value = _optional_text(
                    cast(Mapping[str, Any], entry).get("status")
                )
                if not gate_id_raw or not status_value:
                    continue
                gate_id = _normalize_identifier(gate_id_raw)
                if gate_id.startswith("gate"):
                    gate_id = gate_id.replace("gate", "g", 1)
                statuses[gate_id] = _normalize_identifier(status_value)

        for key, value in gate_snapshot.items():
            normalized_key = _normalize_identifier(str(key))
            if normalized_key in {"g1", "g2", "g3", "g4", "g5", "g6", "g7"}:
                normalized_status = _optional_text(value)
                if normalized_status:
                    statuses[normalized_key] = _normalize_identifier(normalized_status)
        return statuses

    def _missing_gate_reason_codes(
        self,
        gate_statuses: dict[str, str],
        *,
        required: tuple[str, ...],
    ) -> list[str]:
        reasons: list[str] = []
        for gate_id in required:
            if gate_id not in gate_statuses:
                reasons.append(f"{gate_id}_status_missing")
        return reasons

    def _gating_blocking_reason_codes(
        self,
        gate_snapshot: dict[str, Any] | None,
        gate_statuses: dict[str, str],
    ) -> list[str]:
        if gate_snapshot is None:
            return []
        reasons: list[str] = []

        blocked_flag = bool(
            gate_snapshot.get("blocked") or gate_snapshot.get("blocking")
        )
        if blocked_flag:
            reasons.append("gating_blocked_flag_true")

        blocking_lists: tuple[object, ...] = (
            gate_snapshot.get("blocking_reasons"),
            gate_snapshot.get("blockingReasons"),
            gate_snapshot.get("blockers"),
            gate_snapshot.get("blocking_reason_codes"),
        )
        for raw_list in blocking_lists:
            if isinstance(raw_list, list):
                for item in cast(list[object], raw_list):
                    text = _optional_text(item)
                    if text:
                        reasons.append(f"gating_blocker_{_normalize_identifier(text)}")

        for gate_id, status in gate_statuses.items():
            if status not in _PASS_GATE_STATUSES:
                reasons.append(f"{gate_id}_status_{status}")
        return _sorted_unique(reasons)

    def _required_gate_failures(
        self,
        gate_statuses: dict[str, str],
        *,
        required: tuple[str, ...],
    ) -> list[str]:
        failures: list[str] = []
        for gate_id in required:
            status = gate_statuses.get(gate_id)
            if status is None:
                failures.append(f"{gate_id}_status_missing")
                continue
            if status not in _PASS_GATE_STATUSES:
                failures.append(f"{gate_id}_status_{status}")
        return _sorted_unique(failures)

    @staticmethod
    def _first_blocking_gate_id(reason_codes: list[str]) -> str | None:
        for reason in reason_codes:
            if reason.startswith("g") and "_status_" in reason:
                return reason.split("_status_", 1)[0]
        return None

    @staticmethod
    def _rollback_target_stage(stage: str) -> str:
        if stage == "scaled_live":
            return "constrained_live"
        if stage == "constrained_live":
            return "shadow"
        return "paper"

    def _manual_approval_allowed(self, rollout_profile: str) -> bool:
        if not _bool_env(
            "WHITEPAPER_ENGINEERING_MANUAL_OVERRIDE_ENABLED", default=True
        ):
            return False
        allowed_profiles_raw = (
            _str_env(
                "WHITEPAPER_ENGINEERING_MANUAL_ALLOWED_PROFILES",
                "manual,assisted,automatic",
            )
            or "manual,assisted,automatic"
        )
        allowed_profiles = {
            self._normalize_rollout_profile(item)
            for item in allowed_profiles_raw.split(",")
            if item.strip()
        }
        return rollout_profile in allowed_profiles

    def _normalize_rollout_profile(self, value: str | None) -> str:
        profile = _optional_text(value) or "manual"
        normalized = _normalize_identifier(profile)
        if normalized not in {"manual", "assisted", "automatic"}:
            return "manual"
        return normalized

    def _derive_hypothesis_id(self, run: WhitepaperAnalysisRun) -> str | None:
        synthesis_payload = (
            run.synthesis.synthesis_json if run.synthesis is not None else None
        )
        if isinstance(synthesis_payload, Mapping):
            explicit = _optional_text(
                cast(Mapping[str, Any], synthesis_payload).get("hypothesis_id")
            )
            if explicit:
                return explicit
        return f"hyp-{run.run_id}"

    def _upsert_synthesis(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        synthesis_payload_raw: Any,
    ) -> None:
        if not isinstance(synthesis_payload_raw, Mapping):
            return
        synthesis_payload = dict(cast(Mapping[str, Any], synthesis_payload_raw))
        self._populate_missing_implementation_plan_md(run.run_id, synthesis_payload)
        synthesis = session.execute(
            select(WhitepaperSynthesis).where(
                WhitepaperSynthesis.analysis_run_id == run.id
            )
        ).scalar_one_or_none()
        executive_summary = str(
            synthesis_payload.get("executive_summary") or ""
        ).strip()
        if not executive_summary:
            executive_summary = json.dumps(synthesis_payload, sort_keys=True)

        if synthesis is None:
            synthesis = WhitepaperSynthesis(
                analysis_run_id=run.id,
                synthesis_version=str(
                    synthesis_payload.get("synthesis_version") or "v1"
                ),
                generated_by=str(synthesis_payload.get("generated_by") or "codex"),
                model_name=_optional_text(synthesis_payload.get("model_name")),
                prompt_version=_optional_text(synthesis_payload.get("prompt_version")),
                executive_summary=executive_summary,
                problem_statement=_optional_text(
                    synthesis_payload.get("problem_statement")
                ),
                methodology_summary=_optional_text(
                    synthesis_payload.get("methodology_summary")
                ),
                key_findings_json=_optional_json(synthesis_payload.get("key_findings")),
                novelty_claims_json=_optional_json(
                    synthesis_payload.get("novelty_claims")
                ),
                risk_assessment_json=_optional_json(
                    synthesis_payload.get("risk_assessment")
                ),
                citations_json=_optional_json(synthesis_payload.get("citations")),
                implementation_plan_md=_optional_text(
                    synthesis_payload.get("implementation_plan_md")
                ),
                confidence=_optional_decimal(synthesis_payload.get("confidence")),
                synthesis_json=coerce_json_payload(synthesis_payload),
            )
            session.add(synthesis)
            return

        synthesis.executive_summary = executive_summary
        synthesis.problem_statement = _optional_text(
            synthesis_payload.get("problem_statement")
        )
        synthesis.methodology_summary = _optional_text(
            synthesis_payload.get("methodology_summary")
        )
        synthesis.key_findings_json = _optional_json(
            synthesis_payload.get("key_findings")
        )
        synthesis.novelty_claims_json = _optional_json(
            synthesis_payload.get("novelty_claims")
        )
        synthesis.risk_assessment_json = _optional_json(
            synthesis_payload.get("risk_assessment")
        )
        synthesis.citations_json = _optional_json(synthesis_payload.get("citations"))
        synthesis.implementation_plan_md = _optional_text(
            synthesis_payload.get("implementation_plan_md")
        )
        synthesis.confidence = _optional_decimal(synthesis_payload.get("confidence"))
        synthesis.synthesis_json = coerce_json_payload(synthesis_payload)
        session.add(synthesis)

    def _populate_missing_implementation_plan_md(
        self, run_id: str, synthesis_payload: dict[str, Any]
    ) -> None:
        if _optional_text(synthesis_payload.get("implementation_plan_md")):
            return
        derived_value = self._derive_implementation_plan_md(
            synthesis_payload.get("implementation_implications")
        )
        if not derived_value:
            return
        synthesis_payload["implementation_plan_md"] = derived_value
        logger.warning(
            "Whitepaper synthesis missing implementation_plan_md; auto-filled from implementation_implications "
            "(run_id=%s)",
            run_id,
        )

    @staticmethod
    def _derive_implementation_plan_md(value: Any) -> str | None:
        if isinstance(value, str):
            text = value.strip()
            return text or None
        if isinstance(value, list):
            bullet_points: list[str] = []
            for item in cast(list[object], value):
                text = str(item).strip() if item is not None else ""
                if text:
                    bullet_points.append(f"- {text}")
            return "\n".join(bullet_points) if bullet_points else None
        return None

    def _upsert_verdict(
        self,
        session: Session,
        run: WhitepaperAnalysisRun,
        verdict_payload_raw: Any,
    ) -> None:
        if not isinstance(verdict_payload_raw, Mapping):
            return
        verdict_payload = cast(dict[str, Any], verdict_payload_raw)
        verdict = session.execute(
            select(WhitepaperViabilityVerdict).where(
                WhitepaperViabilityVerdict.analysis_run_id == run.id
            )
        ).scalar_one_or_none()
        verdict_text = _optional_text(verdict_payload.get("verdict")) or "needs_review"
        approved_by = _optional_text(verdict_payload.get("approved_by"))
        gating_payload = self._build_verdict_gating_payload(verdict_payload)

        if verdict is None:
            verdict = WhitepaperViabilityVerdict(
                analysis_run_id=run.id,
                verdict=verdict_text,
                score=_optional_decimal(verdict_payload.get("score")),
                confidence=_optional_decimal(verdict_payload.get("confidence")),
                decision_policy=_optional_text(verdict_payload.get("decision_policy")),
                gating_json=_optional_json(gating_payload),
                rationale=_optional_text(verdict_payload.get("rationale")),
                rejection_reasons_json=_optional_json(
                    verdict_payload.get("rejection_reasons")
                ),
                recommendations_json=_optional_json(
                    verdict_payload.get("recommendations")
                ),
                requires_followup=bool(verdict_payload.get("requires_followup")),
                approved_by=approved_by,
                approved_at=datetime.now(timezone.utc) if approved_by else None,
            )
            session.add(verdict)
            return

        verdict.verdict = verdict_text
        verdict.score = _optional_decimal(verdict_payload.get("score"))
        verdict.confidence = _optional_decimal(verdict_payload.get("confidence"))
        verdict.decision_policy = _optional_text(verdict_payload.get("decision_policy"))
        verdict.gating_json = _optional_json(gating_payload)
        verdict.rationale = _optional_text(verdict_payload.get("rationale"))
        verdict.rejection_reasons_json = _optional_json(
            verdict_payload.get("rejection_reasons")
        )
        verdict.recommendations_json = _optional_json(
            verdict_payload.get("recommendations")
        )
        verdict.requires_followup = bool(verdict_payload.get("requires_followup"))
        verdict.approved_by = approved_by
        verdict.approved_at = (
            datetime.now(timezone.utc) if approved_by else verdict.approved_at
        )
        session.add(verdict)

    @staticmethod
    def _build_verdict_gating_payload(verdict_payload: Mapping[str, Any]) -> Any:
        base_gating = (
            verdict_payload.get("gating_json")
            if "gating_json" in verdict_payload
            else verdict_payload.get("gating")
        )
        dspy_eval_report = verdict_payload.get("dspy_eval_report")
        if not isinstance(dspy_eval_report, Mapping):
            return base_gating
        dspy_payload = coerce_json_payload(cast(dict[str, Any], dspy_eval_report))
        if isinstance(base_gating, Mapping):
            merged = dict(cast(dict[str, Any], base_gating))
            merged["dspy_eval_report"] = dspy_payload
            return merged
        if base_gating is None:
            return {"dspy_eval_report": dspy_payload}
        return {
            "gating": coerce_json_payload(base_gating),
            "dspy_eval_report": dspy_payload,
        }

    def _structured_output_list(
        self, payload: Mapping[str, Any], *, key: str
    ) -> list[dict[str, Any]]:
        direct = payload.get(key)
        if isinstance(direct, list):
            return [
                cast(dict[str, Any], item)
                for item in cast(list[object], direct)
                if isinstance(item, Mapping)
            ]
        synthesis_payload = payload.get("synthesis")
        if isinstance(synthesis_payload, Mapping):
            synthesis_map = cast(Mapping[str, Any], synthesis_payload)
            nested = synthesis_map.get(key)
            if isinstance(nested, list):
                return [
                    cast(dict[str, Any], item)
                    for item in cast(list[object], nested)
                    if isinstance(item, Mapping)
                ]
        return []
