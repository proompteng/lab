# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Trading scheduler governance, autonomy, and safety workflows."""

from __future__ import annotations

import json
import logging
import os
import sys
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
from .. import safety as _safety_private_37

from ..state import TradingState

# ruff: noqa: F401,F811,F821

from .shared_context import (
    logger,
)
from . import shared_context as _shared_context_private_53

_FRESH_TAIL_NO_SIGNAL_REASONS = getattr(
    _safety_private_37, "_FRESH_TAIL_NO_SIGNAL_REASONS"
)
_coerce_recovery_reason_sequence = getattr(
    _safety_private_37, "_coerce_recovery_reason_sequence"
)
_is_market_session_open = getattr(_safety_private_37, "_is_market_session_open")
_is_recoverable_emergency_stop_reason = getattr(
    _safety_private_37, "_is_recoverable_emergency_stop_reason"
)
_latch_signal_continuity_alert_state = getattr(
    _safety_private_37, "_latch_signal_continuity_alert_state"
)
_merge_emergency_stop_reasons = getattr(
    _safety_private_37, "_merge_emergency_stop_reasons"
)
_record_signal_continuity_recovery_cycle = getattr(
    _safety_private_37, "_record_signal_continuity_recovery_cycle"
)
_signal_bootstrap_grace_active = getattr(
    _safety_private_37, "_signal_bootstrap_grace_active"
)
_signal_tail_is_fresh = getattr(_safety_private_37, "_signal_tail_is_fresh")
_split_emergency_stop_reasons = getattr(
    _safety_private_37, "_split_emergency_stop_reasons"
)
_TradingSchedulerGovernanceMixinFields = getattr(
    _shared_context_private_53, "_TradingSchedulerGovernanceMixinFields"
)
_incident_payload_complete = getattr(
    _shared_context_private_53, "_incident_payload_complete"
)
_int_from_mapping = getattr(_shared_context_private_53, "_int_from_mapping")
_parse_iso_datetime = getattr(_shared_context_private_53, "_parse_iso_datetime")
_resolve_autonomy_artifact_root = getattr(
    _shared_context_private_53, "_resolve_autonomy_artifact_root"
)


def _governance_root_export(name: str, fallback: Any) -> Any:
    root_module = sys.modules.get("app.trading.scheduler.governance")
    if root_module is None:
        return fallback
    return getattr(root_module, name, fallback)


