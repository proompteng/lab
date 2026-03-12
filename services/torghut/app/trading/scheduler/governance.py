"""Trading scheduler governance, autonomy, and safety workflows."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

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

from ...config import settings
from ..autonomy import (
    DriftThresholds,
    DriftTriggerPolicy,
    decide_drift_action,
    detect_drift,
    evaluate_live_promotion_evidence,
    evaluate_evidence_continuity,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from ..autonomy.phase_manifest_contract import build_phase_manifest_payload_with_runtime_and_rollback, coerce_path_strings
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..ingest import SignalBatch
from ..models import SignalEnvelope
from ..time_source import trading_now
from .pipeline import TradingPipeline
from .safety import (
    _coerce_recovery_reason_sequence,
    _is_market_session_open,
    _is_recoverable_emergency_stop_reason,
    _latch_signal_continuity_alert_state,
    _merge_emergency_stop_reasons,
    _record_signal_continuity_recovery_cycle,
    _split_emergency_stop_reasons,
)
from .state import TradingState

logger = logging.getLogger(__name__)

def _resolve_autonomy_artifact_root(raw_root: Path) -> Path:
    preferred_root = raw_root.expanduser()
    system_temp_root = Path(tempfile.gettempdir())
    fallback_roots = [
        system_temp_root / "torghut" / "autonomy",
        system_temp_root / "torghut",
        system_temp_root,
    ]

    for root in [preferred_root, *fallback_roots]:
        try:
            root.mkdir(parents=True, exist_ok=True)
            test_file = root / ".autonomy-write-check"
            test_file.write_text("ok", encoding="utf-8")
            try:
                test_file.unlink(missing_ok=True)
            except OSError:
                pass
            return root
        except OSError as exc:
            if root == preferred_root:
                logger.warning(
                    "Autonomy artifact root not writable at %s; trying fallback (%s)",
                    preferred_root,
                    exc,
                )
            elif root in fallback_roots:
                logger.warning(
                    "Autonomy artifact fallback root not writable at %s; trying next fallback (%s)",
                    root,
                    exc,
                )
    raise RuntimeError("unable_to_resolve_autonomy_artifact_root")

def _int_from_mapping(payload: Mapping[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return 0
    return 0


def _incident_payload_complete(payload: Mapping[str, Any]) -> bool:
    keys = (
        "triggered_at",
        "reasons",
        "rollback_hooks",
        "safety_snapshot",
        "provenance",
        "verification",
    )
    for key in keys:
        if key not in payload:
            return False
    reasons = payload.get("reasons")
    rollback_hooks = payload.get("rollback_hooks")
    safety_snapshot = payload.get("safety_snapshot")
    if not isinstance(reasons, list) or not reasons:
        return False
    if not isinstance(rollback_hooks, Mapping):
        return False
    if not isinstance(safety_snapshot, Mapping):
        return False
    return True


def _parse_iso_datetime(raw: str) -> datetime | None:
    text = raw.strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


class TradingSchedulerGovernanceMixin:
    state: TradingState
    _pipeline: Optional[TradingPipeline]
    _pipelines: list[TradingPipeline]

    def _emit_autonomy_domain_telemetry(self, *, event_name: str, severity: str, properties: Mapping[str, Any]) -> None:
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
                if (
                    not market_session_open
                ) and reason in market_closed_expected_reasons:
                    logger.info(
                        "Suppressing emergency-stop staleness streak outside market session reason=%s streak=%s",
                        reason,
                        streak,
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
        if settings.trading_simulation_enabled and self._pipeline is not None:
            return trading_now(
                account_label=getattr(self._pipeline, "account_label", None)
            )
        return datetime.now(timezone.utc)

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
            report = evaluate_evidence_continuity(
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

    def _run_autonomous_cycle(
        self,
        *,
        governance_repository: str = "proompteng/lab",
        governance_base: str = "main",
        governance_head: str | None = None,
        governance_artifact_root: str | None = None,
        priority_id: str | None = None,
    ) -> None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")

        strategy_config_path, gate_policy_path = self._resolve_autonomy_config_paths()
        artifact_root = _resolve_autonomy_artifact_root(
            Path(
                governance_artifact_root
                if governance_artifact_root
                else settings.trading_autonomy_artifact_dir
            )
        )
        autonomy_iteration = self._next_autonomy_iteration(artifact_root=artifact_root)
        notes_path = self._iteration_notes_path(
            artifact_root=artifact_root,
            iteration=autonomy_iteration,
        )
        self.state.last_autonomy_iteration = autonomy_iteration
        self.state.last_autonomy_iteration_notes_path = str(notes_path)
        now = self._governance_now()
        lookback_minutes = max(
            1, int(settings.trading_autonomy_signal_lookback_minutes)
        )
        start = now - timedelta(minutes=lookback_minutes)
        autonomy_batch = self._pipeline.ingestor.fetch_signals_with_reason(
            start=start, end=now
        )
        signals = autonomy_batch.signals
        self._record_autonomy_batch_state(
            now=now, batch=autonomy_batch, signals=signals
        )
        if not self._refresh_autonomy_universe_state():
            blocked_batch = SignalBatch(
                signals=[],
                cursor_at=None,
                cursor_seq=None,
                cursor_symbol=None,
                query_start=autonomy_batch.query_start or start,
                query_end=autonomy_batch.query_end or now,
                signal_lag_seconds=autonomy_batch.signal_lag_seconds,
                no_signal_reason="universe_source_unavailable",
            )
            self._record_autonomy_batch_state(
                now=now,
                batch=blocked_batch,
                signals=[],
            )
            self._handle_autonomy_no_signal_cycle(
                batch=blocked_batch,
                now=now,
                start=start,
                artifact_root=artifact_root,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
            )
            self._write_autonomy_iteration_notes(
                notes_path=notes_path,
                iteration=autonomy_iteration,
                now=now,
                outcome="blocked_no_signal",
                reason=blocked_batch.no_signal_reason or "no_signal",
                promotion_target="paper",
                run_output_dir=None,
                gate_manifest_path=self.state.last_autonomy_phase_manifest,
                error=self.state.last_autonomy_error,
            )
            return
        if not signals:
            self._handle_autonomy_no_signal_cycle(
                batch=autonomy_batch,
                now=now,
                start=start,
                artifact_root=artifact_root,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
            )
            self._write_autonomy_iteration_notes(
                notes_path=notes_path,
                iteration=autonomy_iteration,
                now=now,
                outcome="blocked_no_signal",
                reason=autonomy_batch.no_signal_reason or "no_signal",
                promotion_target="paper",
                run_output_dir=None,
                gate_manifest_path=self.state.last_autonomy_phase_manifest,
                error=self.state.last_autonomy_error,
            )
            return

        run_output_dir, signals_path = self._prepare_autonomy_signal_artifacts(
            artifact_root=artifact_root,
            now=now,
            signals=signals,
        )
        self._reset_autonomy_signal_state(signal_count=len(signals))
        drift_gate_evidence = self._current_drift_gate_evidence(now=now)
        promotion_target, approval_token = self._resolve_autonomy_promotion_target(
            drift_gate_evidence
        )
        result = self._execute_autonomous_lane(
            signals_path=signals_path,
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
            run_output_dir=run_output_dir,
            promotion_target=promotion_target,
            approval_token=approval_token,
            drift_gate_evidence=drift_gate_evidence,
            governance_repository=governance_repository,
            governance_base=governance_base,
            governance_head=(
                governance_head
                or f"agentruns/torghut-autonomy-{now.strftime('%Y%m%dT%H%M%S')}"
            ),
            governance_artifact_path=str(run_output_dir),
            priority_id=priority_id,
            design_doc=os.getenv("DESIGN_DOC"),
            artifact_root=artifact_root,
            execution_context=self._build_autonomy_execution_context(
                artifact_root=artifact_root,
                promotion_target=promotion_target,
                design_doc=os.getenv("DESIGN_DOC"),
            ),
        )
        if result is None:
            self._write_autonomy_iteration_notes(
                notes_path=notes_path,
                iteration=autonomy_iteration,
                now=now,
                outcome="lane_execution_failed",
                reason=self.state.last_autonomy_reason or "lane_execution_failed",
                promotion_target=promotion_target,
                run_output_dir=None,
                gate_manifest_path=self.state.last_autonomy_phase_manifest,
                error=self.state.last_autonomy_error,
            )
            return

        self._apply_autonomy_lane_result(
            result=result,
            run_output_dir=run_output_dir,
            signals=signals,
            now=now,
            requested_promotion_target=promotion_target,
        )
        self._write_autonomy_iteration_notes(
            notes_path=notes_path,
            iteration=autonomy_iteration,
            now=now,
            outcome="lane_completed",
            reason="completed",
            promotion_target=promotion_target,
            run_output_dir=run_output_dir,
            gate_manifest_path=self.state.last_autonomy_phase_manifest,
            error=self.state.last_autonomy_error,
            emergency_stop_active=self.state.emergency_stop_active,
            rollback_incident_path=self.state.rollback_incident_evidence_path,
        )

    @staticmethod
    def _resolve_autonomy_config_paths() -> tuple[Path, Path]:
        strategy_config_path = settings.trading_strategy_config_path
        gate_policy_path = settings.trading_autonomy_gate_policy_path
        if not strategy_config_path:
            raise RuntimeError("strategy_config_path_missing_for_autonomy")
        if not gate_policy_path:
            raise RuntimeError("autonomy_gate_policy_path_missing")
        return Path(strategy_config_path), Path(gate_policy_path)

    @staticmethod
    def _build_autonomy_execution_context(
        *,
        artifact_root: Path,
        promotion_target: str,
        design_doc: str | None = None,
    ) -> dict[str, str]:
        repository = (os.getenv("GITHUB_REPOSITORY") or "unknown").strip() or "unknown"
        base_ref = os.getenv("GITHUB_BASE_REF") or os.getenv("GITHUB_REF") or "unknown"
        if base_ref.startswith("refs/heads/"):
            base_ref = base_ref.removeprefix("refs/heads/")
        head_ref = (
            os.getenv("GITHUB_HEAD_REF")
            or os.getenv("GITHUB_REF_NAME")
            or ("live" if promotion_target == "live" else "unknown")
        )
        priority_id = os.getenv("PRIORITY_ID") or os.getenv("CODEX_PRIORITY_ID") or ""
        design_ref = (
            design_doc if design_doc is not None else os.getenv("DESIGN_DOC", "")
        )
        return {
            "repository": repository,
            "base": base_ref,
            "head": head_ref,
            "artifactPath": str(artifact_root),
            "priorityId": priority_id,
            "designDoc": design_ref.strip(),
        }

    def _record_autonomy_batch_state(
        self,
        *,
        now: datetime,
        batch: SignalBatch,
        signals: list[SignalEnvelope],
    ) -> None:
        self.state.last_ingest_signals_total = len(signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason
        self.state.last_autonomy_run_at = now
        self.state.autonomy_signals_total = len(signals)

    def _refresh_autonomy_universe_state(self) -> bool:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        resolution = self._pipeline.universe_resolver.get_resolution()
        self.state.universe_source_status = resolution.status
        self.state.universe_source_reason = resolution.reason
        self.state.universe_symbols_count = len(resolution.symbols)
        self.state.universe_cache_age_seconds = resolution.cache_age_seconds
        self.state.universe_fail_safe_blocked = False
        self.state.universe_fail_safe_block_reason = None
        self.state.metrics.record_universe_resolution(
            status=resolution.status,
            reason=resolution.reason,
            symbols_count=len(resolution.symbols),
            cache_age_seconds=resolution.cache_age_seconds,
        )
        if resolution.status == "degraded":
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_stale_cache"
            )
        if (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
            and not resolution.symbols
        ):
            universe_reason = resolution.reason or "unknown"
            self.state.universe_fail_safe_blocked = True
            self.state.universe_fail_safe_block_reason = universe_reason
            self.state.last_signal_continuity_state = "universe_fail_safe_block"
            self.state.last_signal_continuity_reason = "universe_source_unavailable"
            self.state.last_signal_continuity_actionable = True
            self.state.metrics.signal_continuity_actionable = 1
            self.state.metrics.record_signal_actionable_staleness(
                "universe_source_unavailable"
            )
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_unavailable"
            )
            self.state.metrics.record_universe_fail_safe_block(universe_reason)
            _latch_signal_continuity_alert_state(
                self.state, "universe_source_unavailable"
            )
            self.state.last_error = (
                f"universe_source_unavailable reason={resolution.reason}"
            )
            logger.error(
                "Blocking autonomy cycle: authoritative Jangar universe unavailable reason=%s status=%s",
                resolution.reason,
                resolution.status,
            )
            return False
        return True

    def _handle_autonomy_no_signal_cycle(
        self,
        *,
        batch: SignalBatch,
        now: datetime,
        start: datetime,
        artifact_root: Path,
        strategy_config_path: Path,
        gate_policy_path: Path,
    ) -> None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        self._pipeline.record_no_signal_batch(batch)
        self.state.autonomy_no_signal_streak += 1
        self.state.metrics.no_signal_streak = self.state.autonomy_no_signal_streak
        run_output_dir = artifact_root / now.strftime("%Y%m%dT%H%M%S")
        run_output_dir.mkdir(parents=True, exist_ok=True)
        no_signal_path = run_output_dir / "no-signals.json"
        reason = batch.no_signal_reason or "no_signal"
        no_signal_payload: dict[str, Any] = {
            "status": "skipped",
            "dataset_snapshot_ref": "no_signal_window",
            "no_signal_reason": reason,
            "query_start": batch.query_start.isoformat() if batch.query_start else None,
            "query_end": batch.query_end.isoformat() if batch.query_end else None,
            "signal_lag_seconds": batch.signal_lag_seconds,
            "signal_continuity": {
                "state": self.state.last_signal_continuity_state,
                "reason": self.state.last_signal_continuity_reason,
                "actionable": self.state.last_signal_continuity_actionable,
                "alert_active": self.state.signal_continuity_alert_active,
                "alert_reason": self.state.signal_continuity_alert_reason,
            },
            "market_session_open": self.state.market_session_open,
            "promotion": {
                "requested_target": "shadow",
                "promotion_allowed": False,
                "outcome": "skipped_no_signal",
            },
            "research_run_id": None,
        }
        no_signal_path.write_text(
            json.dumps(no_signal_payload, indent=2), encoding="utf-8"
        )
        self.state.last_autonomy_run_id = None
        self.state.last_autonomy_candidate_id = None
        self.state.last_autonomy_gates = str(no_signal_path)
        self.state.last_autonomy_actuation_intent = None
        self.state.last_autonomy_phase_manifest = None
        self.state.last_autonomy_patch = None
        self.state.last_autonomy_recommendation = None
        self.state.last_autonomy_promotion_action = "hold"
        self.state.last_autonomy_promotion_eligible = False
        self.state.last_autonomy_recommendation_trace_id = None
        self.state.last_autonomy_throughput = {
            "signal_count": 0,
            "decision_count": 0,
            "trade_count": 0,
            "fold_metrics_count": 0,
            "stress_metrics_count": 0,
            "no_signal_window": True,
            "no_signal_reason": reason,
        }
        self.state.metrics.autonomy_last_signal_count = 0
        self.state.metrics.autonomy_last_decision_count = 0
        self.state.metrics.autonomy_last_trade_count = 0
        self.state.metrics.autonomy_last_fold_metrics_count = 0
        self.state.metrics.autonomy_last_stress_metrics_count = 0
        self.state.last_autonomy_error = None
        self.state.last_autonomy_reason = reason
        self.state.metrics.record_autonomy_promotion_outcome(
            signal_count=0,
            decision_count=0,
            trade_count=0,
            recommendation="shadow",
            promotion_allowed=False,
            outcome="skipped_no_signal",
        )
        query_start = batch.query_start or start
        query_end = batch.query_end or now
        try:
            self.state.last_autonomy_run_id = upsert_autonomy_no_signal_run(
                session_factory=self._pipeline.session_factory,
                query_start=query_start,
                query_end=query_end,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                no_signal_reason=reason,
                now=now,
                code_version="live",
            )
            no_signal_payload["research_run_id"] = self.state.last_autonomy_run_id
            no_signal_path.write_text(
                json.dumps(no_signal_payload, indent=2), encoding="utf-8"
            )
        except Exception as exc:
            self.state.autonomy_failure_streak += 1
            self.state.last_autonomy_reason = "autonomy_no_signal_persistence_failed"
            self.state.last_autonomy_error = str(exc)
            logger.exception(
                "Autonomy no-signal persistence failed; ingest_reason=%s window_start=%s window_end=%s",
                reason,
                query_start,
                query_end,
            )
            return
        logger.warning(
            "Autonomy cycle skipped due to no signals; ingest_reason=%s window_start=%s window_end=%s",
            batch.no_signal_reason,
            batch.query_start,
            batch.query_end,
        )
        self._emit_autonomy_domain_telemetry(
            event_name="torghut.autonomy.cycle_failed",
            severity="warning",
            properties={
                "torghut_run_id": self.state.last_autonomy_run_id,
                "candidate_id": self.state.last_autonomy_candidate_id,
                "recommendation_trace_id": self.state.last_autonomy_recommendation_trace_id,
                "no_signal_reason": reason,
                "outcome": "skipped_no_signal",
                "signal_lag_seconds": batch.signal_lag_seconds,
                "market_session_open": self.state.market_session_open,
            },
        )
        self._evaluate_safety_controls()

    @staticmethod
    def _prepare_autonomy_signal_artifacts(
        *,
        artifact_root: Path,
        now: datetime,
        signals: list[SignalEnvelope],
    ) -> tuple[Path, Path]:
        run_output_dir = artifact_root / now.strftime("%Y%m%dT%H%M%S")
        run_output_dir.mkdir(parents=True, exist_ok=True)
        signals_path = run_output_dir / "signals.json"
        signal_payloads = [signal.model_dump(mode="json") for signal in signals]
        signals_path.write_text(json.dumps(signal_payloads, indent=2), encoding="utf-8")
        return run_output_dir, signals_path

    def _next_autonomy_iteration(self, *, artifact_root: Path) -> int:
        notes_root = artifact_root / "notes"
        notes_root.mkdir(parents=True, exist_ok=True)
        max_iteration = 0
        for path in notes_root.glob("iteration-*.md"):
            suffix = path.stem.removeprefix("iteration-")
            if suffix.isdigit():
                max_iteration = max(max_iteration, int(suffix))
        return max_iteration + 1

    def _iteration_notes_path(self, *, artifact_root: Path, iteration: int) -> Path:
        return artifact_root / "notes" / f"iteration-{iteration}.md"

    def _write_autonomy_iteration_notes(
        self,
        *,
        notes_path: Path,
        iteration: int,
        now: datetime,
        outcome: str,
        reason: str,
        promotion_target: str,
        run_output_dir: Path | None,
        gate_manifest_path: str | None,
        error: str | None = None,
        emergency_stop_active: bool = False,
        rollback_incident_path: str | None = None,
    ) -> None:
        notes_payload = {
            "iteration": iteration,
            "status": outcome,
            "timestamp": now.isoformat(),
            "reason": reason,
            "promotion_target": promotion_target,
            "run_output_dir": str(run_output_dir) if run_output_dir else None,
            "phase_manifest_path": gate_manifest_path,
            "autonomy_run_id": self.state.last_autonomy_run_id,
            "autonomy_candidate_id": self.state.last_autonomy_candidate_id,
            "recommender": self.state.last_autonomy_recommendation,
            "promotion_action": self.state.last_autonomy_promotion_action,
            "promotion_eligible": self.state.last_autonomy_promotion_eligible,
            "recommendation_trace_id": self.state.last_autonomy_recommendation_trace_id,
            "error": error,
            "emergency_stop_active": emergency_stop_active,
            "rollback_incident_evidence_path": rollback_incident_path,
            "throughput": self.state.last_autonomy_throughput,
            "metrics": {
                "drift_status": self.state.drift_status,
                "security_controls_triggered": self.state.last_autonomy_reason,
            },
        }
        notes_path.parent.mkdir(parents=True, exist_ok=True)
        notes_path.write_text(json.dumps(notes_payload, indent=2), encoding="utf-8")

    def _reset_autonomy_signal_state(self, *, signal_count: int) -> None:
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        self.state.autonomy_no_signal_streak = 0
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.last_signal_continuity_state = "signals_present"
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = False
        _record_signal_continuity_recovery_cycle(
            self.state,
            required_recovery_cycles=max(
                1, int(settings.trading_signal_continuity_recovery_cycles)
            ),
        )
        self.state.autonomy_signals_total = signal_count

    def _resolve_autonomy_promotion_target(
        self, drift_gate_evidence: Mapping[str, Any]
    ) -> tuple[Literal["paper", "live"], str | None]:
        if (
            settings.trading_autonomy_allow_live_promotion
            and self.state.signal_continuity_alert_active
        ):
            self.state.metrics.signal_continuity_promotion_block_total += 1
            logger.warning(
                "Autonomy live promotion denied while continuity alert is active reason=%s; forcing paper target.",
                self.state.signal_continuity_alert_reason,
            )
            return "paper", None
        if (
            settings.trading_autonomy_allow_live_promotion
            and settings.trading_autonomy_approval_token
        ):
            if settings.trading_drift_live_promotion_requires_evidence and not bool(
                drift_gate_evidence.get("eligible_for_live_promotion", False)
            ):
                logger.warning(
                    "Autonomy live promotion denied by drift evidence gate reasons=%s; fallback to paper target.",
                    drift_gate_evidence.get("reasons"),
                )
                self.state.metrics.drift_promotion_block_total += 1
                return "paper", None
            return "live", settings.trading_autonomy_approval_token
        if (
            settings.trading_autonomy_allow_live_promotion
            and not settings.trading_autonomy_approval_token
        ):
            logger.warning(
                "Autonomy live promotion enabled but no approval token configured; fallback to paper target."
            )
        return "paper", None

    def _execute_autonomous_lane(
        self,
        *,
        signals_path: Path,
        strategy_config_path: Path,
        gate_policy_path: Path,
        run_output_dir: Path,
        promotion_target: Literal["paper", "live"],
        approval_token: str | None,
        drift_gate_evidence: Mapping[str, Any],
        governance_repository: str = "proompteng/lab",
        governance_base: str = "main",
        governance_head: str | None = None,
        governance_artifact_path: str | None = None,
        priority_id: str | None = None,
        design_doc: str | None = None,
        artifact_root: Path | None = None,
        execution_context: Mapping[str, str] | None = None,
    ) -> Any | None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        try:
            return run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=run_output_dir,
                promotion_target=promotion_target,
                strategy_configmap_path=Path("/etc/torghut/strategies.yaml"),
                code_version="live",
                approval_token=approval_token,
                drift_promotion_evidence=dict(drift_gate_evidence),
                governance_repository=governance_repository,
                governance_base=governance_base,
                governance_head=(
                    governance_head
                    or f"agentruns/torghut-autonomy-{run_output_dir.name}"
                ),
                governance_artifact_path=(
                    governance_artifact_path or str(run_output_dir)
                ).strip()
                or str(run_output_dir),
                priority_id=priority_id,
                design_doc=design_doc,
                governance_change="autonomous-promotion",
                governance_reason=(
                    f"Autonomous recommendation for {promotion_target} target."
                ),
                governance_inputs=(
                    {
                        "execution_context": dict(
                            execution_context
                            or self._build_autonomy_execution_context(
                                artifact_root=(artifact_root or run_output_dir.parent),
                                promotion_target=promotion_target,
                            )
                        ),
                        "runtime_governance": {
                            "governance_status": "pass",
                            "drift_status": "queued",
                            "artifact_refs": [],
                            "rollback_triggered": False,
                            "reasons": [
                                "autonomy_runtime_governance_pending",
                            ],
                        },
                        "rollback_proof": {
                            "rollback_triggered": False,
                            "rollback_incident_evidence_path": "",
                            "reasons": [],
                        },
                    }
                    if execution_context is not None
                    else None
                ),
                persist_results=True,
                session_factory=self._pipeline.session_factory,
            )
        except Exception as exc:
            self.state.autonomy_failure_streak += 1
            self.state.last_autonomy_phase_manifest = None
            self.state.last_autonomy_error = str(exc)
            self.state.last_autonomy_reason = "lane_execution_failed"
            self._clear_autonomy_result_state()
            self._emit_autonomy_domain_telemetry(
                event_name="torghut.autonomy.cycle_failed",
                severity="error",
                properties={
                    "torghut_run_id": None,
                    "candidate_id": None,
                    "recommendation_trace_id": None,
                    "outcome": "lane_execution_failed",
                    "error": str(exc),
                    "promotion_target": promotion_target,
                },
            )
            logger.exception("Autonomous lane execution failed: %s", exc)
            self._evaluate_safety_controls()
            return None

    def _clear_autonomy_result_state(self) -> None:
        self.state.last_autonomy_run_id = None
        self.state.last_autonomy_candidate_id = None
        self.state.last_autonomy_gates = None
        self.state.last_autonomy_actuation_intent = None
        self.state.last_autonomy_phase_manifest = None
        self.state.last_autonomy_patch = None
        self.state.last_autonomy_recommendation = None
        self.state.last_autonomy_promotion_action = None
        self.state.last_autonomy_promotion_eligible = None
        self.state.last_autonomy_recommendation_trace_id = None
        self.state.last_autonomy_throughput = None

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


__all__ = ["TradingSchedulerGovernanceMixin", "_resolve_autonomy_artifact_root"]
