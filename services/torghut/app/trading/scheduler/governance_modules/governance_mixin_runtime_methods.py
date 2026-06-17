# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Trading scheduler governance, autonomy, and safety workflows."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional, cast

from ....config import settings
from ...autonomy import (
    DriftThresholds,
    DriftTriggerPolicy,
    decide_drift_action,
    detect_drift,
    evaluate_live_promotion_evidence,
    evaluate_evidence_continuity,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from ...autonomy.phase_manifest_contract import (
    build_phase_manifest_payload_with_runtime_and_rollback,
    coerce_path_strings,
)
from ...feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ...ingest import SignalBatch
from ...models import SignalEnvelope
from ...time_source import trading_now
from ..pipeline import TradingPipeline
from ..safety import (
    _FRESH_TAIL_NO_SIGNAL_REASONS,
    _coerce_recovery_reason_sequence,
    _is_market_session_open,
    _is_recoverable_emergency_stop_reason,
    _latch_signal_continuity_alert_state,
    _merge_emergency_stop_reasons,
    _record_signal_continuity_recovery_cycle,
    _signal_bootstrap_grace_active,
    _signal_tail_is_fresh,
    _split_emergency_stop_reasons,
)
from ..state import TradingState

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    _TradingSchedulerGovernanceMixinFields,
    _incident_payload_complete,
    _int_from_mapping,
    _parse_iso_datetime,
    _resolve_autonomy_artifact_root,
    logger,
)
from .governance_mixin_lifecycle_methods import (
    _TradingSchedulerGovernanceLifecycleMethods,
)
from .governance_mixin_decision_methods import (
    _TradingSchedulerGovernanceDecisionMethods,
)