class _TradingSchedulerGovernanceLifecycleMethods:
    def _emit_autonomy_domain_telemetry(
        self, *, event_name: str, severity: str, properties: Mapping[str, Any]
    ) -> None:
        raise NotImplementedError

    def _drift_thresholds(self) -> DriftThresholds:
        return DriftThresholds(
            max_required_null_rate=Decimal(
                str(settings.trading_drift_max_required_null_rate)
            ),
            max_staleness_ms_p95=max(
                0, int(settings.trading_drift_max_staleness_ms_p95)
            ),
            max_duplicate_ratio=Decimal(
                str(settings.trading_drift_max_duplicate_ratio)
            ),
            max_schema_mismatch_total=max(
                0, int(settings.trading_drift_max_schema_mismatch_total)
            ),
            max_model_calibration_error=Decimal(
                str(settings.trading_drift_max_model_calibration_error)
            ),
            max_model_llm_error_ratio=Decimal(
                str(settings.trading_drift_max_model_llm_error_ratio)
            ),
            min_performance_net_pnl=Decimal(
                str(settings.trading_drift_min_performance_net_pnl)
            ),
            max_performance_drawdown=Decimal(
                str(settings.trading_drift_max_performance_drawdown)
            ),
            max_performance_cost_bps=Decimal(
                str(settings.trading_drift_max_performance_cost_bps)
            ),
            max_execution_fallback_ratio=Decimal(
                str(settings.trading_drift_max_execution_fallback_ratio)
            ),
        )

    def _drift_trigger_policy(self) -> DriftTriggerPolicy:
        return DriftTriggerPolicy(
            retrain_reason_codes=set(
                settings.trading_drift_trigger_retrain_reason_codes
            ),
            reselection_reason_codes=set(
                settings.trading_drift_trigger_reselection_reason_codes
            ),
            retrain_cooldown_seconds=max(
                0, int(settings.trading_drift_retrain_cooldown_seconds)
            ),
            reselection_cooldown_seconds=max(
                0, int(settings.trading_drift_reselection_cooldown_seconds)
            ),
        )

    def _current_drift_gate_evidence(self, *, now: datetime) -> dict[str, Any]:
        refs: list[str] = []
        reasons = list(self.state.drift_live_promotion_reasons)
        eligible = bool(self.state.drift_live_promotion_eligible)
        checked_at_raw: str | None = None
        if self.state.drift_last_detection_path:
            refs.append(self.state.drift_last_detection_path)
        if self.state.drift_last_action_path:
            refs.append(self.state.drift_last_action_path)
        if self.state.drift_last_outcome_path:
            refs.append(self.state.drift_last_outcome_path)
            try:
                payload = json.loads(
                    Path(self.state.drift_last_outcome_path).read_text(encoding="utf-8")
                )
            except Exception:
                payload = {}
            if isinstance(payload, Mapping):
                payload_mapping = cast(Mapping[str, Any], payload)
                checked_at_raw = (
                    str(payload_mapping.get("checked_at") or "").strip() or None
                )
                eligible = bool(
                    payload_mapping.get("eligible_for_live_promotion", eligible)
                )
                raw_reasons = payload_mapping.get("reasons")
                if isinstance(raw_reasons, list):
                    reasons = [
                        str(item)
                        for item in cast(list[Any], raw_reasons)
                        if str(item).strip()
                    ]

        max_age_seconds = max(
            0, settings.trading_drift_live_promotion_max_evidence_age_seconds
        )
        if checked_at_raw:
            parsed_checked_at = _parse_iso_datetime(checked_at_raw)
            if parsed_checked_at is not None and max_age_seconds > 0:
                age_seconds = (now - parsed_checked_at).total_seconds()
                if age_seconds > max_age_seconds:
                    eligible = False
                    reasons.append("drift_evidence_stale")
        else:
            eligible = False
            reasons.append("drift_evidence_missing")

        return {
            "checked_at": checked_at_raw,
            "eligible_for_live_promotion": eligible,
            "reasons": sorted(set(reasons)),
            "reason_codes": list(self.state.drift_active_reason_codes),
            "evidence_artifact_refs": sorted(set(refs)),
        }

    def _evaluate_drift_governance(
        self,
        *,
        run_output_dir: Path,
        run_id: str,
        signals: list[SignalEnvelope],
        gate_report_payload: Mapping[str, Any],
        now: datetime,
    ) -> dict[str, Any]:
        drift_dir = run_output_dir / "drift"
        drift_dir.mkdir(parents=True, exist_ok=True)

        feature_report = evaluate_feature_batch_quality(
            signals,
            thresholds=FeatureQualityThresholds(
                max_required_null_rate=settings.trading_feature_max_required_null_rate,
                max_staleness_ms=settings.trading_feature_max_staleness_ms,
                max_duplicate_ratio=settings.trading_feature_max_duplicate_ratio,
            ),
        )
        fallback_total = sum(self.state.metrics.execution_fallback_total.values())
        submitted_total = max(1, self.state.metrics.orders_submitted_total)
        fallback_ratio = Decimal(str(fallback_total / submitted_total))

        thresholds = self._drift_thresholds()
        detection = detect_drift(
            run_id=run_id,
            feature_quality_report=feature_report,
            gate_report_payload=gate_report_payload,
            fallback_ratio=fallback_ratio,
            thresholds=thresholds,
            detected_at=now,
        )
        self.state.metrics.drift_detection_checks_total += 1
        detection_payload = detection.to_payload()
        detection_payload["governance_enabled"] = (
            settings.trading_drift_governance_enabled
        )
        detection_payload["feature_quality"] = feature_report.to_payload()
        detection_path = drift_dir / "drift-detection.json"
        detection_path.write_text(
            json.dumps(detection_payload, indent=2), encoding="utf-8"
        )
        self.state.drift_last_detection_path = str(detection_path)
        self.state.drift_last_detection_at = detection.detected_at

        if detection.drift_detected:
            self.state.metrics.drift_incidents_total += 1
            self.state.drift_active_incident_id = detection.incident_id
            self.state.drift_active_reason_codes = list(detection.reason_codes)
            for reason_code in detection.reason_codes:
                self.state.metrics.drift_incident_reason_total[reason_code] = (
                    self.state.metrics.drift_incident_reason_total.get(reason_code, 0)
                    + 1
                )
        else:
            self.state.drift_active_incident_id = None
            self.state.drift_active_reason_codes = []

        action = decide_drift_action(
            detection=detection,
            policy=self._drift_trigger_policy(),
            last_action_type=self.state.drift_last_action_type,
            last_action_at=self.state.drift_last_action_at,
            now=now,
        )
        action_payload = action.to_payload()
        action_payload["run_id"] = run_id
        action_payload["incident_id"] = detection.incident_id
        action_payload["governance_enabled"] = settings.trading_drift_governance_enabled
        action_path = drift_dir / "drift-action.json"
        action_path.write_text(json.dumps(action_payload, indent=2), encoding="utf-8")
        self.state.drift_last_action_path = str(action_path)
        self.state.drift_last_action_type = action.action_type
        if action.triggered and action.action_type != "none":
            self.state.drift_last_action_at = now
            self.state.metrics.drift_action_total[action.action_type] = (
                self.state.metrics.drift_action_total.get(action.action_type, 0) + 1
            )
        if action.cooldown_active:
            self.state.metrics.drift_action_cooldown_skip_total += 1

        evidence = evaluate_live_promotion_evidence(
            detection=detection,
            action=action,
            evidence_refs=[str(detection_path), str(action_path)],
            now=now,
        )
        outcome_payload = evidence.to_payload()
        outcome_payload["run_id"] = run_id
        outcome_payload["governance_enabled"] = (
            settings.trading_drift_governance_enabled
        )
        outcome_payload["action"] = action.to_payload()
        outcome_payload["detection"] = detection.to_payload()
        outcome_payload["drift_status"] = (
            "cooldown"
            if action.cooldown_active
            else ("drift_detected" if detection.drift_detected else "stable")
        )
        outcome_path = drift_dir / "drift-outcome.json"
        outcome_path.write_text(json.dumps(outcome_payload, indent=2), encoding="utf-8")
        self.state.drift_last_outcome_path = str(outcome_path)
        self.state.drift_live_promotion_eligible = evidence.eligible_for_live_promotion
        self.state.drift_live_promotion_reasons = list(evidence.reasons)
        self.state.drift_status = str(outcome_payload["drift_status"])
        if not evidence.eligible_for_live_promotion:
            self.state.metrics.drift_promotion_block_total += 1

        rollback_reasons = settings.trading_drift_rollback_reason_codes
        has_rollback_reason = any(
            code in rollback_reasons for code in detection.reason_codes
        )
        if (
            settings.trading_drift_rollback_on_performance
            and detection.drift_detected
            and has_rollback_reason
            and not self.state.emergency_stop_active
        ):
            self.state.metrics.drift_rollback_trigger_total += 1
            self._trigger_emergency_stop(
                reasons=[
                    f"drift_reason_detected:{code}"
                    for code in detection.reason_codes
                    if code in rollback_reasons
                ],
                fallback_ratio=float(fallback_ratio),
                drawdown=self._drawdown_from_gate_payload(gate_report_payload),
            )
        return outcome_payload

    def _drawdown_from_gate_payload(self, payload: Mapping[str, Any]) -> float | None:
        metrics_raw = payload.get("metrics")
        if not isinstance(metrics_raw, Mapping):
            return None
        metrics_payload = cast(Mapping[str, Any], metrics_raw)
        drawdown_raw = metrics_payload.get("max_drawdown")
        if drawdown_raw is None:
            return None
        try:
            return abs(float(drawdown_raw))
        except (TypeError, ValueError):
            return None

    def _evaluate_safety_controls(self) -> None:
        if self._pipeline is None:
            return
        if not settings.trading_emergency_stop_enabled:
            if self.state.emergency_stop_active:
                logger.warning(
                    "Emergency stop disabled; clearing latched state reason=%s",
                    self.state.emergency_stop_reason,
                )
                self._clear_emergency_stop(reason="disabled")
            return

        reasons, fallback_ratio, drawdown = self._collect_emergency_stop_reasons()
        if self.state.emergency_stop_active:
            self._evaluate_emergency_stop_recovery(reasons)
            return
        if reasons:
            self._trigger_emergency_stop(
                reasons=reasons,
                fallback_ratio=fallback_ratio,
                drawdown=drawdown,
            )

    def _collect_emergency_stop_reasons(self) -> tuple[list[str], float, float | None]:
        reasons: list[str] = []
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        lag_seconds = self.state.metrics.signal_lag_seconds
        if (
            isinstance(lag_seconds, int)
            and lag_seconds >= settings.trading_rollback_signal_lag_seconds_limit
        ):
            if market_session_open:
                reasons.append(f"signal_lag_exceeded:{lag_seconds}")
            else:
                logger.info(
                    "Signal lag threshold exceeded outside market session; suppressing emergency stop lag_seconds=%s",
                    lag_seconds,
                )
        critical_reasons = settings.trading_signal_staleness_alert_critical_reasons
        critical_staleness_limit = max(
            1, settings.trading_rollback_signal_staleness_alert_streak_limit
        )
        market_closed_expected_reasons = (
            settings.trading_signal_market_closed_expected_reasons
        )
        for reason in sorted(critical_reasons):
            streak = self.state.metrics.no_signal_reason_streak.get(reason, 0)
            if streak >= critical_staleness_limit:
                if reason == "no_signals_in_window" and _signal_bootstrap_grace_active(
                    self.state,
                    grace_seconds=settings.trading_signal_bootstrap_grace_seconds,
                ):
                    logger.info(
                        "Suppressing emergency-stop staleness streak during bootstrap grace reason=%s streak=%s",
                        reason,
                        streak,
                    )
                    continue
                if (
                    not market_session_open
                ) and reason in market_closed_expected_reasons:
                    logger.info(
                        "Suppressing emergency-stop staleness streak outside market session reason=%s streak=%s",
                        reason,
                        streak,
                    )
                    continue
                if reason in _FRESH_TAIL_NO_SIGNAL_REASONS and _signal_tail_is_fresh(
                    reason,
                    lag_seconds,
                    stale_lag_seconds=settings.trading_signal_stale_lag_alert_seconds,
                ):
                    logger.info(
                        "Suppressing emergency-stop staleness streak while signal tail is fresh reason=%s streak=%s lag_seconds=%s",
                        reason,
                        streak,
                        lag_seconds,
                    )
                    continue
                reasons.append(f"signal_staleness_streak_exceeded:{reason}:{streak}")
        if (
            settings.trading_universe_source == "jangar"
            and self.state.universe_source_status in {"unavailable", "error"}
        ):
            reason = self.state.universe_source_reason or "unknown"
            reasons.append(
                f"universe_source_unavailable:{self.state.universe_source_status}:{reason}"
            )

        if (
            self.state.autonomy_failure_streak
            >= settings.trading_rollback_autonomy_failure_streak_limit
        ):
            reasons.append(
                f"autonomy_failure_streak_exceeded:{self.state.autonomy_failure_streak}"
            )

        fallback_events = sum(self.state.metrics.execution_fallback_total.values())
        submitted_total = max(1, self.state.metrics.orders_submitted_total)
        fallback_ratio = fallback_events / submitted_total
        if fallback_ratio >= settings.trading_rollback_fallback_ratio_limit:
            reasons.append(f"execution_fallback_ratio_exceeded:{fallback_ratio:.3f}")

        drawdown = self._load_latest_drawdown_from_gate()
        if (
            drawdown is not None
            and drawdown >= settings.trading_rollback_max_drawdown_limit
        ):
            reasons.append(f"max_drawdown_exceeded:{drawdown:.4f}")
        return reasons, fallback_ratio, drawdown

    def _evaluate_emergency_stop_recovery(self, current_reasons: list[str]) -> None:
        latched_reasons = _split_emergency_stop_reasons(
            self.state.emergency_stop_reason
        )
        normalized_current_reasons = _coerce_recovery_reason_sequence(current_reasons)
        if not latched_reasons:
            self.state.emergency_stop_recovery_streak = 0
            return

        has_nonrecoverable_latched_reason = any(
            not _is_recoverable_emergency_stop_reason(reason)
            for reason in latched_reasons
        )
        if has_nonrecoverable_latched_reason:
            self.state.emergency_stop_recovery_streak = 0
            return

        nonrecoverable_current_reasons = [
            reason
            for reason in normalized_current_reasons
            if not _is_recoverable_emergency_stop_reason(reason)
        ]
        if nonrecoverable_current_reasons:
            merged_reasons = _merge_emergency_stop_reasons(
                latched_reasons + nonrecoverable_current_reasons
            )
            self.state.emergency_stop_reason = ";".join(merged_reasons)
            self.state.emergency_stop_recovery_streak = 0
            logger.error(
                "Emergency stop remained latched and escalated due to non-recoverable reason(s): %s",
                nonrecoverable_current_reasons,
            )
            return

        recoverable_current_reasons = [
            reason
            for reason in normalized_current_reasons
            if _is_recoverable_emergency_stop_reason(reason)
        ]
        if recoverable_current_reasons:
            self.state.emergency_stop_recovery_streak = 0
            refreshed = ";".join(
                _merge_emergency_stop_reasons(recoverable_current_reasons)
            )
            if refreshed and refreshed != self.state.emergency_stop_reason:
                self.state.emergency_stop_reason = refreshed
            return

        required_recovery_cycles = max(
            1, settings.trading_emergency_stop_recovery_cycles
        )
        self.state.emergency_stop_recovery_streak += 1
        if self.state.emergency_stop_recovery_streak < required_recovery_cycles:
            logger.info(
                "Emergency stop recovery in progress streak=%s required=%s reason=%s",
                self.state.emergency_stop_recovery_streak,
                required_recovery_cycles,
                self.state.emergency_stop_reason,
            )
            return

        logger.warning(
            "Emergency stop auto-cleared after freshness recovered streak=%s reason=%s",
            self.state.emergency_stop_recovery_streak,
            self.state.emergency_stop_reason,
        )
        self._clear_emergency_stop(reason="freshness_recovered")

    def _clear_emergency_stop(self, *, reason: str) -> None:
        if not self.state.emergency_stop_active:
            self.state.emergency_stop_recovery_streak = 0
            self.state.rollback_incident_evidence_path = None
            return
        now = self._governance_now()
        self.state.emergency_stop_active = False
        self.state.emergency_stop_reason = None
        self.state.emergency_stop_triggered_at = None
        self.state.emergency_stop_resolved_at = now
        self.state.emergency_stop_recovery_streak = 0
        self.state.rollback_incident_evidence_path = None
        logger.info(
            "Emergency stop cleared reason=%s resolved_at=%s", reason, now.isoformat()
        )

    def _is_market_session_open(self, now: datetime | None = None) -> bool:
        trading_client: Any | None = None
        if self._pipeline is not None:
            alpaca_client = getattr(self._pipeline, "alpaca_client", None)
            trading_client = getattr(alpaca_client, "trading", None)
        return _is_market_session_open(trading_client, now=now)

    def _load_latest_drawdown_from_gate(self) -> float | None:
        gate_path_raw = self.state.last_autonomy_gates
        if not gate_path_raw:
            return None
        try:
            payload = json.loads(Path(gate_path_raw).read_text(encoding="utf-8"))
        except Exception:
            return None
        metrics = payload.get("metrics")
        if not isinstance(metrics, Mapping):
            return None
        metrics_payload = cast(Mapping[str, Any], metrics)
        max_drawdown = metrics_payload.get("max_drawdown")
        if max_drawdown is None:
            return None
        try:
            return abs(float(max_drawdown))
        except (TypeError, ValueError):
            return None

    def _governance_now(self) -> datetime:
        now_provider = _governance_root_export("trading_now", trading_now)
        return now_provider(
            account_label=getattr(self._pipeline, "account_label", None)
        )

    def _trigger_emergency_stop(
        self,
        *,
        reasons: list[str],
        fallback_ratio: float,
        drawdown: float | None,
    ) -> None:
        if self._pipeline is None:
            return
        now = self._governance_now()
        self.state.emergency_stop_active = True
        self.state.rollback_incidents_total += 1
        self.state.emergency_stop_triggered_at = now
        self.state.emergency_stop_resolved_at = None
        self.state.emergency_stop_recovery_streak = 0
        self.state.emergency_stop_reason = ";".join(
            _merge_emergency_stop_reasons(reasons)
        )
        self.state.metrics.signal_continuity_breach_total += 1
        self.state.last_error = (
            f"emergency_stop_triggered reasons={self.state.emergency_stop_reason}"
        )
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_rejection_reasons(
            ["emergency_stop_triggered"]
        )
        firewall_status = self._pipeline.order_firewall.status()
        try:
            canceled = self._pipeline.order_firewall.cancel_all_orders()
            cancelled_count = len(canceled)
        except Exception:
            logger.exception("Emergency stop failed to cancel open orders")
            cancelled_count = 0

        gate_provenance = self._load_last_gate_provenance()
        artifact_root = _resolve_autonomy_artifact_root(
            Path(settings.trading_autonomy_artifact_dir)
        )
        incident_dir = artifact_root / "rollback-incidents"
        incident_dir.mkdir(parents=True, exist_ok=True)
        incident_path = incident_dir / f"incident-{now.strftime('%Y%m%dT%H%M%S')}.json"
        incident_payload = {
            "triggered_at": now.isoformat(),
            "reasons": reasons,
            "safety_snapshot": {
                "no_signal_reason_streak": dict(
                    self.state.metrics.no_signal_reason_streak
                ),
                "signal_staleness_alert_total": dict(
                    self.state.metrics.signal_staleness_alert_total
                ),
                "execution_fallback_total": dict(
                    self.state.metrics.execution_fallback_total
                ),
            },
            "signal_lag_seconds": self.state.metrics.signal_lag_seconds,
            "autonomy_failure_streak": self.state.autonomy_failure_streak,
            "fallback_ratio": round(fallback_ratio, 6),
            "fallback_total": sum(self.state.metrics.execution_fallback_total.values()),
            "orders_submitted_total": self.state.metrics.orders_submitted_total,
            "max_drawdown": drawdown,
            "last_autonomy_run_id": self.state.last_autonomy_run_id,
            "last_autonomy_gates": self.state.last_autonomy_gates,
            "rollback_hooks": {
                "kill_switch_configured": firewall_status.kill_switch_enabled,
                "kill_switch_reason": firewall_status.reason,
                "emergency_stop_active": True,
                "order_submission_blocked": True,
                "cancel_open_orders_attempted": True,
            },
            "provenance": gate_provenance,
            "cancelled_open_orders": cancelled_count,
        }
        incident_payload["verification"] = {"incident_evidence_complete": False}
        incident_payload["verification"]["incident_evidence_complete"] = (
            _incident_payload_complete(incident_payload)
        )
        incident_path.write_text(
            json.dumps(incident_payload, indent=2), encoding="utf-8"
        )
        self.state.rollback_incident_evidence_path = str(incident_path)
        self._emit_autonomy_domain_telemetry(
            event_name="torghut.autonomy.rollback_triggered",
            severity="critical",
            properties={
                "torghut_run_id": gate_provenance.get("run_id"),
                "candidate_id": self.state.last_autonomy_candidate_id,
                "gate_report_trace_id": gate_provenance.get("gate_report_trace_id"),
                "recommendation_trace_id": gate_provenance.get(
                    "recommendation_trace_id"
                ),
                "rollback_incident_evidence_path": str(incident_path),
                "reason_codes": list(reasons),
                "fallback_ratio": round(fallback_ratio, 6),
                "max_drawdown": drawdown,
                "market_session_open": self.state.market_session_open,
                "emergency_stop_active": True,
            },
        )
        logger.error(
            "Emergency stop triggered reasons=%s canceled_open_orders=%s evidence=%s",
            reasons,
            cancelled_count,
            incident_path,
        )

    def _load_last_gate_provenance(self) -> dict[str, str | None]:
        gate_path_raw = self.state.last_autonomy_gates
        actuation_path_raw = str(
            self.state.last_autonomy_actuation_intent or ""
        ).strip()
        payload: dict[str, Any] = {}
        actuation_payload: dict[str, Any] = {}
        if gate_path_raw:
            try:
                parsed = json.loads(Path(gate_path_raw).read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    payload = cast(dict[str, Any], parsed)
            except Exception:
                payload = {}
        if actuation_path_raw:
            try:
                actuation_raw = json.loads(
                    Path(actuation_path_raw).read_text(encoding="utf-8")
                )
                if isinstance(actuation_raw, dict):
                    actuation_payload = cast(dict[str, Any], actuation_raw)
            except Exception:
                actuation_payload = {}
        actuation_gates_raw = actuation_payload.get("gates")
        actuation_gates = (
            cast(dict[str, Any], actuation_gates_raw)
            if isinstance(actuation_gates_raw, dict)
            else {}
        )
        provenance_raw = payload.get("provenance")
        provenance: dict[str, Any] = (
            cast(dict[str, Any], provenance_raw)
            if isinstance(provenance_raw, dict)
            else {}
        )
        return {
            "run_id": str(payload.get("run_id")).strip() or None,
            "actuation_intent_path": actuation_path_raw or None,
            "gate_report_trace_id": str(provenance.get("gate_report_trace_id")).strip()
            or None,
            "recommendation_trace_id": str(
                provenance.get("recommendation_trace_id")
            ).strip()
            or None,
            "actuation_gate_report_trace_id": str(
                actuation_gates.get("gate_report_trace_id")
            ).strip()
            or None,
            "actuation_recommendation_trace_id": str(
                actuation_gates.get("recommendation_trace_id")
            ).strip()
            or None,
        }

    def _run_evidence_continuity_check(self) -> None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        with self._pipeline.session_factory() as session:
            continuity_check = _governance_root_export(
                "evaluate_evidence_continuity", evaluate_evidence_continuity
            )
            report = continuity_check(
                session,
                run_limit=settings.trading_evidence_continuity_run_limit,
            )
        payload = report.to_payload()
        self.state.last_evidence_continuity_report = payload
        metrics = self.state.metrics
        metrics.evidence_continuity_checks_total += 1
        metrics.evidence_continuity_last_checked_ts_seconds = (
            report.checked_at.timestamp()
        )
        metrics.evidence_continuity_last_failed_runs = report.failed_runs
        if report.failed_runs > 0:
            metrics.evidence_continuity_failures_total += report.failed_runs
            logger.warning(
                "Evidence continuity failures detected failed_runs=%s checked_runs=%s run_ids=%s",
                report.failed_runs,
                report.checked_runs,
                ",".join(report.run_ids),
            )
            return
        metrics.evidence_continuity_last_success_ts_seconds = (
            report.checked_at.timestamp()
        )


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
TradingSchedulerGovernanceLifecycleMethods = _TradingSchedulerGovernanceLifecycleMethods