class _TradingSchedulerGovernanceRuntimeMethods:
    def _apply_autonomy_lane_result(
        self,
        *,
        result: Any,
        run_output_dir: Path,
        signals: list[SignalEnvelope],
        now: datetime,
        requested_promotion_target: Literal["paper", "live"],
    ) -> None:
        self.state.autonomy_failure_streak = 0
        self.state.autonomy_runs_total += 1
        previous_candidate_id = self.state.last_autonomy_candidate_id
        self.state.last_autonomy_run_id = result.run_id
        self.state.last_autonomy_candidate_id = result.candidate_id
        self.state.last_autonomy_gates = str(result.gate_report_path)
        self.state.last_autonomy_actuation_intent = (
            str(result.actuation_intent_path) if result.actuation_intent_path else None
        )
        self.state.last_autonomy_phase_manifest = str(result.phase_manifest_path)
        self.state.last_autonomy_reason = None

        gate_report_raw = json.loads(
            result.gate_report_path.read_text(encoding="utf-8")
        )
        gate_report: dict[str, Any] = (
            cast(dict[str, Any], gate_report_raw)
            if isinstance(gate_report_raw, dict)
            else {}
        )
        if gate_report:
            self.state.metrics.record_uncertainty_gate(
                cast(Mapping[str, Any], gate_report)
            )
        actuation_payload: dict[str, Any] = {}
        actuation_gates_payload: Mapping[str, Any] = cast(Mapping[str, Any], {})
        actuation_allowed = False
        if result.actuation_intent_path is not None:
            try:
                actuation_raw = json.loads(
                    result.actuation_intent_path.read_text(encoding="utf-8")
                )
            except json.JSONDecodeError:
                self.state.last_autonomy_reason = "actuation_intent_unparseable"
            else:
                if isinstance(actuation_raw, dict):
                    actuation_payload = cast(dict[str, Any], actuation_raw)
                    actuation_gates_raw = actuation_payload.get("gates")
                    if isinstance(actuation_gates_raw, Mapping):
                        actuation_gates_payload = cast(
                            Mapping[str, Any], actuation_gates_raw
                        )
                    actuation_allowed = bool(
                        actuation_payload.get("actuation_allowed", False)
                    )
                    gates_candidate_id = str(
                        actuation_payload.get("candidate_id") or result.candidate_id
                    ).strip()
                    if gates_candidate_id:
                        self.state.last_autonomy_candidate_id = gates_candidate_id
                else:
                    self.state.last_autonomy_reason = "actuation_intent_malformed"
        else:
            self.state.last_autonomy_reason = "actuation_intent_missing"

        actuation_recommendation_trace_id = str(
            actuation_gates_payload.get("recommendation_trace_id") or ""
        ).strip()
        recommended_mode = str(gate_report.get("recommended_mode") or "shadow")
        self.state.last_autonomy_recommendation = recommended_mode
        throughput_raw = gate_report.get("throughput")
        throughput: Mapping[str, Any] = (
            cast(Mapping[str, Any], throughput_raw)
            if isinstance(throughput_raw, Mapping)
            else cast(Mapping[str, Any], {})
        )
        promotion_decision_raw = gate_report.get("promotion_decision")
        promotion_decision: Mapping[str, Any] = (
            cast(Mapping[str, Any], promotion_decision_raw)
            if isinstance(promotion_decision_raw, Mapping)
            else cast(Mapping[str, Any], {})
        )
        promotion_decision_candidate_id = str(
            promotion_decision.get("candidate_id") or result.candidate_id
        ).strip()
        if promotion_decision_candidate_id:
            self.state.last_autonomy_candidate_id = promotion_decision_candidate_id
        promotion_allowed = bool(promotion_decision.get("promotion_allowed", False))
        effective_promotion_allowed = bool(promotion_allowed and actuation_allowed)
        self.state.metrics.record_autonomy_promotion_outcome(
            signal_count=_int_from_mapping(throughput, "signal_count"),
            decision_count=_int_from_mapping(throughput, "decision_count"),
            trade_count=_int_from_mapping(throughput, "trade_count"),
            recommendation=recommended_mode,
            promotion_allowed=effective_promotion_allowed,
            outcome=(
                f"promoted_{recommended_mode}"
                if effective_promotion_allowed
                else f"blocked_{recommended_mode}"
            ),
        )
        if not actuation_allowed:
            logger.info(
                "Autonomy actuation blocked by actuation intent; run_id=%s candidate_id=%s",
                result.run_id,
                self.state.last_autonomy_candidate_id,
            )
        self._update_autonomy_recommendation_state(
            recommendation_payload=gate_report.get("promotion_recommendation"),
            previous_candidate_id=previous_candidate_id,
            promotion_decision_candidate_id=promotion_decision_candidate_id,
            recommendation_trace_id=(
                actuation_recommendation_trace_id
                if actuation_recommendation_trace_id
                else None
            ),
        )
        gate_provenance_raw = gate_report.get("provenance")
        gate_provenance = (
            cast(Mapping[str, Any], gate_provenance_raw)
            if isinstance(gate_provenance_raw, Mapping)
            else cast(Mapping[str, Any], {})
        )
        gate_report_trace_id = str(
            actuation_gates_payload.get("gate_report_trace_id")
            or gate_provenance.get("gate_report_trace_id")
            or ""
        ).strip()
        self._emit_autonomy_domain_telemetry(
            event_name="torghut.autonomy.cycle_completed",
            severity="info",
            properties={
                "torghut_run_id": result.run_id,
                "candidate_id": self.state.last_autonomy_candidate_id,
                "recommendation_trace_id": self.state.last_autonomy_recommendation_trace_id,
                "gate_report_trace_id": gate_report_trace_id or None,
                "promotion_target": requested_promotion_target,
                "recommended_mode": recommended_mode,
                "promotion_allowed": promotion_allowed,
                "actuation_allowed": actuation_allowed,
                "effective_promotion_allowed": effective_promotion_allowed,
                "signal_count": _int_from_mapping(throughput, "signal_count"),
                "decision_count": _int_from_mapping(throughput, "decision_count"),
                "trade_count": _int_from_mapping(throughput, "trade_count"),
            },
        )
        self._update_autonomy_throughput_state(
            throughput_payload=gate_report.get("throughput")
        )
        self.state.last_autonomy_error = None

        if settings.trading_drift_governance_enabled:
            drift_governance_payload = self._evaluate_drift_governance(
                run_output_dir=run_output_dir,
                run_id=result.run_id,
                signals=signals,
                gate_report_payload=gate_report,
                now=now,
            )
            last_manifest = self.state.last_autonomy_phase_manifest
            if last_manifest:
                self._append_runtime_governance_to_phase_manifest(
                    manifest_path=Path(last_manifest),
                    requested_promotion_target=requested_promotion_target,
                    drift_governance_payload=cast(
                        Mapping[str, Any], drift_governance_payload
                    ),
                    now=now,
                )
        else:
            self.state.drift_status = "disabled"
            self.state.drift_live_promotion_eligible = False
            self.state.drift_live_promotion_reasons = ["drift_governance_disabled"]
            if not self.state.emergency_stop_active:
                self.state.drift_last_detection_path = None
                self.state.drift_last_action_path = None
                self.state.drift_last_outcome_path = None
            last_manifest = self.state.last_autonomy_phase_manifest
            if last_manifest:
                self._append_runtime_governance_to_phase_manifest(
                    manifest_path=Path(last_manifest),
                    requested_promotion_target=requested_promotion_target,
                    drift_governance_payload={},
                    now=now,
                )

        if result.paper_patch_path is not None:
            self.state.last_autonomy_patch = str(result.paper_patch_path)
            self.state.autonomy_patches_total += 1
            self._evaluate_safety_controls()
            return
        self.state.last_autonomy_patch = None
        self._evaluate_safety_controls()

    def _append_runtime_governance_to_phase_manifest(
        self,
        manifest_path: Path,
        *,
        requested_promotion_target: str,
        drift_governance_payload: Mapping[str, Any],
        now: datetime,
    ) -> None:
        if not manifest_path.exists():
            return
        try:
            manifest_raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(manifest_raw, dict):
            return
        manifest = cast(dict[str, Any], manifest_raw)

        def _as_values(raw: Any) -> list[Any]:
            if isinstance(raw, list):
                return cast(list[Any], raw)
            if isinstance(raw, tuple):
                return list(cast(tuple[Any, ...], raw))
            if isinstance(raw, set):
                return list(cast(set[Any], raw))
            return []

        artifact_refs_payload = drift_governance_payload.get("artifact_refs", [])
        action_payload = drift_governance_payload.get("action")
        detection_payload = drift_governance_payload.get("detection")
        drift_status = (
            str(
                drift_governance_payload.get("drift_status")
                or self.state.drift_status
                or "skipped"
            )
            .strip()
            .lower()
        )
        has_payload_values = (
            drift_governance_payload.get("rollback_triggered")
            or isinstance(action_payload, Mapping)
            or _as_values(action_payload)
            or isinstance(detection_payload, Mapping)
            or _as_values(detection_payload)
            or drift_status in {"drift_detected", "unhealthy"}
            or (
                isinstance(artifact_refs_payload, (list, tuple, set))
                and _as_values(artifact_refs_payload)
            )
        )
        has_drift_payload = bool(has_payload_values)
        drift_reasons = sorted(
            {
                str(reason).strip()
                for reason in _as_values(drift_governance_payload.get("reasons", []))
                if str(reason).strip()
            }
        )
        if isinstance(action_payload, dict):
            action_payload_map = cast(dict[str, Any], action_payload)
            action_type = str(action_payload_map.get("action_type", "")).strip()
            action_triggered = bool(action_payload_map.get("triggered", False))
            action_reasons = sorted(
                {
                    str(reason).strip()
                    for reason in _as_values(action_payload_map.get("reason_codes", []))
                    if str(reason).strip()
                }
            )
        else:
            action_type = ""
            action_triggered = False
            action_reasons = []

        if isinstance(detection_payload, dict):
            detection_payload_map = cast(dict[str, Any], detection_payload)
            detection_reasons = sorted(
                {
                    str(reason).strip()
                    for reason in _as_values(
                        detection_payload_map.get("reason_codes", [])
                    )
                    if str(reason).strip()
                }
            )
        else:
            detection_reasons = []

        rollback_triggered = bool(
            self.state.emergency_stop_active
            or drift_governance_payload.get("rollback_triggered", False)
        )
        evidence_refs: list[str] = []
        if has_drift_payload:
            evidence_refs = [
                str(path).strip()
                for path in [
                    self.state.drift_last_detection_path,
                    self.state.drift_last_action_path,
                    self.state.drift_last_outcome_path,
                ]
                if isinstance(path, str) and path.strip()
            ]
            artifact_refs_payload = drift_governance_payload.get("artifact_refs", [])
            if isinstance(artifact_refs_payload, (list, tuple, set)):
                evidence_refs.extend(
                    [
                        str(item).strip()
                        for item in _as_values(artifact_refs_payload)
                        if str(item).strip()
                    ]
                )
            evidence_refs = sorted({item for item in evidence_refs if item})
        else:
            evidence_refs = []
        rollback_incident_evidence = (
            str(drift_governance_payload.get("rollback_incident_evidence", "")).strip()
            if isinstance(
                drift_governance_payload.get("rollback_incident_evidence", ""), str
            )
            else ""
        )
        if (
            not rollback_incident_evidence
            and rollback_triggered
            and isinstance(self.state.rollback_incident_evidence_path, str)
        ):
            rollback_incident_evidence = (
                self.state.rollback_incident_evidence_path.strip()
            )

        governance_status = (
            "fail"
            if rollback_triggered or drift_status in {"drift_detected", "unhealthy"}
            else "pass"
        )
        reasons = sorted(
            {
                str(item).strip()
                for item in (
                    *detection_reasons,
                    *action_reasons,
                    *drift_reasons,
                )
                if str(item).strip()
            }
        )

        manifest_payload = build_phase_manifest_payload_with_runtime_and_rollback(
            run_id=cast(str, manifest.get("run_id", "")),
            candidate_id=cast(str, manifest.get("candidate_id", "")),
            execution_context=cast(
                Mapping[str, Any],
                manifest.get("execution_context", {}),
            ),
            requested_promotion_target=requested_promotion_target,
            phase_timestamp=now,
            phase_payloads=cast(
                Sequence[Mapping[str, Any]],
                manifest.get("phases", []),
            ),
            governance_status=governance_status,
            drift_status=drift_status,
            action_type=action_type,
            action_triggered=action_triggered,
            rollback_triggered=rollback_triggered,
            rollback_incident_evidence_path=(
                rollback_incident_evidence if rollback_triggered else ""
            ),
            reasons=reasons,
            evidence_artifact_refs=evidence_refs,
            observation_summary=cast(
                Mapping[str, Any],
                manifest.get("observation_summary", {}),
            ),
            artifact_refs=[
                *coerce_path_strings(manifest.get("artifact_refs", [])),
                *evidence_refs,
            ],
            status=None,
            created_at=cast(datetime | str, manifest.get("created_at")),
            updated_at=now,
        )
        manifest.update(manifest_payload)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    def _update_autonomy_recommendation_state(
        self,
        *,
        recommendation_payload: Any,
        previous_candidate_id: str | None,
        promotion_decision_candidate_id: str,
        recommendation_trace_id: str | None = None,
    ) -> None:
        if not isinstance(recommendation_payload, dict):
            self.state.last_autonomy_promotion_action = None
            self.state.last_autonomy_promotion_eligible = None
            self.state.last_autonomy_recommendation_trace_id = None
            return
        recommendation = cast(dict[str, Any], recommendation_payload)
        action = str(recommendation.get("action", "")).strip().lower()
        if action:
            self.state.last_autonomy_promotion_action = action
            self.state.metrics.autonomy_promotion_action_total[action] = (
                self.state.metrics.autonomy_promotion_action_total.get(action, 0) + 1
            )
        self.state.last_autonomy_promotion_eligible = bool(
            recommendation.get("eligible", False)
        )
        self.state.last_autonomy_recommendation_trace_id = (
            recommendation_trace_id
            or str(recommendation.get("trace_id", "")).strip()
            or None
        )
        if action == "promote":
            self.state.metrics.autonomy_promotions_total += 1
            if (
                previous_candidate_id
                and promotion_decision_candidate_id
                and previous_candidate_id != promotion_decision_candidate_id
            ):
                self.state.metrics.autonomy_demotions_total += 1
            return
        if action == "deny":
            self.state.metrics.autonomy_denials_total += 1
            return
        if action == "demote":
            self.state.metrics.autonomy_demotions_total += 1

    def _update_autonomy_throughput_state(self, *, throughput_payload: Any) -> None:
        if not isinstance(throughput_payload, Mapping):
            self.state.last_autonomy_throughput = None
            return
        throughput = cast(dict[str, Any], throughput_payload)
        signal_count = int(throughput.get("signal_count", 0) or 0)
        decision_count = int(throughput.get("decision_count", 0) or 0)
        trade_count = int(throughput.get("trade_count", 0) or 0)
        fold_metrics_count = int(throughput.get("fold_metrics_count", 0) or 0)
        stress_metrics_count = int(throughput.get("stress_metrics_count", 0) or 0)
        self.state.last_autonomy_throughput = {
            "signal_count": signal_count,
            "decision_count": decision_count,
            "trade_count": trade_count,
            "fold_metrics_count": fold_metrics_count,
            "stress_metrics_count": stress_metrics_count,
            "no_signal_window": bool(throughput.get("no_signal_window", False)),
            "no_signal_reason": throughput.get("no_signal_reason"),
        }
        self.state.metrics.autonomy_last_signal_count = signal_count
        self.state.metrics.autonomy_last_decision_count = decision_count
        self.state.metrics.autonomy_last_trade_count = trade_count
        self.state.metrics.autonomy_last_fold_metrics_count = fold_metrics_count
        self.state.metrics.autonomy_last_stress_metrics_count = stress_metrics_count


class TradingSchedulerGovernanceMixin(
    _TradingSchedulerGovernanceMixinFields,
    _TradingSchedulerGovernanceLifecycleMethods,
    _TradingSchedulerGovernanceDecisionMethods,
    _TradingSchedulerGovernanceRuntimeMethods,
    object,
):
    pass


__all__ = ["TradingSchedulerGovernanceMixin", "_resolve_autonomy_artifact_root"]


__all__ = [name for name in globals() if not name.startswith("__")]
