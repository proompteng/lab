"""Background scheduler for the trading pipeline."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional, cast
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..config import TradingAccountLane, settings
from ..db import SessionLocal
from ..models import LLMDecisionReview, Strategy, TradeDecision, coerce_json_payload
from ..snapshots import snapshot_account_and_positions
from ..strategies import StrategyCatalog
from .decisions import DecisionEngine, DecisionRuntimeTelemetry
from .execution import OrderExecutor
from .execution_adapters import (
    ExecutionAdapter,
    adapter_enabled_for_symbol,
    build_execution_adapter,
)
from .execution_policy import ExecutionPolicy
from .feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from .firewall import OrderFirewall, OrderFirewallBlocked
from .ingest import ClickHouseSignalIngestor, SignalBatch
from .llm import LLMReviewEngine, apply_policy
from .llm.dspy_programs.runtime import DSPyRuntimeUnsupportedStateError
from .llm.guardrails import evaluate_llm_guardrails
from .lean_lanes import LeanLaneManager
from .market_context import (
    MarketContextClient,
    MarketContextStatus,
    evaluate_market_context,
)
from .models import SignalEnvelope, StrategyDecision
from .portfolio import (
    AllocationResult,
    PortfolioSizingResult,
    allocator_from_settings,
    sizer_from_settings,
)
from .prices import ClickHousePriceFetcher, MarketSnapshot, PriceFetcher
from .order_feed import OrderFeedIngestor
from .reconcile import Reconciler
from .risk import RiskEngine
from .tca import AdaptiveExecutionPolicyDecision, derive_adaptive_execution_policy
from .regime_hmm import (
    resolve_regime_context_authority_reason,
    resolve_hmm_context,
    resolve_legacy_regime_label,
    resolve_regime_route_label,
)
from .autonomy import (
    DriftThresholds,
    DriftTriggerPolicy,
    decide_drift_action,
    detect_drift,
    evaluate_live_promotion_evidence,
    evaluate_evidence_continuity,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from .universe import UniverseResolver
from .llm.schema import MarketSnapshot as LLMMarketSnapshot
from .llm.schema import MarketContextBundle
from .llm.schema import PortfolioSnapshot, RecentDecisionSummary
from .autonomy.phase_manifest_contract import (
    AUTONOMY_PHASE_ORDER,
    coerce_phase_status,
    normalize_phase_transitions,
)
from .route_metadata import coerce_route_text

logger = logging.getLogger(__name__)
_AUTONOMY_PHASE_ORDER: tuple[str, ...] = AUTONOMY_PHASE_ORDER

_RECOVERABLE_EMERGENCY_STOP_PREFIXES: tuple[str, ...] = (
    "signal_lag_exceeded:",
    "signal_staleness_streak_exceeded:",
)
_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER = Decimal("0.50")
_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE = Decimal("0.05")
_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS = 120
_RUNTIME_UNCERTAINTY_GATE_MAX_STALENESS_SECONDS = 15 * 60
RuntimeUncertaintyGateAction = Literal["pass", "degrade", "abstain", "fail"]


@dataclass(frozen=True)
class RuntimeUncertaintyGate:
    action: RuntimeUncertaintyGateAction
    source: str
    coverage_error: Decimal | None = None
    shift_score: Decimal | None = None
    conformal_interval_width: Decimal | None = None
    regime_action_source: str | None = None
    regime_label: str | None = None
    regime_stale: bool | None = None
    reason: str | None = None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "action": self.action,
            "source": self.source,
        }
        if self.coverage_error is not None:
            payload["coverage_error"] = str(self.coverage_error)
        if self.shift_score is not None:
            payload["shift_score"] = str(self.shift_score)
        if self.conformal_interval_width is not None:
            payload["conformal_interval_width"] = str(self.conformal_interval_width)
        if self.regime_action_source is not None:
            payload["regime_action_source"] = self.regime_action_source
        if self.regime_label is not None:
            payload["regime_label"] = self.regime_label
        if self.regime_stale is not None:
            payload["regime_stale"] = self.regime_stale
        if self.reason is not None:
            payload["reason"] = self.reason
        return payload


def _runtime_uncertainty_gate_rank(action: RuntimeUncertaintyGateAction) -> int:
    ranking: dict[RuntimeUncertaintyGateAction, int] = {
        "pass": 0,
        "degrade": 1,
        "abstain": 2,
        "fail": 3,
    }
    return ranking[action]


def _select_strictest_runtime_uncertainty_gate(
    candidates: list[RuntimeUncertaintyGate],
) -> RuntimeUncertaintyGate:
    selected = candidates[0]
    for candidate in candidates[1:]:
        if _runtime_uncertainty_gate_rank(
            candidate.action
        ) > _runtime_uncertainty_gate_rank(selected.action):
            selected = candidate
    return selected


def _clone_positions(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(position) for position in positions]


def _split_emergency_stop_reasons(raw: str | None) -> list[str]:
    if not raw:
        return []
    parts = [part.strip() for part in raw.split(";")]
    return [part for part in parts if part]


def _is_recoverable_emergency_stop_reason(reason: str) -> bool:
    return reason.startswith(_RECOVERABLE_EMERGENCY_STOP_PREFIXES)


def _normalize_reason_metric(reason: str | None) -> str:
    normalized = reason.strip() if isinstance(reason, str) else ""
    return normalized or "unknown"


def _is_market_session_open(
    trading_client: Any | None,
    *,
    now: datetime | None = None,
) -> bool:
    get_clock = cast(
        Callable[[], Any] | None, getattr(trading_client, "get_clock", None)
    )
    if callable(get_clock):
        try:
            clock = get_clock()
            is_open = getattr(clock, "is_open", None)
            if isinstance(is_open, bool):
                return is_open
            if is_open is not None:
                return bool(is_open)
        except Exception:
            logger.exception("Failed to resolve Alpaca market clock state")

    current = (now or datetime.now(timezone.utc)).astimezone(
        ZoneInfo("America/New_York")
    )
    if current.weekday() >= 5:
        return False
    session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
    session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
    return session_open <= current < session_close


def _latch_signal_continuity_alert_state(state: Any, reason: str) -> None:
    now = datetime.now(timezone.utc)
    if not state.signal_continuity_alert_active:
        state.signal_continuity_alert_started_at = now
    state.signal_continuity_alert_active = True
    state.signal_continuity_alert_reason = reason
    state.signal_continuity_alert_last_seen_at = now
    state.signal_continuity_recovery_streak = 0
    state.metrics.record_signal_continuity_alert_state(
        active=True,
        recovery_streak=0,
    )


def _record_signal_continuity_recovery_cycle(
    state: Any, *, required_recovery_cycles: int
) -> None:
    if not state.signal_continuity_alert_active:
        state.metrics.record_signal_continuity_alert_state(
            active=False,
            recovery_streak=0,
        )
        return

    state.signal_continuity_recovery_streak += 1
    state.metrics.record_signal_continuity_alert_state(
        active=True,
        recovery_streak=state.signal_continuity_recovery_streak,
    )
    if state.signal_continuity_recovery_streak < required_recovery_cycles:
        return

    logger.info(
        "Signal continuity alert cleared after healthy cycles=%s reason=%s",
        state.signal_continuity_recovery_streak,
        state.signal_continuity_alert_reason,
    )
    state.signal_continuity_alert_active = False
    state.signal_continuity_alert_reason = None
    state.signal_continuity_alert_started_at = None
    state.signal_continuity_alert_last_seen_at = None
    state.signal_continuity_recovery_streak = 0
    state.metrics.record_signal_continuity_alert_state(
        active=False,
        recovery_streak=0,
    )


def _extract_json_error_payload(error: Exception) -> Optional[dict[str, Any]]:
    raw = str(error).strip()
    if not raw.startswith("{"):
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return cast(dict[str, Any], parsed)
    return None


def _format_order_submit_rejection(error: Exception) -> str:
    payload = _extract_json_error_payload(error)
    if payload:
        source = str(payload.get("source") or "").strip().lower()
        code = payload.get("code")
        reject_reason = payload.get("reject_reason")
        existing_order_id = payload.get("existing_order_id")
        if source == "broker_precheck":
            parts: list[str] = ["broker_precheck_rejected"]
        elif source == "local_pre_submit":
            parts = ["local_pre_submit_rejected"]
        else:
            parts = ["alpaca_order_rejected"]
        if code is not None:
            parts.append(f"code={code}")
        if reject_reason:
            parts.append(f"reason={reject_reason}")
        if existing_order_id:
            parts.append(f"existing_order_id={existing_order_id}")
        return " ".join(parts)
    return f"alpaca_order_submit_failed {type(error).__name__}: {error}"


@dataclass
class TradingMetrics:
    decisions_total: int = 0
    orders_submitted_total: int = 0
    orders_rejected_total: int = 0
    planned_decisions_with_execution_total: int = 0
    planned_decisions_stale_total: int = 0
    planned_decisions_timeout_rejected_total: int = 0
    reconcile_updates_total: int = 0
    llm_requests_total: int = 0
    llm_approve_total: int = 0
    llm_veto_total: int = 0
    llm_adjust_total: int = 0
    llm_abstain_total: int = 0
    llm_escalate_total: int = 0
    llm_error_total: int = 0
    llm_parse_error_total: int = 0
    llm_validation_error_total: int = 0
    llm_circuit_open_total: int = 0
    llm_fail_mode_override_total: int = 0
    llm_fail_mode_exception_total: int = 0
    llm_stage_policy_violation_total: int = 0
    llm_policy_resolution_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    llm_shadow_total: int = 0
    llm_guardrail_block_total: int = 0
    llm_guardrail_shadow_total: int = 0
    llm_policy_fallback_total: int = 0
    llm_market_context_block_total: int = 0
    llm_market_context_error_total: int = 0
    llm_market_context_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    llm_market_context_shadow_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    llm_tokens_prompt_total: int = 0
    llm_tokens_completion_total: int = 0
    llm_committee_requests_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    llm_committee_latency_ms: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    llm_committee_verdict_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    llm_committee_schema_error_total: int = 0
    llm_committee_veto_alignment_total: int = 0
    llm_committee_veto_total: int = 0
    execution_requests_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    execution_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    execution_fallback_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    execution_advisor_usage_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    execution_advisor_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    lean_request_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    lean_failure_taxonomy_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    lean_latency_ms: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )
    lean_shadow_parity_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    lean_shadow_failure_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    lean_strategy_shadow_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    lean_canary_breach_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    no_signal_windows_total: int = 0
    no_signal_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    no_signal_reason_streak: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    no_signal_streak: int = 0
    market_session_open: int = 0
    signal_continuity_actionable: int = 0
    signal_continuity_alert_active: int = 0
    signal_continuity_alert_recovery_streak: int = 0
    signal_continuity_promotion_block_total: int = 0
    signal_lag_seconds: int | None = None
    signal_staleness_alert_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    signal_expected_staleness_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    signal_actionable_staleness_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    universe_fail_safe_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    universe_resolution_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    universe_symbols_count: int = 0
    universe_cache_age_seconds: int = 0
    signal_continuity_breach_total: int = 0
    order_feed_messages_total: int = 0
    order_feed_events_persisted_total: int = 0
    order_feed_duplicates_total: int = 0
    order_feed_out_of_order_total: int = 0
    order_feed_missing_fields_total: int = 0
    order_feed_apply_updates_total: int = 0
    order_feed_consumer_errors_total: int = 0
    strategy_events_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    strategy_intents_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    strategy_errors_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    strategy_latency_ms: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    intent_conflict_total: int = 0
    strategy_runtime_isolated_failures_total: int = 0
    strategy_runtime_fallback_total: int = 0
    strategy_runtime_legacy_path_total: int = 0
    forecast_router_inference_latency_ms: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    forecast_router_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    forecast_calibration_error: dict[str, str] = field(
        default_factory=lambda: cast(dict[str, str], {})
    )
    forecast_route_selection_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    feature_batch_rows_total: int = 0
    feature_null_rate: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )
    feature_staleness_ms_p95: int = 0
    feature_duplicate_ratio: float = 0
    feature_schema_mismatch_total: int = 0
    feature_quality_rejections_total: int = 0
    feature_parity_drift_total: int = 0
    drift_detection_checks_total: int = 0
    drift_incidents_total: int = 0
    drift_incident_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    drift_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    drift_action_cooldown_skip_total: int = 0
    drift_promotion_block_total: int = 0
    drift_rollback_trigger_total: int = 0
    evidence_continuity_checks_total: int = 0
    evidence_continuity_failures_total: int = 0
    evidence_continuity_last_checked_ts_seconds: float = 0
    evidence_continuity_last_success_ts_seconds: float = 0
    evidence_continuity_last_failed_runs: int = 0
    autonomy_promotions_total: int = 0
    autonomy_denials_total: int = 0
    autonomy_demotions_total: int = 0
    autonomy_promotion_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    autonomy_last_signal_count: int = 0
    autonomy_last_decision_count: int = 0
    autonomy_last_trade_count: int = 0
    autonomy_last_fold_metrics_count: int = 0
    autonomy_last_stress_metrics_count: int = 0
    allocator_requests_total: int = 0
    allocator_approved_total: int = 0
    allocator_rejected_total: int = 0
    allocator_clipped_total: int = 0
    allocator_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    allocator_regime_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    decision_regime_resolution_source_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    decision_regime_resolution_fallback_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    allocator_fragility_state_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    allocator_multiplier_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    fragility_score: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )
    stability_mode_active_total: int = 0
    adaptive_policy_decisions_total: int = 0
    adaptive_policy_applied_total: int = 0
    adaptive_policy_fallback_total: int = 0
    adaptive_policy_key_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    adaptive_policy_effect_size_bps: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )
    adaptive_policy_degradation_bps: dict[str, float] = field(
        default_factory=lambda: cast(dict[str, float], {})
    )
    autonomy_signal_throughput_total: int = 0
    autonomy_decision_throughput_total: int = 0
    autonomy_trade_throughput_total: int = 0
    autonomy_promotion_allowed_total: int = 0
    autonomy_promotion_blocked_total: int = 0
    autonomy_recommendation_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    autonomy_outcome_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    calibration_coverage_error: float = 0
    conformal_interval_width: float = 0
    regime_shift_score: float = 0
    uncertainty_gate_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    runtime_uncertainty_gate_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    runtime_uncertainty_gate_blocked_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    runtime_regime_gate_action_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    runtime_regime_gate_blocked_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    recalibration_runs_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )

    def record_execution_request(self, adapter: str | None) -> None:
        adapter_name = coerce_route_text(adapter)
        if adapter_name is None:
            return
        current = self.execution_requests_total.get(adapter_name, 0)
        self.execution_requests_total[adapter_name] = current + 1

    def record_execution_fallback(
        self,
        expected_adapter: str | None,
        actual_adapter: str | None,
        fallback_reason: str | None,
    ) -> None:
        expected_name = coerce_route_text(expected_adapter) or "unknown"
        actual_name = coerce_route_text(actual_adapter) or "unknown"
        transition = f"{expected_name}->{actual_name}"
        current = self.execution_fallback_total.get(transition, 0)
        self.execution_fallback_total[transition] = current + 1
        if fallback_reason:
            current_reason = self.execution_fallback_reason_total.get(
                fallback_reason, 0
            )
            self.execution_fallback_reason_total[fallback_reason] = current_reason + 1

    def record_execution_advisor_result(
        self,
        metadata: Mapping[str, Any] | None,
    ) -> None:
        if not isinstance(metadata, Mapping):
            return
        enabled = bool(metadata.get("enabled", False))
        applied = bool(metadata.get("applied", False))
        fallback_reason_raw = metadata.get("fallback_reason")
        fallback_reason = (
            str(fallback_reason_raw).strip()
            if isinstance(fallback_reason_raw, str)
            else ""
        )
        if applied:
            usage_status = "applied"
        elif fallback_reason == "advisor_live_apply_disabled":
            usage_status = "advisory_only"
        elif not enabled:
            usage_status = "disabled"
        elif fallback_reason:
            usage_status = "fallback"
        else:
            usage_status = "not_applied"
        self.execution_advisor_usage_total[usage_status] = (
            self.execution_advisor_usage_total.get(usage_status, 0) + 1
        )
        if fallback_reason:
            self.execution_advisor_fallback_total[fallback_reason] = (
                self.execution_advisor_fallback_total.get(fallback_reason, 0) + 1
            )

    def record_no_signal(self, reason: str | None) -> None:
        normalized = _normalize_reason_metric(reason)
        self.no_signal_windows_total += 1
        current = self.no_signal_reason_total.get(normalized, 0)
        self.no_signal_reason_total[normalized] = current + 1
        for existing_reason in list(self.no_signal_reason_streak):
            if existing_reason != normalized:
                del self.no_signal_reason_streak[existing_reason]
        self.no_signal_reason_streak[normalized] = (
            self.no_signal_reason_streak.get(normalized, 0) + 1
        )

    def record_lean_observability(self, snapshot: Mapping[str, Any]) -> None:
        requests = snapshot.get("requests_total")
        if isinstance(requests, Mapping):
            for key, value in cast(Mapping[object, Any], requests).items():
                if isinstance(value, int):
                    self.lean_request_total[str(key)] = value
        failures = snapshot.get("failures_total")
        if isinstance(failures, Mapping):
            for key, value in cast(Mapping[object, Any], failures).items():
                if isinstance(value, int):
                    self.lean_failure_taxonomy_total[str(key)] = value
        latency = snapshot.get("latency_ms_avg")
        if isinstance(latency, Mapping):
            for key, value in cast(Mapping[object, Any], latency).items():
                if isinstance(value, (int, float)):
                    self.lean_latency_ms[str(key)] = float(value)

    def record_lean_shadow(
        self, *, parity_status: str | None, failure_taxonomy: str | None
    ) -> None:
        status = parity_status.strip() if isinstance(parity_status, str) else ""
        if not status:
            status = "unknown"
        self.lean_shadow_parity_total[status] = (
            self.lean_shadow_parity_total.get(status, 0) + 1
        )
        if failure_taxonomy:
            self.lean_shadow_failure_total[failure_taxonomy] = (
                self.lean_shadow_failure_total.get(failure_taxonomy, 0) + 1
            )

    def record_lean_strategy_shadow(self, parity_status: str | None) -> None:
        status = parity_status.strip() if isinstance(parity_status, str) else ""
        if not status:
            status = "unknown"
        self.lean_strategy_shadow_total[status] = (
            self.lean_strategy_shadow_total.get(status, 0) + 1
        )

    def record_lean_canary_breach(self, breach_type: str) -> None:
        self.lean_canary_breach_total[breach_type] = (
            self.lean_canary_breach_total.get(breach_type, 0) + 1
        )

    def record_signal_staleness_alert(self, reason: str | None) -> None:
        normalized = _normalize_reason_metric(reason)
        current = self.signal_staleness_alert_total.get(normalized, 0)
        self.signal_staleness_alert_total[normalized] = current + 1

    def record_signal_expected_staleness(self, reason: str | None) -> None:
        normalized = _normalize_reason_metric(reason)
        current = self.signal_expected_staleness_total.get(normalized, 0)
        self.signal_expected_staleness_total[normalized] = current + 1

    def record_signal_actionable_staleness(self, reason: str | None) -> None:
        normalized = _normalize_reason_metric(reason)
        current = self.signal_actionable_staleness_total.get(normalized, 0)
        self.signal_actionable_staleness_total[normalized] = current + 1

    def record_universe_fail_safe_block(self, reason: str | None) -> None:
        normalized = _normalize_reason_metric(reason)
        current = self.universe_fail_safe_reason_total.get(normalized, 0)
        self.universe_fail_safe_reason_total[normalized] = current + 1

    def record_signal_continuity_alert_state(
        self, *, active: bool, recovery_streak: int
    ) -> None:
        self.signal_continuity_alert_active = 1 if active else 0
        self.signal_continuity_alert_recovery_streak = max(0, int(recovery_streak))

    def record_universe_resolution(
        self,
        *,
        status: str | None,
        reason: str | None,
        symbols_count: int,
        cache_age_seconds: int | None,
    ) -> None:
        normalized_status = (status or "unknown").strip() or "unknown"
        normalized_reason = _normalize_reason_metric(reason)
        metric_key = f"{normalized_status}|{normalized_reason}"
        self.universe_resolution_total[metric_key] = (
            self.universe_resolution_total.get(metric_key, 0) + 1
        )
        self.universe_symbols_count = max(0, int(symbols_count))
        self.universe_cache_age_seconds = max(0, int(cache_age_seconds or 0))

    def record_market_context_result(
        self, reason: str | None, *, shadow_mode: bool
    ) -> None:
        normalized = reason.strip() if isinstance(reason, str) else ""
        if not normalized:
            normalized = "unknown"
        current_reason = self.llm_market_context_reason_total.get(normalized, 0)
        self.llm_market_context_reason_total[normalized] = current_reason + 1
        if shadow_mode:
            current_shadow = self.llm_market_context_shadow_total.get(normalized, 0)
            self.llm_market_context_shadow_total[normalized] = current_shadow + 1

    def record_llm_policy_resolution(self, classification: str | None) -> None:
        normalized = classification.strip() if isinstance(classification, str) else ""
        if not normalized:
            normalized = "unknown"
        current = self.llm_policy_resolution_total.get(normalized, 0)
        self.llm_policy_resolution_total[normalized] = current + 1

    def record_llm_committee_member(
        self,
        *,
        role: str,
        verdict: str,
        latency_ms: int | None,
        schema_error: bool,
    ) -> None:
        self.llm_committee_requests_total[role] = (
            self.llm_committee_requests_total.get(role, 0) + 1
        )
        if latency_ms is not None:
            self.llm_committee_latency_ms[role] = latency_ms
        verdict_key = f"{role}:{verdict}"
        self.llm_committee_verdict_total[verdict_key] = (
            self.llm_committee_verdict_total.get(verdict_key, 0) + 1
        )
        if schema_error:
            self.llm_committee_schema_error_total += 1

    def record_llm_committee_veto_alignment(
        self,
        *,
        committee_veto: bool,
        deterministic_veto: bool,
    ) -> None:
        if not committee_veto:
            return
        self.llm_committee_veto_total += 1
        if deterministic_veto:
            self.llm_committee_veto_alignment_total += 1

    def record_strategy_runtime(self, telemetry: DecisionRuntimeTelemetry) -> None:
        if not telemetry.runtime_enabled:
            self.strategy_runtime_legacy_path_total += 1
            return
        if telemetry.fallback_to_legacy:
            self.strategy_runtime_fallback_total += 1
        observation = telemetry.observation
        if observation is None:
            return
        for strategy_id, count in observation.strategy_events_total.items():
            self.strategy_events_total[strategy_id] = (
                self.strategy_events_total.get(strategy_id, 0) + count
            )
        for strategy_id, count in observation.strategy_intents_total.items():
            self.strategy_intents_total[strategy_id] = (
                self.strategy_intents_total.get(strategy_id, 0) + count
            )
        for strategy_id, count in observation.strategy_errors_total.items():
            self.strategy_errors_total[strategy_id] = (
                self.strategy_errors_total.get(strategy_id, 0) + count
            )
        for strategy_id, latency_ms in observation.strategy_latency_ms.items():
            self.strategy_latency_ms[strategy_id] = latency_ms
        self.intent_conflict_total += observation.intent_conflicts_total
        self.strategy_runtime_isolated_failures_total += (
            observation.isolated_failures_total
        )

    def record_allocator_result(self, result: AllocationResult) -> None:
        self.allocator_requests_total += 1
        self.allocator_regime_total[result.regime_label] = (
            self.allocator_regime_total.get(result.regime_label, 0) + 1
        )
        self.allocator_fragility_state_total[result.fragility_state] = (
            self.allocator_fragility_state_total.get(result.fragility_state, 0) + 1
        )
        multiplier_key = (
            f"{result.regime_label}|{result.fragility_state}|"
            f"{result.budget_multiplier}:{result.capacity_multiplier}"
        )
        self.allocator_multiplier_total[multiplier_key] = (
            self.allocator_multiplier_total.get(multiplier_key, 0) + 1
        )
        self.fragility_score[result.decision.symbol] = float(result.fragility_score)
        if result.approved:
            self.allocator_approved_total += 1
        else:
            self.allocator_rejected_total += 1
        if result.clipped:
            self.allocator_clipped_total += 1
        if result.stability_mode_active:
            self.stability_mode_active_total += 1
        for reason_code in result.reason_codes:
            self.allocator_reason_total[reason_code] = (
                self.allocator_reason_total.get(reason_code, 0) + 1
            )

    def record_forecast_telemetry(self, payload: Mapping[str, Any]) -> None:
        family = str(payload.get("model_family") or "unknown").strip() or "unknown"
        route_key = str(payload.get("route_key") or "unknown").strip() or "unknown"
        symbol = str(payload.get("symbol") or "unknown").strip() or "unknown"
        horizon = str(payload.get("horizon") or "unknown").strip() or "unknown"
        latency = payload.get("inference_latency_ms")
        calibration_error = payload.get("calibration_error")
        fallback_reason = payload.get("fallback_reason")

        if isinstance(latency, int):
            self.forecast_router_inference_latency_ms[family] = latency

        if isinstance(fallback_reason, str) and fallback_reason.strip():
            normalized_reason = fallback_reason.strip()
            self.forecast_router_fallback_total[normalized_reason] = (
                self.forecast_router_fallback_total.get(normalized_reason, 0) + 1
            )

        route_counter_key = f"{family}|{route_key}"
        self.forecast_route_selection_total[route_counter_key] = (
            self.forecast_route_selection_total.get(route_counter_key, 0) + 1
        )

        if calibration_error is not None:
            key = f"{family}|{symbol}|{horizon}"
            self.forecast_calibration_error[key] = str(calibration_error)

    def record_decision_regime_resolution(
        self, *, source: str, fallback_reason: str | None
    ) -> None:
        normalized_source = source.strip() or "unknown"
        self.decision_regime_resolution_source_total[normalized_source] = (
            self.decision_regime_resolution_source_total.get(normalized_source, 0) + 1
        )
        if fallback_reason is None:
            return
        normalized_reason = fallback_reason.strip() or "unknown"
        self.decision_regime_resolution_fallback_total[normalized_reason] = (
            self.decision_regime_resolution_fallback_total.get(normalized_reason, 0) + 1
        )

    def record_adaptive_policy_result(
        self,
        decision: AdaptiveExecutionPolicyDecision,
        *,
        applied: bool,
    ) -> None:
        self.adaptive_policy_decisions_total += 1
        self.adaptive_policy_key_total[decision.key] = (
            self.adaptive_policy_key_total.get(decision.key, 0) + 1
        )
        if applied:
            self.adaptive_policy_applied_total += 1
        if decision.fallback_active:
            self.adaptive_policy_fallback_total += 1
        if decision.effect_size_bps is not None:
            self.adaptive_policy_effect_size_bps[decision.key] = float(
                decision.effect_size_bps
            )
        if decision.degradation_bps is not None:
            self.adaptive_policy_degradation_bps[decision.key] = float(
                decision.degradation_bps
            )

    def record_autonomy_promotion_outcome(
        self,
        *,
        signal_count: int,
        decision_count: int,
        trade_count: int,
        recommendation: str | None,
        promotion_allowed: bool,
        outcome: str,
    ) -> None:
        self.autonomy_signal_throughput_total += max(0, signal_count)
        self.autonomy_decision_throughput_total += max(0, decision_count)
        self.autonomy_trade_throughput_total += max(0, trade_count)
        if promotion_allowed:
            self.autonomy_promotion_allowed_total += 1
        else:
            self.autonomy_promotion_blocked_total += 1
        normalized_recommendation = recommendation.strip() if recommendation else ""
        if not normalized_recommendation:
            normalized_recommendation = "unknown"
        self.autonomy_recommendation_total[normalized_recommendation] = (
            self.autonomy_recommendation_total.get(normalized_recommendation, 0) + 1
        )
        normalized_outcome = outcome.strip()
        if not normalized_outcome:
            normalized_outcome = "unknown"
        self.autonomy_outcome_total[normalized_outcome] = (
            self.autonomy_outcome_total.get(normalized_outcome, 0) + 1
        )

    def record_uncertainty_gate(self, gate_report_payload: Mapping[str, Any]) -> None:
        action = str(gate_report_payload.get("uncertainty_gate_action", "")).strip()
        if action:
            self.uncertainty_gate_action_total[action] = (
                self.uncertainty_gate_action_total.get(action, 0) + 1
            )
        coverage_error = _optional_decimal(gate_report_payload.get("coverage_error"))
        if coverage_error is not None:
            self.calibration_coverage_error = float(coverage_error)
        interval_width = _optional_decimal(
            gate_report_payload.get("conformal_interval_width")
        )
        if interval_width is not None:
            self.conformal_interval_width = float(interval_width)
        shift_score = _optional_decimal(gate_report_payload.get("shift_score"))
        if shift_score is not None:
            self.regime_shift_score = float(shift_score)
        gates = gate_report_payload.get("gates")
        if isinstance(gates, list):
            for raw_gate in cast(list[object], gates):
                if not isinstance(raw_gate, Mapping):
                    continue
                gate = cast(Mapping[str, Any], raw_gate)
                if (
                    str(gate.get("gate_id", "")).strip()
                    != "gate7_uncertainty_calibration"
                ):
                    continue
                status = str(gate.get("status", "")).strip()
                recalibration_status = "not_required" if status == "pass" else "queued"
                self.recalibration_runs_total[recalibration_status] = (
                    self.recalibration_runs_total.get(recalibration_status, 0) + 1
                )
                break

    def record_runtime_uncertainty_gate(
        self, action: RuntimeUncertaintyGateAction, *, blocked: bool
    ) -> None:
        self.runtime_uncertainty_gate_action_total[action] = (
            self.runtime_uncertainty_gate_action_total.get(action, 0) + 1
        )
        if blocked:
            self.runtime_uncertainty_gate_blocked_total[action] = (
                self.runtime_uncertainty_gate_blocked_total.get(action, 0) + 1
            )

    def record_runtime_regime_gate(
        self, action: RuntimeUncertaintyGateAction, *, blocked: bool
    ) -> None:
        self.runtime_regime_gate_action_total[action] = (
            self.runtime_regime_gate_action_total.get(action, 0) + 1
        )
        if blocked:
            self.runtime_regime_gate_blocked_total[action] = (
                self.runtime_regime_gate_blocked_total.get(action, 0) + 1
            )


@dataclass
class TradingState:
    running: bool = False
    last_run_at: Optional[datetime] = None
    last_reconcile_at: Optional[datetime] = None
    last_error: Optional[str] = None
    autonomy_runs_total: int = 0
    autonomy_signals_total: int = 0
    autonomy_patches_total: int = 0
    last_autonomy_run_at: Optional[datetime] = None
    last_autonomy_error: Optional[str] = None
    last_autonomy_reason: Optional[str] = None
    last_autonomy_run_id: Optional[str] = None
    last_autonomy_candidate_id: Optional[str] = None
    last_autonomy_gates: Optional[str] = None
    last_autonomy_phase_manifest: Optional[str] = None
    last_autonomy_actuation_intent: Optional[str] = None
    last_autonomy_phase_manifest: Optional[str] = None
    last_autonomy_patch: Optional[str] = None
    last_autonomy_recommendation: Optional[str] = None
    last_autonomy_promotion_action: Optional[str] = None
    last_autonomy_promotion_eligible: Optional[bool] = None
    last_autonomy_recommendation_trace_id: Optional[str] = None
    last_autonomy_iteration: Optional[int] = None
    last_autonomy_iteration_notes_path: Optional[str] = None
    last_autonomy_throughput: Optional[dict[str, int | bool | str | None]] = None
    last_ingest_signals_total: int = 0
    last_ingest_window_start: Optional[datetime] = None
    last_ingest_window_end: Optional[datetime] = None
    last_ingest_reason: Optional[str] = None
    market_session_open: Optional[bool] = None
    last_signal_continuity_state: Optional[str] = None
    last_signal_continuity_reason: Optional[str] = None
    last_signal_continuity_actionable: Optional[bool] = None
    signal_continuity_alert_active: bool = False
    signal_continuity_alert_reason: Optional[str] = None
    signal_continuity_alert_started_at: Optional[datetime] = None
    signal_continuity_alert_last_seen_at: Optional[datetime] = None
    signal_continuity_recovery_streak: int = 0
    autonomy_no_signal_streak: int = 0
    last_evidence_continuity_report: Optional[dict[str, Any]] = None
    autonomy_failure_streak: int = 0
    universe_source_status: Optional[str] = None
    universe_source_reason: Optional[str] = None
    universe_symbols_count: int = 0
    universe_cache_age_seconds: Optional[int] = None
    universe_fail_safe_blocked: bool = False
    universe_fail_safe_block_reason: Optional[str] = None
    emergency_stop_active: bool = False
    emergency_stop_reason: Optional[str] = None
    emergency_stop_triggered_at: Optional[datetime] = None
    emergency_stop_resolved_at: Optional[datetime] = None
    emergency_stop_recovery_streak: int = 0
    rollback_incidents_total: int = 0
    rollback_incident_evidence_path: Optional[str] = None
    drift_status: str = "unknown"
    drift_active_incident_id: Optional[str] = None
    drift_active_reason_codes: list[str] = field(
        default_factory=lambda: cast(list[str], [])
    )
    drift_last_detection_at: Optional[datetime] = None
    drift_last_detection_path: Optional[str] = None
    drift_last_action_type: Optional[str] = None
    drift_last_action_at: Optional[datetime] = None
    drift_last_action_path: Optional[str] = None
    drift_last_outcome_path: Optional[str] = None
    drift_live_promotion_eligible: bool = False
    drift_live_promotion_reasons: list[str] = field(
        default_factory=lambda: cast(list[str], [])
    )
    last_runtime_uncertainty_gate_action: str | None = None
    last_runtime_uncertainty_gate_source: str | None = None
    last_runtime_uncertainty_gate_reason: str | None = None
    last_runtime_regime_gate_action: str | None = None
    last_runtime_regime_gate_source: str | None = None
    last_runtime_regime_gate_reason: str | None = None
    metrics: TradingMetrics = field(default_factory=TradingMetrics)


class TradingPipeline:
    """Orchestrate ingest -> decide -> risk -> execute for one cycle."""

    def __init__(
        self,
        alpaca_client: TorghutAlpacaClient,
        order_firewall: OrderFirewall,
        ingestor: ClickHouseSignalIngestor,
        decision_engine: DecisionEngine,
        risk_engine: RiskEngine,
        executor: OrderExecutor,
        execution_adapter: ExecutionAdapter,
        reconciler: Reconciler,
        universe_resolver: UniverseResolver,
        state: TradingState,
        account_label: str,
        session_factory: Callable[[], Session] = SessionLocal,
        llm_review_engine: Optional[LLMReviewEngine] = None,
        price_fetcher: Optional[PriceFetcher] = None,
        strategy_catalog: StrategyCatalog | None = None,
        execution_policy: Optional[ExecutionPolicy] = None,
        order_feed_ingestor: OrderFeedIngestor | None = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.order_firewall = order_firewall
        self.ingestor = ingestor
        self.decision_engine = decision_engine
        self.risk_engine = risk_engine
        self.executor = executor
        self.execution_adapter = execution_adapter
        self.reconciler = reconciler
        self.universe_resolver = universe_resolver
        self.state = state
        self.account_label = account_label
        self.session_factory = session_factory
        self.price_fetcher = price_fetcher or ClickHousePriceFetcher()
        self._snapshot_cache = None
        self._snapshot_cached_at: Optional[datetime] = None
        self.strategy_catalog = strategy_catalog
        self.execution_policy = execution_policy or ExecutionPolicy()
        self.order_feed_ingestor = order_feed_ingestor or OrderFeedIngestor()
        self.market_context_client = MarketContextClient()
        self.lean_lane_manager = LeanLaneManager()
        if llm_review_engine is not None:
            self.llm_review_engine = llm_review_engine
        elif settings.llm_enabled:
            self.llm_review_engine = LLMReviewEngine()
        else:
            self.llm_review_engine = None

    def run_once(self) -> None:
        with self.session_factory() as session:
            strategies = self._prepare_run_once(session)
            if not strategies:
                return

            batch = self.ingestor.fetch_signals(session)
            self._record_ingest_window(batch)
            if not self._prepare_batch_for_decisions(session, batch):
                return

            context = self._build_run_context(session)
            if context is None:
                self.ingestor.commit_cursor(session, batch)
                return
            account_snapshot, account, positions, allowed_symbols = context
            self._process_batch_signals(
                session=session,
                batch=batch,
                strategies=strategies,
                account_snapshot=account_snapshot,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self.ingestor.commit_cursor(session, batch)

    def _prepare_run_once(self, session: Session) -> list[Strategy]:
        self._ingest_order_feed(session)
        self.order_firewall.cancel_open_orders_if_kill_switch()
        if self.strategy_catalog is not None:
            self.strategy_catalog.refresh(session)
        strategies = self._load_strategies(session)
        if not strategies:
            logger.info("No enabled strategies found; skipping trading cycle")
        return strategies

    def _record_ingest_window(self, batch: SignalBatch) -> None:
        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason

    def _prepare_batch_for_decisions(
        self, session: Session, batch: SignalBatch
    ) -> bool:
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        if not batch.signals:
            self.record_no_signal_batch(batch)
            self.ingestor.commit_cursor(session, batch)
            return False

        if settings.trading_feature_quality_enabled:
            quality_thresholds = FeatureQualityThresholds(
                max_required_null_rate=settings.trading_feature_max_required_null_rate,
                max_staleness_ms=settings.trading_feature_max_staleness_ms,
                max_duplicate_ratio=settings.trading_feature_max_duplicate_ratio,
            )
            quality_report = evaluate_feature_batch_quality(
                batch.signals, thresholds=quality_thresholds
            )
            self.state.metrics.feature_batch_rows_total += quality_report.rows_total
            self.state.metrics.feature_null_rate = quality_report.null_rate_by_field
            self.state.metrics.feature_staleness_ms_p95 = (
                quality_report.staleness_ms_p95
            )
            self.state.metrics.feature_duplicate_ratio = quality_report.duplicate_ratio
            self.state.metrics.feature_schema_mismatch_total += (
                quality_report.schema_mismatch_total
            )
            if not quality_report.accepted:
                self.state.metrics.feature_quality_rejections_total += 1
                logger.error(
                    "Feature quality gate failed rows=%s reasons=%s staleness_ms_p95=%s duplicate_ratio=%s",
                    quality_report.rows_total,
                    quality_report.reasons,
                    quality_report.staleness_ms_p95,
                    quality_report.duplicate_ratio,
                )
                self.ingestor.commit_cursor(session, batch)
                return False

        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.no_signal_streak = 0
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
        return True

    def _build_run_context(
        self, session: Session
    ) -> tuple[Any, dict[str, str], list[dict[str, Any]], set[str]] | None:
        account_snapshot = self._get_account_snapshot(session)
        account = {
            "equity": str(account_snapshot.equity),
            "cash": str(account_snapshot.cash),
            "buying_power": str(account_snapshot.buying_power),
        }
        positions = _clone_positions(account_snapshot.positions)

        universe_resolution = self.universe_resolver.get_resolution()
        self.state.universe_source_status = universe_resolution.status
        self.state.universe_source_reason = universe_resolution.reason
        self.state.universe_symbols_count = len(universe_resolution.symbols)
        self.state.universe_cache_age_seconds = universe_resolution.cache_age_seconds
        self.state.metrics.record_universe_resolution(
            status=universe_resolution.status,
            reason=universe_resolution.reason,
            symbols_count=len(universe_resolution.symbols),
            cache_age_seconds=universe_resolution.cache_age_seconds,
        )
        self.state.universe_fail_safe_blocked = False
        self.state.universe_fail_safe_block_reason = None
        allowed_symbols = universe_resolution.symbols
        if universe_resolution.status == "degraded":
            self.state.metrics.record_signal_staleness_alert(
                "universe_source_stale_cache"
            )
        if (
            settings.trading_universe_source == "jangar"
            and settings.trading_universe_require_non_empty_jangar
            and not allowed_symbols
        ):
            universe_reason = universe_resolution.reason or "unknown"
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
                f"universe_source_unavailable reason={universe_resolution.reason}"
            )
            logger.error(
                "Blocking decision execution: authoritative Jangar universe unavailable reason=%s status=%s",
                universe_resolution.reason,
                universe_resolution.status,
            )
            return None

        return account_snapshot, account, positions, allowed_symbols

    def _process_batch_signals(
        self,
        *,
        session: Session,
        batch: SignalBatch,
        strategies: list[Strategy],
        account_snapshot: Any,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        allocator = allocator_from_settings(account_snapshot.equity)
        for signal in batch.signals:
            decisions = self._evaluate_signal_decisions(
                signal,
                strategies,
                equity=account_snapshot.equity,
            )
            if not decisions:
                continue
            allocation_results = allocator.allocate(
                decisions,
                account=account,
                positions=positions,
                regime_label=_resolve_signal_regime(signal),
            )
            self._apply_allocation_results(
                session=session,
                allocation_results=allocation_results,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )

    def _evaluate_signal_decisions(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Decimal,
    ) -> list[StrategyDecision]:
        try:
            decisions = self.decision_engine.evaluate(signal, strategies, equity=equity)
            self.state.metrics.record_strategy_runtime(
                self.decision_engine.consume_runtime_telemetry()
            )
            for telemetry in self.decision_engine.consume_forecast_telemetry():
                self.state.metrics.record_forecast_telemetry(telemetry.to_payload())
            return decisions
        except Exception:
            logger.exception(
                "Decision evaluation failed symbol=%s timeframe=%s",
                signal.symbol,
                signal.timeframe,
            )
            return []

    def _apply_allocation_results(
        self,
        *,
        session: Session,
        allocation_results: list[AllocationResult],
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        for allocation_result in allocation_results:
            self.state.metrics.record_allocator_result(allocation_result)
            decision = allocation_result.decision
            self.state.metrics.decisions_total += 1
            try:
                submitted_decision = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted_decision is not None:
                    _apply_projected_position_decision(positions, submitted_decision)
            except Exception:
                logger.exception(
                    "Decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1

    def _ingest_order_feed(self, session: Session) -> None:
        counters = self.order_feed_ingestor.ingest_once(session)
        self.state.metrics.order_feed_messages_total += counters.get(
            "messages_total", 0
        )
        self.state.metrics.order_feed_events_persisted_total += counters.get(
            "events_persisted_total", 0
        )
        self.state.metrics.order_feed_duplicates_total += counters.get(
            "duplicates_total", 0
        )
        self.state.metrics.order_feed_out_of_order_total += counters.get(
            "out_of_order_total", 0
        )
        self.state.metrics.order_feed_missing_fields_total += counters.get(
            "missing_fields_total", 0
        )
        self.state.metrics.order_feed_apply_updates_total += counters.get(
            "apply_updates_total", 0
        )
        self.state.metrics.order_feed_consumer_errors_total += counters.get(
            "consumer_errors_total", 0
        )

    def record_no_signal_batch(self, batch: SignalBatch) -> None:
        self.state.last_ingest_signals_total = len(batch.signals)
        self.state.last_ingest_window_start = batch.query_start
        self.state.last_ingest_window_end = batch.query_end
        self.state.last_ingest_reason = batch.no_signal_reason
        reason = batch.no_signal_reason
        normalized_reason = _normalize_reason_metric(reason)
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        if batch.signal_lag_seconds is not None:
            self.state.metrics.signal_lag_seconds = int(batch.signal_lag_seconds)
        else:
            self.state.metrics.signal_lag_seconds = None
        self.state.metrics.record_no_signal(reason)
        streak = self.state.metrics.no_signal_reason_streak.get(normalized_reason, 0)
        continuity_streak_reasons = {
            "no_signals_in_window",
            "cursor_tail_stable",
            "cursor_ahead_of_stream",
            "empty_batch_advanced",
        }
        streak_threshold_met = (
            normalized_reason in continuity_streak_reasons
            and streak >= settings.trading_signal_no_signal_streak_alert_threshold
        )
        lag_threshold_met = (
            batch.signal_lag_seconds is not None
            and batch.signal_lag_seconds
            >= settings.trading_signal_stale_lag_alert_seconds
        )
        actionable = self._is_actionable_no_signal_reason(
            reason=normalized_reason,
            market_session_open=market_session_open,
        )
        continuity_state = (
            "actionable_source_fault"
            if actionable
            else "expected_market_closed_staleness"
        )
        self.state.last_signal_continuity_state = continuity_state
        self.state.last_signal_continuity_reason = normalized_reason
        self.state.last_signal_continuity_actionable = actionable
        self.state.metrics.signal_continuity_actionable = 1 if actionable else 0
        if actionable:
            self.state.metrics.record_signal_actionable_staleness(normalized_reason)
        else:
            self.state.metrics.record_signal_expected_staleness(normalized_reason)

        if actionable and streak_threshold_met:
            _latch_signal_continuity_alert_state(self.state, normalized_reason)
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal continuity alert: reason=%s consecutive_no_signal=%s lag_seconds=%s market_session_open=%s",
                reason,
                streak,
                batch.signal_lag_seconds,
                market_session_open,
            )
        elif actionable and lag_threshold_met:
            _latch_signal_continuity_alert_state(self.state, normalized_reason)
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal freshness alert: reason=%s lag_seconds=%s market_session_open=%s",
                reason,
                batch.signal_lag_seconds,
                market_session_open,
            )
        elif actionable and self.state.signal_continuity_alert_active:
            _latch_signal_continuity_alert_state(self.state, normalized_reason)
        elif not actionable and (streak_threshold_met or lag_threshold_met):
            logger.info(
                "Signal continuity observed as expected staleness reason=%s lag_seconds=%s market_session_open=%s",
                reason,
                batch.signal_lag_seconds,
                market_session_open,
            )

    def _is_actionable_no_signal_reason(
        self,
        *,
        reason: str,
        market_session_open: bool,
    ) -> bool:
        if reason == "cursor_ahead_of_stream":
            return True
        if market_session_open:
            return True
        expected_market_closed_reasons = (
            settings.trading_signal_market_closed_expected_reasons
        )
        return reason not in expected_market_closed_reasons

    def _is_market_session_open(self, now: datetime | None = None) -> bool:
        trading_client = getattr(self.alpaca_client, "trading", None)
        return _is_market_session_open(trading_client, now=now)

    def reconcile(self) -> int:
        with self.session_factory() as session:
            updates = self.reconciler.reconcile(session, self.execution_adapter)
            if updates:
                self.state.metrics.reconcile_updates_total += updates
            return updates

    def _handle_decision(
        self,
        session: Session,
        decision: StrategyDecision,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> StrategyDecision | None:
        decision_row: Optional[TradeDecision] = None
        try:
            strategy_context = self._resolve_strategy_context(
                decision=decision,
                strategies=strategies,
                allowed_symbols=allowed_symbols,
            )
            if strategy_context is None:
                return
            strategy, symbol_allowlist = strategy_context

            decision_row = self._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
            if decision_row is None:
                return

            prepared = self._prepare_decision_for_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                strategy=strategy,
                account=account,
                positions=positions,
            )
            if prepared is None:
                return
            decision, snapshot = prepared

            policy_stage = self._evaluate_execution_policy_outcome(
                session=session,
                decision=decision,
                decision_row=decision_row,
                strategy=strategy,
                positions=positions,
                snapshot=snapshot,
            )
            if policy_stage is None:
                return
            decision, policy_outcome = policy_stage

            if not self._passes_risk_verdict(
                session=session,
                decision=decision,
                decision_row=decision_row,
                strategy=strategy,
                account=account,
                positions=positions,
                symbol_allowlist=symbol_allowlist,
                execution_advisor=policy_outcome.advisor_metadata,
            ):
                return
            if not self._is_trading_submission_allowed(
                session=session,
                decision=decision,
                decision_row=decision_row,
            ):
                return

            submitted = self._submit_decision_execution(
                session=session,
                decision=decision,
                decision_row=decision_row,
                policy_outcome=policy_outcome,
                symbol_allowlist=symbol_allowlist,
            )
            if not submitted:
                return None
            return decision
        except Exception as exc:
            logger.exception(
                "Decision handling failed strategy_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision.symbol,
                exc,
            )
            if decision_row is not None and decision_row.status == "planned":
                self.state.metrics.orders_rejected_total += 1
                self.executor.mark_rejected(
                    session,
                    decision_row,
                    f"decision_handler_error {type(exc).__name__}",
                )
            return None

    def _resolve_strategy_context(
        self,
        *,
        decision: StrategyDecision,
        strategies: list[Strategy],
        allowed_symbols: set[str],
    ) -> tuple[Strategy, set[str]] | None:
        strategy = next(
            (s for s in strategies if str(s.id) == decision.strategy_id), None
        )
        if strategy is None:
            return None

        strategy_symbols = _coerce_strategy_symbols(strategy.universe_symbols)
        if strategy_symbols and allowed_symbols:
            return strategy, strategy_symbols & allowed_symbols
        if strategy_symbols:
            return strategy, strategy_symbols
        return strategy, allowed_symbols

    def _ensure_pending_decision_row(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
    ) -> TradeDecision | None:
        decision_row = self.executor.ensure_decision(
            session, decision, strategy, self.account_label
        )
        if decision_row.status != "planned":
            return None
        if self.executor.execution_exists(session, decision_row):
            self.state.metrics.planned_decisions_with_execution_total += 1
            logger.warning(
                "Decision remained planned while execution already exists decision_id=%s strategy_id=%s symbol=%s",
                decision_row.id,
                decision.strategy_id,
                decision.symbol,
            )
            return None
        if self._expire_stale_planned_decision(
            session=session, decision=decision, decision_row=decision_row
        ):
            return None
        return decision_row

    def _expire_stale_planned_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        timeout_seconds = settings.trading_planned_decision_timeout_seconds
        if timeout_seconds <= 0:
            return False
        created_at = decision_row.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        age_seconds = int((datetime.now(timezone.utc) - created_at).total_seconds())
        if age_seconds < timeout_seconds:
            return False
        self.state.metrics.planned_decisions_stale_total += 1
        self.state.metrics.planned_decisions_timeout_rejected_total += 1
        self.state.metrics.orders_rejected_total += 1
        reason = f"decision_timeout_unsubmitted:{age_seconds}s"
        self.executor.mark_rejected(session, decision_row, reason)
        logger.error(
            "Rejected stale planned decision decision_id=%s strategy_id=%s symbol=%s age_seconds=%s timeout_seconds=%s",
            decision_row.id,
            decision.strategy_id,
            decision.symbol,
            age_seconds,
            timeout_seconds,
        )
        return True

    def _prepare_decision_for_submission(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        allocator_rejection = _allocator_rejection_reasons(decision)
        if allocator_rejection:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=allocator_rejection,
                log_template=(
                    "Decision rejected by allocator strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None

        decision, snapshot = self._ensure_decision_price(
            decision, signal_price=decision.params.get("price")
        )
        if snapshot is not None:
            price_params_update = cast(
                Mapping[str, Any],
                decision.model_dump(mode="json").get("params", {}),
            )
            self.executor.update_decision_params(
                session, decision_row, price_params_update
            )

        sizing_result = self._apply_portfolio_sizing(
            decision, strategy, account, positions
        )
        decision = sizing_result.decision
        sizing_params = decision.model_dump(mode="json").get("params", {})
        if isinstance(sizing_params, Mapping) and "portfolio_sizing" in sizing_params:
            self.executor.update_decision_params(
                session, decision_row, cast(Mapping[str, Any], sizing_params)
            )
        if not sizing_result.approved:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=sizing_result.reasons,
                log_template=(
                    "Decision rejected by portfolio sizing strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None

        decision, gate_payload, gate_rejection = self._apply_runtime_uncertainty_gate(
            decision, positions=positions
        )
        self._persist_runtime_uncertainty_gate_payload(
            session=session,
            decision=decision,
            decision_row=decision_row,
            gate_payload=gate_payload,
        )
        if gate_rejection:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=gate_rejection,
            )
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[gate_rejection],
                log_template=(
                    "Decision rejected by execution gate strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None

        decision, llm_reject_reason = self._apply_llm_review(
            session, decision, decision_row, account, positions
        )
        if llm_reject_reason:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=None,
            )
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[llm_reject_reason],
                log_template="Decision rejected by llm review strategy_id=%s symbol=%s reason=%s",
            )
            return None

        gate_rejection = self._recheck_runtime_uncertainty_gate_after_llm(
            session=session,
            decision=decision,
            decision_row=decision_row,
            positions=positions,
            gate_payload=gate_payload,
        )
        if gate_rejection:
            self._record_runtime_uncertainty_gate_result(
                gate_payload=gate_payload,
                gate_rejection=gate_rejection,
            )
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=[gate_rejection],
                log_template=(
                    "Decision rejected by execution gate strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None

        self._record_runtime_uncertainty_gate_result(
            gate_payload=gate_payload,
            gate_rejection=None,
        )
        return decision, snapshot

    def _record_runtime_uncertainty_gate_result(
        self,
        *,
        gate_payload: Mapping[str, Any],
        gate_rejection: str | None,
    ) -> None:
        uncertainty_gate_payload = gate_payload.get("uncertainty_gate")
        uncertainty_action = "pass"
        if isinstance(uncertainty_gate_payload, Mapping):
            uncertainty_gate_map = cast(Mapping[str, Any], uncertainty_gate_payload)
            uncertainty_action = str(
                uncertainty_gate_map.get("action") or "pass"
            ).strip().lower()
        elif str(gate_payload.get("action") or "pass").strip().lower() in {
            "pass",
            "degrade",
            "abstain",
            "fail",
        }:
            uncertainty_action = str(gate_payload.get("action") or "pass").strip().lower()
        regime_gate_payload = gate_payload.get("regime_gate")
        regime_action = "pass"
        if isinstance(regime_gate_payload, Mapping):
            regime_gate_map = cast(Mapping[str, Any], regime_gate_payload)
            regime_action = str(regime_gate_map.get("action") or "pass").strip().lower()
        if uncertainty_action in {"pass", "degrade", "abstain", "fail"}:
            self.state.metrics.record_runtime_uncertainty_gate(
                cast(RuntimeUncertaintyGateAction, uncertainty_action),
                blocked=gate_rejection is not None,
            )
            self.state.last_runtime_uncertainty_gate_action = uncertainty_action
        else:
            self.state.last_runtime_uncertainty_gate_action = None

        if regime_action in {"pass", "degrade", "abstain", "fail"}:
            self.state.metrics.record_runtime_regime_gate(
                cast(RuntimeUncertaintyGateAction, regime_action),
                blocked=(
                    gate_rejection is not None
                    and regime_action in {"abstain", "fail"}
                ),
            )
            self.state.last_runtime_regime_gate_action = regime_action
        else:
            self.state.last_runtime_regime_gate_action = None

        self.state.last_runtime_uncertainty_gate_source = (
            str(gate_payload.get("source") or "").strip() or None
        )
        self.state.last_runtime_uncertainty_gate_reason = gate_rejection
        uncertainty_gate = gate_payload.get("uncertainty_gate")
        regime_gate = gate_payload.get("regime_gate")
        if isinstance(uncertainty_gate, Mapping):
            uncertainty_gate_map = cast(Mapping[str, Any], uncertainty_gate)
            self.state.last_runtime_uncertainty_gate_source = (
                str(
                    uncertainty_gate_map.get("source")
                    or gate_payload.get("source")
                    or ""
                )
                .strip()
                or None
            )
            uncertainty_reason = str(uncertainty_gate_map.get("reason") or "").strip()
            if uncertainty_reason:
                self.state.last_runtime_uncertainty_gate_reason = (
                    f"{self.state.last_runtime_uncertainty_gate_reason}|{uncertainty_reason}"
                    if self.state.last_runtime_uncertainty_gate_reason
                    else uncertainty_reason
                )
        if isinstance(regime_gate, Mapping):
            regime_gate_map = cast(Mapping[str, Any], regime_gate)
            self.state.last_runtime_regime_gate_source = (
                str(regime_gate_map.get("source") or "regime").strip() or None
            )
            reason = str(regime_gate_map.get("reason") or "").strip()
            self.state.last_runtime_regime_gate_reason = reason or None
        elif self.state.last_runtime_regime_gate_action is None:
            self.state.last_runtime_regime_gate_action = regime_action
            self.state.last_runtime_regime_gate_source = (
                str(gate_payload.get("source") or "").strip() or None
            )

    def _persist_runtime_uncertainty_gate_payload(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        gate_payload: Mapping[str, Any],
    ) -> None:
        gate_params = decision.model_dump(mode="json").get("params", {})
        params_update: dict[str, Any] = {"runtime_uncertainty_gate": dict(gate_payload)}
        if isinstance(gate_params, Mapping):
            params_update = dict(cast(Mapping[str, Any], gate_params))
            params_update["runtime_uncertainty_gate"] = dict(gate_payload)
        self.executor.update_decision_params(session, decision_row, params_update)

    def _recheck_runtime_uncertainty_gate_after_llm(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        positions: list[dict[str, Any]],
        gate_payload: dict[str, Any],
    ) -> str | None:
        gate_action = str(gate_payload.get("action") or "pass").strip().lower()
        if gate_action not in {"abstain", "fail"}:
            return None
        risk_increasing_entry = _is_runtime_risk_increasing_entry(decision, positions)
        gate_payload["risk_increasing_entry"] = risk_increasing_entry
        if not risk_increasing_entry:
            gate_payload["entry_blocked"] = False
            gate_payload["block_reason"] = None
            self._persist_runtime_uncertainty_gate_payload(
                session=session,
                decision=decision,
                decision_row=decision_row,
                gate_payload=gate_payload,
            )
            return None
        reason = (
            "runtime_uncertainty_gate_fail_block_new_entries"
            if gate_action == "fail"
            else "runtime_uncertainty_gate_abstain_block_risk_increasing_entries"
        )
        gate_payload["entry_blocked"] = True
        gate_payload["block_reason"] = reason
        self._persist_runtime_uncertainty_gate_payload(
            session=session,
            decision=decision,
            decision_row=decision_row,
            gate_payload=gate_payload,
        )
        return reason

    def _record_decision_rejection(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        reasons: list[str],
        log_template: str,
    ) -> None:
        if not reasons:
            return
        self.state.metrics.orders_rejected_total += 1
        for reason in reasons:
            logger.info(log_template, decision.strategy_id, decision.symbol, reason)
        self.executor.mark_rejected(session, decision_row, ";".join(reasons))

    def _evaluate_execution_policy_outcome(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        positions: list[dict[str, Any]],
        snapshot: Optional[MarketSnapshot],
    ) -> tuple[StrategyDecision, Any] | None:
        regime_label, regime_source, regime_fallback = _resolve_decision_regime_label_with_source(
            decision
        )
        self.state.metrics.record_decision_regime_resolution(
            source=regime_source,
            fallback_reason=regime_fallback,
        )
        adaptive_policy = derive_adaptive_execution_policy(
            session,
            symbol=decision.symbol,
            regime_label=regime_label,
        )
        policy_outcome = self.execution_policy.evaluate(
            decision,
            strategy=strategy,
            positions=positions,
            market_snapshot=snapshot,
            kill_switch_enabled=self.order_firewall.status().kill_switch_enabled,
            adaptive_policy=adaptive_policy,
        )
        decision = policy_outcome.decision
        self.executor.update_decision_params(
            session, decision_row, policy_outcome.params_update()
        )
        self.state.metrics.record_execution_advisor_result(
            policy_outcome.advisor_metadata
        )
        self.state.metrics.record_adaptive_policy_result(
            adaptive_policy,
            applied=bool(
                policy_outcome.adaptive is not None and policy_outcome.adaptive.applied
            ),
        )
        if not policy_outcome.approved:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=list(policy_outcome.reasons),
                log_template=(
                    "Decision rejected by execution policy strategy_id=%s symbol=%s reason=%s"
                ),
            )
            return None
        return decision, policy_outcome

    def _passes_risk_verdict(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        symbol_allowlist: set[str],
        execution_advisor: Mapping[str, Any] | None,
    ) -> bool:
        verdict = self.risk_engine.evaluate(
            session,
            decision,
            strategy,
            account,
            positions,
            symbol_allowlist,
            execution_advisor=execution_advisor,
        )
        if verdict.approved:
            return True
        self._record_decision_rejection(
            session=session,
            decision=decision,
            decision_row=decision_row,
            reasons=list(verdict.reasons),
            log_template="Decision rejected strategy_id=%s symbol=%s reason=%s",
        )
        return False

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        if not settings.trading_enabled:
            return False
        if not (
            settings.trading_emergency_stop_enabled and self.state.emergency_stop_active
        ):
            return True
        self.state.metrics.orders_rejected_total += 1
        reason = self.state.emergency_stop_reason or "emergency_stop_active"
        self.executor.mark_rejected(session, decision_row, reason)
        logger.error(
            "Decision blocked by emergency stop strategy_id=%s decision_id=%s symbol=%s reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            reason,
        )
        return False

    def _submit_decision_execution(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        policy_outcome: Any,
        symbol_allowlist: set[str],
    ) -> bool:
        execution_client = self._execution_client_for_symbol(
            decision.symbol,
            symbol_allowlist=symbol_allowlist,
        )
        selected_adapter_name = self._execution_client_name(execution_client)
        self._maybe_record_lean_strategy_shadow(
            session=session,
            decision=decision,
            execution_client=execution_client,
            selected_adapter_name=selected_adapter_name,
        )
        self.state.metrics.record_execution_request(selected_adapter_name)
        self.executor.update_decision_params(
            session,
            decision_row,
            {
                "execution_adapter": {
                    "selected": selected_adapter_name,
                    "policy": settings.trading_execution_adapter_policy,
                    "symbol": decision.symbol,
                }
            },
        )

        execution, rejected = self._submit_order_with_handling(
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            selected_adapter_name=selected_adapter_name,
            retry_delays=policy_outcome.retry_delays,
        )
        if rejected:
            return False
        if execution is None:
            self._sync_lean_observability(execution_client)
            self.state.metrics.orders_submitted_total += 1
            return True

        actual_adapter_name = str(
            getattr(execution_client, "last_route", selected_adapter_name)
        )
        if actual_adapter_name == "alpaca_fallback":
            actual_adapter_name = "alpaca"
        self._handle_execution_fallback(
            session=session,
            decision=decision,
            decision_row=decision_row,
            execution=execution,
            selected_adapter_name=selected_adapter_name,
            actual_adapter_name=actual_adapter_name,
        )
        self._record_lean_shadow_from_execution(execution)
        self._sync_lean_observability(execution_client)
        self.state.metrics.orders_submitted_total += 1
        logger.info(
            "Order submitted strategy_id=%s decision_id=%s symbol=%s adapter=%s alpaca_order_id=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            actual_adapter_name,
            execution.alpaca_order_id,
        )
        return True

    def _maybe_record_lean_strategy_shadow(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        execution_client: Any,
        selected_adapter_name: str,
    ) -> None:
        if selected_adapter_name != "lean":
            return
        if not settings.trading_lean_strategy_shadow_enabled:
            return
        if settings.trading_lean_lane_disable_switch:
            return
        evaluator = getattr(execution_client, "evaluate_strategy_shadow", None)
        if not callable(evaluator):
            return
        try:
            strategy_shadow = evaluator(
                {
                    "strategy_id": decision.strategy_id,
                    "symbol": decision.symbol,
                    "action": decision.action,
                    "qty": str(decision.qty),
                    "order_type": decision.order_type,
                    "time_in_force": decision.time_in_force,
                }
            )
            if not isinstance(strategy_shadow, Mapping):
                return
            shadow_map = cast(Mapping[str, Any], strategy_shadow)
            parity_status = str(shadow_map.get("parity_status") or "unknown")
            self.state.metrics.record_lean_strategy_shadow(parity_status)
            self.lean_lane_manager.record_strategy_shadow(
                session,
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                intent={
                    "action": decision.action,
                    "qty": str(decision.qty),
                    "order_type": decision.order_type,
                    "time_in_force": decision.time_in_force,
                },
                shadow_result=shadow_map,
            )
        except Exception as exc:
            logger.warning(
                "LEAN strategy shadow evaluation failed strategy_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision.symbol,
                exc,
            )
            self.state.metrics.record_lean_strategy_shadow("error")

    def _submit_order_with_handling(
        self,
        *,
        session: Session,
        execution_client: Any,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        retry_delays: list[int],
    ) -> tuple[Any | None, bool]:
        try:
            retry_delays_seconds = [float(delay) for delay in retry_delays]
            execution = self.executor.submit_order(
                session,
                execution_client,
                decision,
                decision_row,
                self.account_label,
                execution_expected_adapter=selected_adapter_name,
                retry_delays=retry_delays_seconds,
            )
            return execution, False
        except OrderFirewallBlocked as exc:
            self.state.metrics.orders_rejected_total += 1
            self.executor.mark_rejected(session, decision_row, str(exc))
            logger.warning(
                "Order blocked by firewall strategy_id=%s decision_id=%s symbol=%s reason=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                exc,
            )
            return None, True
        except Exception as exc:
            self.state.metrics.orders_rejected_total += 1
            payload = _extract_json_error_payload(exc) or {}
            existing_order_id = payload.get("existing_order_id")
            if existing_order_id:
                try:
                    self.order_firewall.cancel_order(str(existing_order_id))
                    logger.info(
                        "Canceled conflicting Alpaca order decision_id=%s existing_order_id=%s",
                        decision_row.id,
                        existing_order_id,
                    )
                except Exception:
                    logger.exception(
                        "Failed to cancel conflicting Alpaca order decision_id=%s existing_order_id=%s",
                        decision_row.id,
                        existing_order_id,
                    )
            reason = _format_order_submit_rejection(exc)
            self.executor.mark_rejected(session, decision_row, reason)
            logger.warning(
                "Order submission failed strategy_id=%s decision_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                exc,
            )
            return None, True

    def _handle_execution_fallback(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        execution: Any,
        selected_adapter_name: str,
        actual_adapter_name: str,
    ) -> None:
        if actual_adapter_name == selected_adapter_name:
            return
        fallback_reason = execution.execution_fallback_reason
        self.state.metrics.record_execution_fallback(
            expected_adapter=selected_adapter_name,
            actual_adapter=actual_adapter_name,
            fallback_reason=fallback_reason or "adaptive_fallback",
        )
        self._evaluate_lean_canary_guard(session, symbol=decision.symbol)
        self.executor.update_decision_params(
            session,
            decision_row,
            {
                "execution_adapter": {
                    "selected": selected_adapter_name,
                    "actual": actual_adapter_name,
                    "policy": settings.trading_execution_adapter_policy,
                    "symbol": decision.symbol,
                }
            },
        )

    def _record_lean_shadow_from_execution(self, execution: Any) -> None:
        raw_order_payload = getattr(execution, "raw_order", None)
        if not isinstance(raw_order_payload, Mapping):
            return
        raw_order_source = cast(Mapping[object, Any], raw_order_payload)
        raw_order: dict[str, Any] = {
            str(key): value for key, value in raw_order_source.items()
        }
        shadow_event = raw_order.get("_lean_shadow")
        if not isinstance(shadow_event, Mapping):
            return
        shadow_map = cast(Mapping[str, Any], shadow_event)
        parity_status = str(shadow_map.get("parity_status") or "unknown")
        failure_taxonomy = (
            str(shadow_map.get("failure_taxonomy")).strip()
            if shadow_map.get("failure_taxonomy") is not None
            else None
        )
        self.state.metrics.record_lean_shadow(
            parity_status=parity_status,
            failure_taxonomy=failure_taxonomy,
        )

    def _resolve_runtime_uncertainty_gate_components(
        self, decision: StrategyDecision
    ) -> tuple[RuntimeUncertaintyGate, RuntimeUncertaintyGate, RuntimeUncertaintyGate]:
        uncertainty_gate = self._resolve_runtime_uncertainty_gate_from_inputs(decision)
        regime_gate = self._resolve_runtime_regime_gate(decision)
        combined_gate = _select_strictest_runtime_uncertainty_gate(
            [uncertainty_gate, regime_gate]
        )
        return uncertainty_gate, regime_gate, combined_gate

    def _resolve_runtime_uncertainty_gate(
        self, decision: StrategyDecision
    ) -> RuntimeUncertaintyGate:
        _, _, gate = self._resolve_runtime_uncertainty_gate_components(decision)
        return gate

    def _resolve_runtime_uncertainty_gate_from_inputs(
        self, decision: StrategyDecision
    ) -> RuntimeUncertaintyGate:
        params = decision.params
        candidates: list[RuntimeUncertaintyGate] = []
        direct_action = _coerce_runtime_uncertainty_gate_action(
            params.get("uncertainty_gate_action")
        )
        if direct_action is not None:
            candidates.append(
                RuntimeUncertaintyGate(action=direct_action, source="decision_params")
            )

        runtime_payload = params.get("runtime_uncertainty_gate")
        if isinstance(runtime_payload, Mapping):
            runtime_map = cast(Mapping[str, Any], runtime_payload)
            runtime_staleness_reason = _uncertainty_gate_staleness_reason(
                "decision_runtime_payload", runtime_map
            )
            if runtime_staleness_reason is not None:
                candidates.append(
                    RuntimeUncertaintyGate(
                        action="abstain",
                        source="decision_runtime_payload_stale",
                        reason=runtime_staleness_reason,
                    )
                )
            else:
                runtime_action = _coerce_runtime_uncertainty_gate_action(
                    runtime_map.get("action")
                )
                if runtime_action is not None:
                    candidates.append(
                        RuntimeUncertaintyGate(
                            action=runtime_action,
                            source="decision_runtime_payload",
                        )
                    )

        forecast_audit = params.get("forecast_audit")
        if isinstance(forecast_audit, Mapping):
            audit_map = cast(Mapping[str, Any], forecast_audit)
            forecast_staleness_reason = _uncertainty_gate_staleness_reason(
                "forecast_audit", audit_map
            )
            if forecast_staleness_reason is not None:
                candidates.append(
                    RuntimeUncertaintyGate(
                        action="abstain",
                        source="forecast_audit_stale",
                        reason=forecast_staleness_reason,
                    )
                )
            else:
                audit_action = _coerce_runtime_uncertainty_gate_action(
                    audit_map.get("uncertainty_gate_action")
                )
                if audit_action is not None:
                    candidates.append(
                        RuntimeUncertaintyGate(
                            action=audit_action,
                            source="forecast_audit",
                        )
                    )

        gate_path_raw = self.state.last_autonomy_gates
        if gate_path_raw:
            try:
                payload = json.loads(Path(gate_path_raw).read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning(
                    "Failed to read autonomy gate report path=%s error=%s",
                    gate_path_raw,
                    exc,
                )
                candidates.append(
                    RuntimeUncertaintyGate(
                        action="abstain",
                        source="autonomy_gate_report_read_error",
                        reason="autonomy_gate_report_read_error",
                    )
                )
            else:
                if isinstance(payload, Mapping):
                    gate_map = cast(Mapping[str, Any], payload)
                    staleness_reason = _uncertainty_gate_staleness_reason(
                        "autonomy_gate_report", gate_map
                    )
                    if staleness_reason is not None:
                        candidates.append(
                            RuntimeUncertaintyGate(
                                action="abstain",
                                source="autonomy_gate_report_stale",
                                reason=staleness_reason,
                            )
                        )
                        return _select_strictest_runtime_uncertainty_gate(candidates)
                    gate_action = _coerce_runtime_uncertainty_gate_action(
                        gate_map.get("uncertainty_gate_action")
                    )
                    if gate_action is not None:
                        candidates.append(
                            RuntimeUncertaintyGate(
                                action=gate_action,
                                source="autonomy_gate_report",
                                coverage_error=_optional_decimal(
                                    gate_map.get("coverage_error")
                                ),
                                shift_score=_optional_decimal(
                                    gate_map.get("shift_score")
                                ),
                                conformal_interval_width=_optional_decimal(
                                    gate_map.get("conformal_interval_width")
                                ),
                            )
                        )
                    else:
                        candidates.append(
                            RuntimeUncertaintyGate(
                                action="abstain",
                                source="autonomy_gate_report_missing_action",
                                reason="autonomy_gate_report_missing_action",
                            )
                        )
                else:
                    candidates.append(
                        RuntimeUncertaintyGate(
                            action="abstain",
                            source="autonomy_gate_report_invalid_payload",
                            reason="autonomy_gate_report_invalid_payload",
                        )
                    )
        if not candidates:
            candidates.append(
                RuntimeUncertaintyGate(action="degrade", source="uncertainty_input_missing")
            )
        return _select_strictest_runtime_uncertainty_gate(candidates)

    def _resolve_runtime_regime_gate(self, decision: StrategyDecision) -> RuntimeUncertaintyGate:
        params = decision.params

        regime_gate = params.get("regime_gate")
        if regime_gate is not None:
            if isinstance(regime_gate, Mapping):
                gate_map = cast(Mapping[str, Any], regime_gate)
                gate_action = _coerce_runtime_uncertainty_gate_action(
                    gate_map.get("action")
                )
                if gate_action is not None:
                    return RuntimeUncertaintyGate(
                        action=gate_action,
                        source="decision_regime_gate",
                        regime_action_source="decision_regime_gate",
                        regime_label=(
                            str(gate_map.get("regime_label")).strip()
                            if gate_map.get("regime_label") is not None
                            else None
                        ),
                        regime_stale=_coerce_bool(gate_map.get("regime_stale")),
                        reason=(
                            str(gate_map.get("reason")).strip()
                            if gate_map.get("reason") is not None
                            else None
                        ),
                    )
                return RuntimeUncertaintyGate(
                    action="abstain",
                    source="decision_regime_gate_invalid_action",
                    regime_action_source="decision_regime_gate",
                    reason="decision_regime_gate_invalid_action",
                )
            return RuntimeUncertaintyGate(
                action="abstain",
                source="decision_regime_gate_unparseable",
                regime_action_source="decision_regime_gate",
                reason="decision_regime_gate_unparseable",
            )

        raw_regime_hmm = params.get("regime_hmm")
        if raw_regime_hmm is None:
            regime_label, regime_source, regime_fallback = (
                _resolve_decision_regime_label_with_source(decision)
            )
            if regime_label:
                return RuntimeUncertaintyGate(
                    action="pass",
                    source=regime_source or "decision_params",
                    regime_action_source=regime_source or "decision_params",
                    regime_label=regime_label,
                    reason=regime_fallback,
                )
            return RuntimeUncertaintyGate(
                action="degrade",
                source=regime_fallback or "regime_input_missing",
                regime_action_source=regime_fallback or "regime_input_missing",
                reason=regime_fallback or "regime_input_missing",
            )

        if not isinstance(raw_regime_hmm, Mapping):
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_unparseable",
                regime_action_source="regime_hmm_unparseable",
                reason="regime_hmm_unparseable_payload",
            )

        try:
            regime_context = resolve_hmm_context(cast(Mapping[str, Any], raw_regime_hmm))
        except Exception as exc:
            logger.warning(
                "Failed to parse decision regime_hmm payload source=%s error=%s",
                params.get("strategy_id") or "strategy",
                exc,
            )
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_parse_error",
                regime_action_source="regime_hmm_parse_error",
                reason="regime_hmm_parse_error",
            )

        regime_label, _, regime_fallback = _resolve_decision_regime_label_with_source(
            decision
        )
        regime_stale = bool(
            regime_context.guardrail.stale or regime_context.guardrail.fallback_to_defensive
        )
        regime_label = regime_label or regime_context.regime_id
        if regime_context.transition_shock:
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_transition_shock",
                regime_action_source="regime_hmm",
                regime_label=regime_label,
                regime_stale=regime_stale,
                reason="regime_context_transition_shock",
            )
        if regime_stale:
            return RuntimeUncertaintyGate(
                action="abstain",
                source="regime_hmm_stale",
                regime_action_source="regime_hmm",
                regime_label=regime_label,
                regime_stale=True,
                reason=(
                    regime_context.guardrail_reason
                    or "regime_context_guardrail_stale"
                ),
            )
        if not regime_context.is_authoritative:
            source = (
                "regime_hmm_unknown_regime"
                if regime_context.authority_reason in {"invalid_regime_id", "missing_regime"}
                else "regime_hmm_non_authoritative"
            )
            return RuntimeUncertaintyGate(
                action="abstain",
                source=source,
                regime_action_source="regime_hmm",
                regime_stale=regime_stale,
                reason=(
                    regime_fallback
                    if regime_fallback is not None
                    else regime_context.authority_reason or "regime_hmm_non_authoritative"
                ),
            )
        return RuntimeUncertaintyGate(
            action="pass",
            source="regime_hmm",
            regime_action_source="regime_hmm",
            regime_label=regime_label or regime_context.regime_id,
            regime_stale=regime_stale,
        )

    def _apply_runtime_uncertainty_gate(
        self,
        decision: StrategyDecision,
        *,
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, dict[str, Any], str | None]:
        uncertainty_gate, regime_gate, gate = (
            self._resolve_runtime_uncertainty_gate_components(decision)
        )
        risk_increasing_entry = _is_runtime_risk_increasing_entry(decision, positions)
        payload: dict[str, Any] = {
            "action": gate.action,
            "source": gate.source,
            "uncertainty_gate": uncertainty_gate.to_payload(),
            "regime_gate": regime_gate.to_payload(),
            "risk_increasing_entry": risk_increasing_entry,
            "entry_blocked": False,
            "block_reason": None,
            "degrade_qty_multiplier": None,
            "max_participation_rate_override": None,
            "min_execution_seconds": None,
            "coverage_error": (
                str(uncertainty_gate.coverage_error)
                if uncertainty_gate.coverage_error is not None
                else None
            ),
            "shift_score": (
                str(uncertainty_gate.shift_score)
                if uncertainty_gate.shift_score is not None
                else None
            ),
            "conformal_interval_width": (
                str(uncertainty_gate.conformal_interval_width)
                if uncertainty_gate.conformal_interval_width is not None
                else None
            ),
        }
        if gate.action == "pass":
            return decision, payload, None
        if gate.action in {"abstain", "fail"}:
            if risk_increasing_entry:
                reason = (
                    "runtime_uncertainty_gate_fail_block_new_entries"
                    if gate.action == "fail"
                    else "runtime_uncertainty_gate_abstain_block_risk_increasing_entries"
                )
                payload["entry_blocked"] = True
                payload["block_reason"] = reason
                payload["regime_action_blocked"] = (
                    regime_gate.source
                    if regime_gate.action in {"abstain", "fail"}
                    else None
                )
                payload["uncertainty_action_blocked"] = (
                    uncertainty_gate.source
                    if uncertainty_gate.action in {"abstain", "fail"}
                    else None
                )
                return decision, payload, reason
            return decision, payload, None

        params = dict(decision.params)
        allocator = _coerce_json(params.get("allocator"))
        current_override = _optional_decimal(
            allocator.get("max_participation_rate_override")
        )
        if (
            current_override is None
            or current_override > _RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE
        ):
            allocator["max_participation_rate_override"] = str(
                _RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE
            )
        params["allocator"] = allocator
        execution_seconds = _optional_int(params.get("execution_seconds"))
        if (
            execution_seconds is None
            or execution_seconds < _RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS
        ):
            params["execution_seconds"] = (
                _RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS
            )

        qty = _optional_decimal(decision.qty)
        adjusted_qty = decision.qty
        if qty is not None and qty > 0:
            scaled = (qty * _RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER).quantize(
                Decimal("1")
            )
            adjusted_qty = max(Decimal("1"), scaled)
        payload["degrade_qty_multiplier"] = str(
            _RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER
        )
        payload["max_participation_rate_override"] = str(
            _RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE
        )
        payload["min_execution_seconds"] = (
            _RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS
        )
        payload["adjusted_qty"] = str(adjusted_qty)
        return (
            decision.model_copy(update={"qty": adjusted_qty, "params": params}),
            payload,
            None,
        )

    def _execution_client_for_symbol(
        self,
        symbol: str,
        *,
        symbol_allowlist: set[str] | None = None,
    ) -> Any:
        if adapter_enabled_for_symbol(symbol, allowlist=symbol_allowlist):
            return self.execution_adapter
        return self.order_firewall

    @staticmethod
    def _execution_client_name(client: Any) -> str:
        raw_name = getattr(client, "name", None)
        if raw_name:
            return str(raw_name)
        if isinstance(client, OrderFirewall):
            return "alpaca"
        return type(client).__name__

    def _sync_lean_observability(self, execution_client: Any) -> None:
        snapshot_getter = getattr(execution_client, "get_observability_snapshot", None)
        if not callable(snapshot_getter):
            return
        try:
            snapshot = snapshot_getter()
        except Exception as exc:
            logger.warning("Failed to read LEAN observability snapshot: %s", exc)
            return
        if isinstance(snapshot, Mapping):
            self.state.metrics.record_lean_observability(
                cast(Mapping[str, Any], snapshot)
            )

    def _evaluate_lean_canary_guard(self, session: Session, *, symbol: str) -> None:
        if settings.trading_mode != "live":
            return
        if not settings.trading_lean_live_canary_enabled:
            return
        if settings.trading_lean_lane_disable_switch:
            return

        lean_total = self.state.metrics.execution_requests_total.get("lean", 0)
        fallback_total = self.state.metrics.execution_fallback_total.get(
            "lean->alpaca", 0
        )
        if lean_total <= 0:
            return
        ratio = fallback_total / lean_total
        if ratio <= settings.trading_lean_live_canary_fallback_ratio_limit:
            return

        self.state.metrics.record_lean_canary_breach("fallback_ratio_exceeded")
        evidence = {
            "symbol": symbol,
            "fallback_ratio": ratio,
            "fallback_total": fallback_total,
            "lean_total": lean_total,
            "threshold": settings.trading_lean_live_canary_fallback_ratio_limit,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
        incident_key = hashlib.sha256(
            json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:24]
        incident = self.lean_lane_manager.record_canary_incident(
            session,
            incident_key=incident_key,
            breach_type="fallback_ratio_exceeded",
            severity="critical",
            symbols=[symbol],
            evidence=evidence,
            rollback_triggered=settings.trading_lean_live_canary_hard_rollback_enabled,
        )
        self.state.rollback_incidents_total += 1
        self.state.rollback_incident_evidence_path = (
            f"postgres://lean_canary_incidents/{incident.incident_key}"
        )

        if not settings.trading_lean_live_canary_hard_rollback_enabled:
            return
        self.state.emergency_stop_active = True
        self.state.emergency_stop_reason = (
            f"lean_canary_breach:fallback_ratio_exceeded:{ratio:.4f}"
        )
        self.state.emergency_stop_triggered_at = datetime.now(timezone.utc)

    def _apply_portfolio_sizing(
        self,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> PortfolioSizingResult:
        equity = _optional_decimal(account.get("equity"))
        sizer = sizer_from_settings(strategy, equity)
        return sizer.size(decision, account=account, positions=positions)

    @staticmethod
    def _load_strategies(session: Session) -> list[Strategy]:
        stmt = select(Strategy).where(Strategy.enabled.is_(True))
        return list(session.execute(stmt).scalars().all())

    def _apply_llm_review(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[str]]:
        if not settings.llm_enabled:
            return decision, None

        guardrails = evaluate_llm_guardrails()
        policy_resolution = _build_llm_policy_resolution(
            rollout_stage=guardrails.rollout_stage,
            effective_fail_mode=guardrails.effective_fail_mode,
            guardrail_reasons=guardrails.reasons,
        )
        self._record_llm_policy_resolution_metrics(policy_resolution)

        if settings.llm_dspy_runtime_mode == "active":
            dspy_gate_allowed, dspy_gate_reasons = (
                settings.llm_dspy_live_runtime_gate()
            )
            if not dspy_gate_allowed:
                return self._handle_llm_dspy_live_runtime_block(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    account=account,
                    positions=positions,
                    reason="llm_dspy_live_runtime_gate_blocked",
                    risk_flags=list(dspy_gate_reasons),
                    policy_resolution=_build_llm_policy_resolution(
                        rollout_stage=guardrails.rollout_stage,
                        effective_fail_mode="veto",
                        guardrail_reasons=tuple(guardrails.reasons)
                        + tuple(dspy_gate_reasons),
                    ),
                )

        guardrail_block = self._handle_llm_guardrail_block(
            session=session,
            decision=decision,
            decision_row=decision_row,
            account=account,
            positions=positions,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
        )
        if guardrail_block is not None:
            return guardrail_block

        engine = self.llm_review_engine or LLMReviewEngine()
        circuit_open = self._handle_llm_circuit_open(
            session=session,
            decision=decision,
            decision_row=decision_row,
            account=account,
            positions=positions,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
            engine=engine,
        )
        if circuit_open is not None:
            return circuit_open

        request_json: dict[str, Any] = {}
        try:
            return self._run_llm_review_request(
                session=session,
                decision=decision,
                decision_row=decision_row,
                account=account,
                positions=positions,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
                engine=engine,
                request_json=request_json,
            )
        except Exception as exc:
            return self._handle_llm_review_error(
                session=session,
                decision=decision,
                decision_row=decision_row,
                guardrails=guardrails,
                policy_resolution=policy_resolution,
                engine=engine,
                request_json=request_json,
                error=exc,
            )

    def _record_llm_policy_resolution_metrics(
        self, policy_resolution: Mapping[str, Any]
    ) -> None:
        self.state.metrics.record_llm_policy_resolution(
            cast(str | None, policy_resolution.get("classification"))
        )
        if bool(policy_resolution.get("stage_policy_violation")):
            self.state.metrics.llm_stage_policy_violation_total += 1
        if bool(policy_resolution.get("fail_mode_exception_active")):
            self.state.metrics.llm_fail_mode_exception_total += 1
            return
        if bool(policy_resolution.get("fail_mode_violation_active")):
            self.state.metrics.llm_fail_mode_override_total += 1

    def _handle_llm_guardrail_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        if guardrails.allow_requests:
            return None
        self.state.metrics.llm_guardrail_block_total += 1
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason="llm_guardrail_blocked",
            shadow_mode=True,
            effective_fail_mode=guardrails.effective_fail_mode,
            risk_flags=list(guardrails.reasons),
            market_context=None,
            policy_resolution=policy_resolution,
        )

    def _handle_llm_circuit_open(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        if not engine.circuit_breaker.is_open():
            return None
        self.state.metrics.llm_circuit_open_total += 1
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason="llm_circuit_open",
            shadow_mode=guardrails.shadow_mode,
            effective_fail_mode=guardrails.effective_fail_mode,
            market_context=None,
            policy_resolution=policy_resolution,
        )

    def _handle_llm_dspy_live_runtime_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        reason: str,
        risk_flags: list[str],
        policy_resolution: Optional[dict[str, Any]] = None,
    ) -> tuple[StrategyDecision, Optional[str]]:
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason=reason,
            shadow_mode=False,
            effective_fail_mode="veto",
            risk_flags=risk_flags,
            market_context=None,
            policy_resolution=policy_resolution,
        )

    def _run_llm_review_request(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
        request_json: dict[str, Any],
    ) -> tuple[StrategyDecision, Optional[str]]:
        self.state.metrics.llm_requests_total += 1
        market_context, market_context_error = self._fetch_market_context(
            decision.symbol
        )
        if market_context_error is not None:
            self.state.metrics.llm_market_context_error_total += 1

        portfolio_snapshot = _build_portfolio_snapshot(account, positions)
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = _load_recent_decisions(
            session,
            decision.strategy_id,
            decision.symbol,
        )
        market_context_block = self._maybe_handle_market_context_block(
            session=session,
            decision=decision,
            decision_row=decision_row,
            account=account,
            positions=positions,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
            market_context=market_context,
            market_context_error=market_context_error,
        )
        if market_context_block is not None:
            return market_context_block

        request = engine.build_request(
            decision,
            account,
            positions,
            portfolio_snapshot,
            market_snapshot,
            market_context,
            recent_decisions,
            adjustment_allowed=guardrails.adjustment_allowed,
        )
        request_json.update(request.model_dump(mode="json"))
        outcome = engine.review(
            decision,
            account,
            positions,
            request=request,
            portfolio=portfolio_snapshot,
            market=market_snapshot,
            market_context=market_context,
            recent_decisions=recent_decisions,
        )
        self._record_llm_verdict_counter(outcome.response.verdict)
        policy_outcome = apply_policy(
            decision,
            outcome.response,
            adjustment_allowed=guardrails.adjustment_allowed,
        )
        response_json = self._build_llm_response_json(
            outcome=outcome,
            policy_outcome=policy_outcome,
            guardrails=guardrails,
            policy_resolution=policy_resolution,
        )
        self._record_llm_committee_metrics(response_json)
        self._record_llm_token_metrics(outcome)
        adjusted_qty, adjusted_order_type = self._apply_llm_policy_verdict(
            session=session,
            decision_row=decision_row,
            policy_outcome=policy_outcome,
        )
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=outcome.model,
            prompt_version=outcome.prompt_version,
            request_json=outcome.request_json,
            response_json=response_json,
            verdict=policy_outcome.verdict,
            confidence=outcome.response.confidence,
            adjusted_qty=adjusted_qty,
            adjusted_order_type=adjusted_order_type,
            rationale=outcome.response.rationale,
            risk_flags=outcome.response.risk_flags,
            tokens_prompt=outcome.tokens_prompt,
            tokens_completion=outcome.tokens_completion,
        )
        engine.circuit_breaker.record_success()
        return self._finalize_llm_review_outcome(
            decision=decision,
            outcome=outcome,
            policy_outcome=policy_outcome,
            guardrails=guardrails,
        )

    def _maybe_handle_market_context_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        market_context: Optional[MarketContextBundle],
        market_context_error: Optional[str],
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        market_context_status = evaluate_market_context(market_context)
        if market_context_error is not None:
            market_context_status = MarketContextStatus(
                allow_llm=False,
                reason="market_context_fetch_error",
                risk_flags=["market_context_fetch_error"],
            )
        if market_context_status.allow_llm:
            return None

        self.state.metrics.llm_market_context_block_total += 1
        market_context_shadow_mode = (
            guardrails.shadow_mode
            or settings.trading_market_context_fail_mode == "shadow_only"
        )
        self.state.metrics.record_market_context_result(
            market_context_status.reason,
            shadow_mode=market_context_shadow_mode,
        )
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason=market_context_status.reason or "market_context_unavailable",
            shadow_mode=market_context_shadow_mode,
            effective_fail_mode=guardrails.effective_fail_mode,
            risk_flags=market_context_status.risk_flags,
            market_context=market_context,
            policy_resolution=policy_resolution,
        )

    def _record_llm_verdict_counter(self, verdict: str) -> None:
        if verdict == "abstain":
            self.state.metrics.llm_abstain_total += 1
            return
        if verdict == "escalate":
            self.state.metrics.llm_escalate_total += 1

    def _build_llm_response_json(
        self,
        *,
        outcome: Any,
        policy_outcome: Any,
        guardrails: Any,
        policy_resolution: dict[str, Any],
    ) -> dict[str, Any]:
        response_json: dict[str, Any] = dict(outcome.response_json)
        response_json["advisory_only"] = True
        response_json["request_hash"] = outcome.request_hash
        response_json["response_hash"] = outcome.response_hash
        if policy_outcome.reason:
            response_json["policy_override"] = policy_outcome.reason
            response_json["policy_verdict"] = policy_outcome.verdict
            if "_fallback_" in policy_outcome.reason:
                self.state.metrics.llm_policy_fallback_total += 1
        if policy_outcome.guardrail_reasons:
            response_json["deterministic_guardrails"] = list(
                policy_outcome.guardrail_reasons
            )
        if guardrails.reasons:
            response_json["mrm_guardrails"] = list(guardrails.reasons)
        response_json["policy_resolution"] = policy_resolution
        response_json["guardrail_controls"] = _llm_guardrail_controls_snapshot()
        return response_json

    def _record_llm_committee_metrics(self, response_json: Mapping[str, Any]) -> None:
        committee_payload = response_json.get("committee")
        if not isinstance(committee_payload, Mapping):
            return
        committee_roles = cast(Mapping[str, Any], committee_payload).get("roles", {})
        if not isinstance(committee_roles, Mapping):
            return
        for role, role_payload in cast(Mapping[str, Any], committee_roles).items():
            if not isinstance(role_payload, Mapping):
                continue
            role_data = cast(Mapping[str, Any], role_payload)
            self.state.metrics.record_llm_committee_member(
                role=str(role),
                verdict=str(role_data.get("verdict", "unknown")),
                latency_ms=_optional_int(role_data.get("latency_ms")),
                schema_error=bool(role_data.get("schema_error", False)),
            )

    def _record_llm_token_metrics(self, outcome: Any) -> None:
        if outcome.tokens_prompt is not None:
            self.state.metrics.llm_tokens_prompt_total += outcome.tokens_prompt
        if outcome.tokens_completion is not None:
            self.state.metrics.llm_tokens_completion_total += outcome.tokens_completion

    def _apply_llm_policy_verdict(
        self,
        *,
        session: Session,
        decision_row: TradeDecision,
        policy_outcome: Any,
    ) -> tuple[Optional[Decimal], Optional[str]]:
        if policy_outcome.verdict == "adjust":
            self.state.metrics.llm_adjust_total += 1
            adjusted_qty = Decimal(str(policy_outcome.decision.qty))
            adjusted_order_type = policy_outcome.decision.order_type
            self._persist_llm_adjusted_decision(
                session, decision_row, policy_outcome.decision
            )
            return adjusted_qty, adjusted_order_type
        if policy_outcome.verdict == "approve":
            self.state.metrics.llm_approve_total += 1
            return None, None
        if policy_outcome.verdict == "veto":
            self.state.metrics.llm_veto_total += 1
        return None, None

    def _finalize_llm_review_outcome(
        self,
        *,
        decision: StrategyDecision,
        outcome: Any,
        policy_outcome: Any,
        guardrails: Any,
    ) -> tuple[StrategyDecision, Optional[str]]:
        if guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if policy_outcome.verdict != "veto":
            return policy_outcome.decision, None
        self.state.metrics.record_llm_committee_veto_alignment(
            committee_veto=bool(outcome.response.committee),
            deterministic_veto=True,
        )
        return decision, policy_outcome.reason or "llm_veto"

    def _handle_llm_review_error(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
        request_json: dict[str, Any],
        error: Exception,
    ) -> tuple[StrategyDecision, Optional[str]]:
        self.state.metrics.llm_error_total += 1
        unsupported_state_error = isinstance(
            error, DSPyRuntimeUnsupportedStateError
        )
        if not unsupported_state_error:
            engine.circuit_breaker.record_error()
        if unsupported_state_error:
            policy_resolution = _build_llm_policy_resolution(
                rollout_stage=guardrails.rollout_stage,
                effective_fail_mode="veto",
                guardrail_reasons=guardrails.reasons,
            )
        error_label = _classify_llm_error(error)
        if error_label == "llm_response_not_json":
            self.state.metrics.llm_parse_error_total += 1
        elif error_label == "llm_response_invalid":
            self.state.metrics.llm_validation_error_total += 1

        fallback = (
            "veto"
            if unsupported_state_error
            else self._resolve_llm_fallback(guardrails.effective_fail_mode)
        )
        effective_verdict = "veto" if fallback == "veto" else "approve"
        if not request_json:
            request_json = {"decision": decision.model_dump(mode="json")}
        response_json: dict[str, Any] = {
            "error": str(error),
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "policy_resolution": policy_resolution,
            "guardrail_controls": _llm_guardrail_controls_snapshot(),
            "advisory_only": True,
        }
        if guardrails.reasons:
            response_json["mrm_guardrails"] = list(guardrails.reasons)
        response_json["request_hash"] = _hash_payload(request_json)
        response_json["response_hash"] = _hash_payload(response_json)
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=self._llm_runtime_model_identifier(),
            prompt_version=self._llm_runtime_prompt_identifier(),
            request_json=request_json,
            response_json=response_json,
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=f"llm_error_{fallback}",
            risk_flags=[type(error).__name__] + list(guardrails.reasons),
            tokens_prompt=None,
            tokens_completion=None,
        )
        if unsupported_state_error:
            logger.warning(
                "Unsupported DSPy runtime state; vetoing decision_id=%s error=%s",
                decision_row.id,
                error,
            )
            return decision, "llm_error"
        if guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            logger.warning(
                "LLM review failed; vetoing decision_id=%s error=%s",
                decision_row.id,
                error,
            )
            return decision, "llm_error"
        logger.warning(
            "LLM review failed; pass-through decision_id=%s error=%s",
            decision_row.id,
            error,
        )
        return decision, None

    def _handle_llm_unavailable(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        reason: str,
        shadow_mode: bool,
        effective_fail_mode: Optional[str] = None,
        risk_flags: Optional[list[str]] = None,
        market_context: Optional[MarketContextBundle] = None,
        policy_resolution: Optional[dict[str, Any]] = None,
    ) -> tuple[StrategyDecision, Optional[str]]:
        fallback = self._resolve_llm_fallback(effective_fail_mode)
        effective_verdict = "veto" if fallback == "veto" else "approve"
        portfolio_snapshot = _build_portfolio_snapshot(account, positions)
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = _load_recent_decisions(
            session,
            decision.strategy_id,
            decision.symbol,
        )
        engine = self.llm_review_engine or LLMReviewEngine()
        request_payload = engine.build_request(
            decision=decision,
            account=account,
            positions=positions,
            portfolio=portfolio_snapshot,
            market=market_snapshot,
            market_context=market_context,
            recent_decisions=recent_decisions,
        ).model_dump(mode="json")
        response_payload = {
            "error": reason,
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "policy_resolution": policy_resolution
            or _build_llm_policy_resolution(
                rollout_stage=_normalize_rollout_stage(settings.llm_rollout_stage),
                effective_fail_mode=fallback,
                guardrail_reasons=risk_flags or [],
            ),
            "advisory_only": True,
        }
        response_payload["request_hash"] = _hash_payload(request_payload)
        response_payload["response_hash"] = _hash_payload(response_payload)
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=self._llm_runtime_model_identifier(),
            prompt_version=self._llm_runtime_prompt_identifier(),
            request_json=request_payload,
            response_json={
                "error": reason,
                "fallback": fallback,
                "effective_verdict": effective_verdict,
                "policy_resolution": policy_resolution
                or _build_llm_policy_resolution(
                    rollout_stage=_normalize_rollout_stage(settings.llm_rollout_stage),
                    effective_fail_mode=fallback,
                    guardrail_reasons=risk_flags or [],
                ),
                "guardrail_controls": _llm_guardrail_controls_snapshot(),
            },
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=reason,
            risk_flags=[reason] + (risk_flags or []),
            tokens_prompt=None,
            tokens_completion=None,
        )
        if shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            return decision, "llm_error"
        return decision, None

    def _build_market_snapshot(
        self, decision: StrategyDecision
    ) -> Optional[LLMMarketSnapshot]:
        params = decision.params or {}
        price = params.get("price") or params.get("close")
        spread: Optional[Any] = None
        source = "decision_params"
        snapshot_payload = params.get("price_snapshot")
        if price is None and isinstance(snapshot_payload, Mapping):
            snapshot_data = cast(Mapping[str, Any], snapshot_payload)
            price = snapshot_data.get("price")
            if spread is None:
                spread = snapshot_data.get("spread")
            payload_source = snapshot_data.get("source")
            if payload_source is not None:
                source = str(payload_source)
        imbalance = params.get("imbalance")
        if isinstance(imbalance, Mapping):
            imbalance_data = cast(Mapping[str, Any], imbalance)
            spread = imbalance_data.get("spread")
        snapshot = None
        if price is not None:
            snapshot = MarketSnapshot(
                symbol=decision.symbol,
                as_of=decision.event_ts,
                price=_optional_decimal(price),
                spread=_optional_decimal(spread),
                source=source,
            )
        else:
            snapshot = self.price_fetcher.fetch_market_snapshot(
                SignalEnvelope(
                    event_ts=decision.event_ts,
                    symbol=decision.symbol,
                    payload={},
                    timeframe=decision.timeframe,
                )
            )
        if snapshot is None:
            return None
        return LLMMarketSnapshot(
            symbol=snapshot.symbol,
            as_of=snapshot.as_of,
            price=snapshot.price,
            spread=snapshot.spread,
            source=snapshot.source,
        )

    def _ensure_decision_price(
        self, decision: StrategyDecision, signal_price: Any
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]]:
        if signal_price is not None and "price_snapshot" in decision.params:
            return decision, None
        snapshot = self.price_fetcher.fetch_market_snapshot(
            SignalEnvelope(
                event_ts=decision.event_ts,
                symbol=decision.symbol,
                payload={},
                timeframe=decision.timeframe,
            )
        )
        if snapshot is None or snapshot.price is None:
            return decision, None
        updated_params = dict(decision.params)
        if signal_price is None:
            updated_params["price"] = snapshot.price
        updated_params["price_snapshot"] = _price_snapshot_payload(snapshot)
        if snapshot.spread is not None and "spread" not in updated_params:
            updated_params["spread"] = snapshot.spread
        return decision.model_copy(update={"params": updated_params}), snapshot

    @staticmethod
    def _resolve_llm_fallback(effective_fail_mode: Optional[str] = None) -> str:
        if effective_fail_mode in {"veto", "pass_through"}:
            return effective_fail_mode
        return settings.llm_effective_fail_mode()

    @staticmethod
    def _llm_runtime_model_identifier() -> str:
        return f"dspy:{settings.llm_dspy_program_name}"

    @staticmethod
    def _llm_runtime_prompt_identifier() -> str:
        return f"dspy:{settings.llm_dspy_signature_version}"

    def _fetch_market_context(
        self, symbol: str
    ) -> tuple[Optional[MarketContextBundle], Optional[str]]:
        try:
            return self.market_context_client.fetch(symbol), None
        except Exception as exc:
            logger.warning(
                "market context fetch failed symbol=%s error=%s", symbol, exc
            )
            return None, str(exc)

    def _get_account_snapshot(self, session: Session):
        now = datetime.now(timezone.utc)
        snapshot_ttl = timedelta(milliseconds=settings.trading_reconcile_ms)
        if self._snapshot_cache and self._snapshot_cached_at:
            if now - self._snapshot_cached_at < snapshot_ttl:
                return self._snapshot_cache
        # Reuse snapshots within the reconcile interval to reduce Alpaca and DB churn.
        snapshot = snapshot_account_and_positions(
            session, self.alpaca_client, self.account_label
        )
        self._snapshot_cache = snapshot
        self._snapshot_cached_at = now
        return snapshot

    @staticmethod
    def _persist_llm_review(
        session: Session,
        decision_row: TradeDecision,
        model: str,
        prompt_version: str,
        request_json: dict[str, Any],
        response_json: dict[str, Any],
        verdict: str,
        confidence: Optional[float],
        adjusted_qty: Optional[Decimal],
        adjusted_order_type: Optional[str],
        rationale: Optional[str],
        risk_flags: list[str],
        tokens_prompt: Optional[int],
        tokens_completion: Optional[int],
    ) -> None:
        request_payload = coerce_json_payload(request_json)
        response_payload = coerce_json_payload(response_json)
        risk_payload = coerce_json_payload(risk_flags)
        review = LLMDecisionReview(
            trade_decision_id=decision_row.id,
            model=model,
            prompt_version=prompt_version,
            input_json=request_payload,
            response_json=response_payload,
            verdict=verdict,
            confidence=Decimal(str(confidence)) if confidence is not None else None,
            adjusted_qty=adjusted_qty,
            adjusted_order_type=adjusted_order_type,
            rationale=rationale,
            risk_flags=risk_payload,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
        )
        session.add(review)
        session.commit()

    @staticmethod
    def _persist_llm_adjusted_decision(
        session: Session,
        decision_row: TradeDecision,
        decision: StrategyDecision,
    ) -> None:
        decision_json = _coerce_json(decision_row.decision_json)
        decision_json["llm_adjusted_decision"] = coerce_json_payload(
            decision.model_dump(mode="json")
        )
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()


def _coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def _classify_llm_error(error: Exception) -> Optional[str]:
    message = str(error)
    if message == "llm_response_not_json":
        return "llm_response_not_json"
    if message == "llm_response_invalid":
        return "llm_response_invalid"
    return None


def _price_snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


def _build_portfolio_snapshot(
    account: dict[str, str], positions: list[dict[str, Any]]
) -> PortfolioSnapshot:
    equity = _optional_decimal(account.get("equity"))
    cash = _optional_decimal(account.get("cash"))
    buying_power = _optional_decimal(account.get("buying_power"))
    exposure_by_symbol: dict[str, Decimal] = {}
    total_exposure = Decimal("0")
    for position in positions:
        symbol = position.get("symbol")
        if not symbol:
            continue
        market_value = _optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        exposure_by_symbol[symbol] = (
            exposure_by_symbol.get(symbol, Decimal("0")) + market_value
        )
        total_exposure += abs(market_value)
    return PortfolioSnapshot(
        equity=equity,
        cash=cash,
        buying_power=buying_power,
        total_exposure=total_exposure,
        exposure_by_symbol=exposure_by_symbol,
        positions=positions,
    )


def _load_recent_decisions(
    session: Session, strategy_id: str, symbol: str
) -> list[RecentDecisionSummary]:
    if settings.llm_recent_decisions <= 0:
        return []
    stmt = (
        select(TradeDecision)
        .where(TradeDecision.strategy_id == strategy_id)
        .where(TradeDecision.symbol == symbol)
        .order_by(TradeDecision.created_at.desc())
        .limit(settings.llm_recent_decisions)
    )
    decisions = session.execute(stmt).scalars().all()
    summaries: list[RecentDecisionSummary] = []
    for decision in decisions:
        decision_json = _coerce_json(decision.decision_json)
        params_value: object = decision_json.get("params")
        params_map: Mapping[str, Any] = {}
        if isinstance(params_value, Mapping):
            params_map = cast(Mapping[str, Any], params_value)
        price = _optional_decimal(params_map.get("price"))
        if price is None and isinstance(params_map.get("price_snapshot"), Mapping):
            snapshot_map = cast(Mapping[str, Any], params_map.get("price_snapshot"))
            price = _optional_decimal(snapshot_map.get("price"))
        summaries.append(
            RecentDecisionSummary(
                decision_id=str(decision.id),
                strategy_id=str(decision.strategy_id),
                symbol=decision.symbol,
                action=decision_json.get("action", "buy"),
                qty=_optional_decimal(decision_json.get("qty")) or Decimal("0"),
                status=decision.status,
                created_at=decision.created_at,
                rationale=decision.rationale,
                price=price,
            )
        )
    return summaries


def _resolve_signal_regime(signal: SignalEnvelope) -> Optional[str]:
    payload = signal.payload
    payload_map = cast(Mapping[str, Any], payload)
    macd = _optional_decimal(payload_map.get("macd"))
    if macd is None and isinstance(payload_map.get("macd"), Mapping):
        macd_block = cast(Mapping[str, Any], payload_map.get("macd"))
        macd = _optional_decimal(macd_block.get("macd"))
    macd_signal = _optional_decimal(payload_map.get("macd_signal"))
    if macd_signal is None and isinstance(payload_map.get("macd"), Mapping):
        macd_block = cast(Mapping[str, Any], payload_map.get("macd"))
        macd_signal = _optional_decimal(macd_block.get("signal"))
    resolved = resolve_regime_route_label(
        payload_map, macd=macd, macd_signal=macd_signal
    )
    if resolved != "unknown":
        return resolved
    regime_label = resolve_legacy_regime_label(payload_map)
    if regime_label is not None:
        return regime_label
    return None


def _resolve_decision_regime_label_with_source(
    decision: StrategyDecision,
) -> tuple[Optional[str], str, str | None]:
    params = cast(Mapping[str, Any], decision.params)
    allocator = params.get("allocator")
    if isinstance(allocator, Mapping):
        allocator_map = cast(Mapping[str, Any], allocator)
        allocator_regime = allocator_map.get("regime_label")
        if isinstance(allocator_regime, str) and allocator_regime.strip():
            return allocator_regime.strip().lower(), "allocator", None

    raw_regime_hmm = params.get("regime_hmm")
    if isinstance(raw_regime_hmm, Mapping):
        regime_context = resolve_hmm_context(cast(Mapping[str, Any], raw_regime_hmm))
        regime_context_authority_reason = resolve_regime_context_authority_reason(
            regime_context
        )
        if regime_context.is_authoritative:
            return regime_context.regime_id.lower(), "hmm", None

        if regime_context_authority_reason is None:
            return (
                None,
                "hmm",
                "hmm_non_authoritative",
            )
        regime_label = resolve_legacy_regime_label(params)
        if regime_label is not None:
            return regime_label, "legacy", regime_context_authority_reason
        return None, "none", regime_context_authority_reason

    direct = params.get("regime_label")
    if isinstance(direct, str) and direct.strip():
        return direct.strip().lower(), "legacy", None

    legacy_label = resolve_legacy_regime_label(params)
    regime_label = legacy_label if legacy_label is not None else None
    return regime_label, "legacy", None if regime_label is not None else "missing"


def _resolve_decision_regime_label(decision: StrategyDecision) -> Optional[str]:  # pyright: ignore[reportUnusedFunction]
    # kept for backwards compatibility with existing tests and callers
    regime_label, _, _ = _resolve_decision_regime_label_with_source(decision)
    return regime_label


def _allocator_rejection_reasons(decision: StrategyDecision) -> list[str]:
    allocator = decision.params.get("allocator")
    if not isinstance(allocator, Mapping):
        return []
    allocator_map = cast(Mapping[str, Any], allocator)
    if str(allocator_map.get("status") or "").lower() != "rejected":
        return []
    raw_codes = allocator_map.get("reason_codes")
    if isinstance(raw_codes, list):
        codes = cast(list[Any], raw_codes)
        reason_codes = [str(item).strip() for item in codes if str(item).strip()]
        if reason_codes:
            return reason_codes
    return ["allocator_rejected"]


def _coerce_strategy_symbols(raw: object) -> set[str]:
    if raw is None:
        return set()
    if isinstance(raw, list):
        symbols: set[str] = set()
        for symbol in cast(list[Any], raw):
            cleaned = str(symbol).strip()
            if cleaned:
                symbols.add(cleaned)
        return symbols
    if isinstance(raw, str):
        return {symbol.strip() for symbol in raw.split(",") if symbol.strip()}
    return set()


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


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "t", "1", "yes", "on"}:
            return True
        if normalized in {"false", "f", "0", "no", "off"}:
            return False
    return None


def _coerce_runtime_uncertainty_gate_action(
    value: Any,
) -> RuntimeUncertaintyGateAction | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"pass", "degrade", "abstain", "fail"}:
        return cast(RuntimeUncertaintyGateAction, normalized)
    return None


def _coerce_gateway_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    raw_value = value.strip()
    if not raw_value:
        return None
    normalized = raw_value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _uncertainty_gate_staleness_reason(
    source: str,
    payload: Mapping[str, Any],
) -> str | None:
    if "generated_at" not in payload:
        return None
    timestamp = _coerce_gateway_timestamp(payload.get("generated_at"))
    if timestamp is None:
        return f"{source}_generated_at_unparseable"
    age_seconds = int((datetime.now(timezone.utc) - timestamp).total_seconds())
    if age_seconds > _RUNTIME_UNCERTAINTY_GATE_MAX_STALENESS_SECONDS:
        return f"{source}_generated_at_stale"
    return None


def _position_qty(symbol: str, positions: list[dict[str, Any]]) -> Decimal:
    total_qty = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty"))
        if qty is None:
            qty = _optional_decimal(position.get("quantity"))
        if qty is None:
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short":
            qty = -abs(qty)
        total_qty += qty
    return total_qty


def _position_market_value(
    symbol: str, positions: list[dict[str, Any]]
) -> Decimal | None:
    total_market_value = Decimal("0")
    has_market_value = False
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        market_value = _optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        total_market_value += market_value
        has_market_value = True
    if not has_market_value:
        return None
    return total_market_value


def _extract_decision_price(decision: StrategyDecision) -> Decimal | None:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            return _optional_decimal(value)
    return None


def _apply_projected_position_decision(
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
) -> None:
    qty = _optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return
    if decision.action not in {"buy", "sell"}:
        return

    current_qty = _position_qty(decision.symbol, positions)
    current_market_value = _position_market_value(decision.symbol, positions)
    delta = qty if decision.action == "buy" else -qty
    projected_qty = current_qty + delta
    decision_price = _extract_decision_price(decision)
    if decision_price is not None:
        projected_market_value = (current_market_value or Decimal("0")) + (
            delta * decision_price
        )
    else:
        projected_market_value = current_market_value

    positions[:] = [
        position for position in positions if position.get("symbol") != decision.symbol
    ]
    if projected_qty == 0:
        return

    projected_position = {
        "symbol": decision.symbol,
        "qty": str(abs(projected_qty)),
        "side": "short" if projected_qty < 0 else "long",
    }
    if projected_market_value is not None:
        projected_position["market_value"] = str(projected_market_value)
    positions.append(projected_position)


def _is_runtime_risk_increasing_entry(
    decision: StrategyDecision,
    positions: list[dict[str, Any]],
) -> bool:
    qty = _optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return False
    position_qty = _position_qty(decision.symbol, positions)
    if decision.action == "buy":
        if position_qty < 0:
            return qty > abs(position_qty)
        return True
    if position_qty <= 0:
        return True
    return qty > position_qty


def _hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _is_llm_stage_policy_violation(rollout_stage: str) -> bool:
    if rollout_stage == "stage0":
        return (
            settings.llm_enabled
            or not settings.llm_shadow_mode
            or settings.llm_adjustment_allowed
        )
    if rollout_stage == "stage1":
        if not settings.llm_shadow_mode or settings.llm_adjustment_allowed:
            return True
        expected_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage1")
        return settings.llm_fail_mode != expected_fail_mode
    if rollout_stage == "stage2":
        expected_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage2")
        return settings.llm_fail_mode != expected_fail_mode
    return False


def _normalize_rollout_stage(stage: str) -> str:
    if stage.startswith("stage0"):
        return "stage0"
    if stage.startswith("stage1"):
        return "stage1"
    if stage.startswith("stage2"):
        return "stage2"
    if stage.startswith("stage3"):
        return "stage3"
    return "stage3"


def _expected_fail_mode_for_stage(rollout_stage: str) -> str:
    if rollout_stage == "stage1":
        return settings.llm_effective_fail_mode(rollout_stage="stage1")
    if rollout_stage == "stage2":
        return settings.llm_effective_fail_mode(rollout_stage="stage2")
    return settings.llm_effective_fail_mode()


def _build_llm_policy_resolution(
    *,
    rollout_stage: str,
    effective_fail_mode: str,
    guardrail_reasons: tuple[str, ...] | list[str],
) -> dict[str, Any]:
    normalized_stage = _normalize_rollout_stage(rollout_stage)
    expected_fail_mode = _expected_fail_mode_for_stage(normalized_stage)
    configured_fail_mode = settings.llm_fail_mode
    stage_policy_violation = _is_llm_stage_policy_violation(normalized_stage)
    fail_mode_override = effective_fail_mode != configured_fail_mode
    fail_mode_exception_active = (
        fail_mode_override
        and not stage_policy_violation
        and bool(settings.llm_policy_exceptions)
        and expected_fail_mode != configured_fail_mode
    )
    fail_mode_violation_active = fail_mode_override and not fail_mode_exception_active
    if fail_mode_violation_active:
        classification = "violation"
    elif fail_mode_exception_active:
        classification = "intentional_exception"
    else:
        classification = "compliant"
    reasoning: list[str] = []
    if stage_policy_violation:
        reasoning.append("rollout_stage_policy_violation")
    if fail_mode_exception_active:
        reasoning.append("intentional_policy_exception")
    if fail_mode_violation_active:
        reasoning.append("unexpected_fail_mode_override")
    if not reasoning:
        reasoning.append("policy_compliant")

    return {
        "classification": classification,
        "rollout_stage": normalized_stage,
        "configured_fail_mode": configured_fail_mode,
        "effective_fail_mode": effective_fail_mode,
        "expected_fail_mode": expected_fail_mode,
        "stage_policy_violation": stage_policy_violation,
        "fail_mode_exception_active": fail_mode_exception_active,
        "fail_mode_violation_active": fail_mode_violation_active,
        "policy_exceptions": list(settings.llm_policy_exceptions),
        "guardrail_reasons": list(guardrail_reasons),
        "reasoning": reasoning,
        "source_inputs": {
            "trading_mode": settings.trading_mode,
            "llm_fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            "llm_live_fail_open_requested": settings.llm_live_fail_open_requested_for_stage(
                normalized_stage
            ),
            "llm_fail_open_live_approved": settings.llm_fail_open_live_approved,
        },
    }


def _llm_guardrail_controls_snapshot() -> dict[str, Any]:
    return {
        "min_confidence": settings.llm_min_confidence,
        "min_calibrated_probability": settings.llm_min_calibrated_top_probability,
        "min_probability_margin": settings.llm_min_probability_margin,
        "max_uncertainty_score": settings.llm_max_uncertainty,
        "max_uncertainty_band": settings.llm_max_uncertainty_band,
        "min_calibration_quality_score": settings.llm_min_calibration_quality_score,
        "abstain_fail_mode": settings.llm_abstain_fail_mode,
        "escalation_fail_mode": settings.llm_escalate_fail_mode,
        "uncertainty_fail_mode": settings.llm_quality_fail_mode,
        "effective_fail_mode": settings.llm_effective_fail_mode_for_current_rollout(),
    }


class TradingScheduler:
    """Async background scheduler for trading pipeline."""

    def __init__(self) -> None:
        self.state = TradingState()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._pipeline: Optional[TradingPipeline] = None
        self._pipelines: list[TradingPipeline] = []

    def llm_status(self) -> dict[str, object]:
        circuit_snapshot = None
        if self._pipeline and self._pipeline.llm_review_engine:
            circuit_snapshot = (
                self._pipeline.llm_review_engine.circuit_breaker.snapshot()
            )
        guardrails = evaluate_llm_guardrails()
        policy_resolution = _build_llm_policy_resolution(
            rollout_stage=guardrails.rollout_stage,
            effective_fail_mode=guardrails.effective_fail_mode,
            guardrail_reasons=guardrails.reasons,
        )
        return {
            "enabled": settings.llm_enabled,
            "rollout_stage": guardrails.rollout_stage,
            "fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            # Keep configured shadow_mode for backward compatibility.
            "shadow_mode": settings.llm_shadow_mode,
            # Effective runtime posture after model-risk guardrails.
            "effective_shadow_mode": guardrails.shadow_mode,
            "fail_mode": settings.llm_fail_mode,
            "effective_fail_mode": guardrails.effective_fail_mode,
            "policy_exceptions": settings.llm_policy_exceptions,
            "policy_resolution": policy_resolution,
            "policy_resolution_counters": dict(
                self.state.metrics.llm_policy_resolution_total
            ),
            "circuit": circuit_snapshot,
            "guardrails": {
                "allow_requests": guardrails.allow_requests,
                "governance_evidence_complete": guardrails.governance_evidence_complete,
                "effective_adjustment_allowed": guardrails.adjustment_allowed,
                "committee_enabled": guardrails.committee_enabled,
                "reasons": list(guardrails.reasons),
            },
        }

    def _build_pipeline_for_account(self, lane: TradingAccountLane) -> TradingPipeline:
        price_fetcher = ClickHousePriceFetcher()
        strategy_catalog = StrategyCatalog.from_settings()
        alpaca_client = TorghutAlpacaClient(
            api_key=lane.api_key,
            secret_key=lane.secret_key,
            base_url=lane.base_url,
        )
        order_firewall = OrderFirewall(alpaca_client)
        execution_adapter = build_execution_adapter(
            alpaca_client=alpaca_client, order_firewall=order_firewall
        )
        return TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=order_firewall,
            ingestor=ClickHouseSignalIngestor(account_label=lane.label),
            decision_engine=DecisionEngine(price_fetcher=price_fetcher),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=execution_adapter,
            reconciler=Reconciler(account_label=lane.label),
            universe_resolver=UniverseResolver(),
            state=self.state,
            account_label=lane.label,
            price_fetcher=price_fetcher,
            strategy_catalog=strategy_catalog,
            order_feed_ingestor=OrderFeedIngestor(),
        )

    def _build_pipeline(self) -> TradingPipeline:
        lane = settings.trading_accounts[0]
        return self._build_pipeline_for_account(lane)

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
            for reason in current_reasons
            if not _is_recoverable_emergency_stop_reason(reason)
        ]
        if nonrecoverable_current_reasons:
            merged_reasons = sorted(
                set(latched_reasons + nonrecoverable_current_reasons)
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
            for reason in current_reasons
            if _is_recoverable_emergency_stop_reason(reason)
        ]
        if recoverable_current_reasons:
            self.state.emergency_stop_recovery_streak = 0
            refreshed = ";".join(sorted(set(recoverable_current_reasons)))
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
        now = datetime.now(timezone.utc)
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

    def _trigger_emergency_stop(
        self,
        *,
        reasons: list[str],
        fallback_ratio: float,
        drawdown: float | None,
    ) -> None:
        if self._pipeline is None:
            return
        now = datetime.now(timezone.utc)
        self.state.emergency_stop_active = True
        self.state.rollback_incidents_total += 1
        self.state.emergency_stop_triggered_at = now
        self.state.emergency_stop_resolved_at = None
        self.state.emergency_stop_recovery_streak = 0
        self.state.emergency_stop_reason = ";".join(reasons)
        self.state.metrics.signal_continuity_breach_total += 1
        self.state.last_error = (
            f"emergency_stop_triggered reasons={self.state.emergency_stop_reason}"
        )
        self.state.metrics.orders_rejected_total += 1
        firewall_status = self._pipeline.order_firewall.status()
        try:
            canceled = self._pipeline.order_firewall.cancel_all_orders()
            cancelled_count = len(canceled)
        except Exception:
            logger.exception("Emergency stop failed to cancel open orders")
            cancelled_count = 0

        gate_provenance = self._load_last_gate_provenance()
        rollback_artifact_paths = [
            self.state.last_autonomy_gates,
            self.state.last_autonomy_actuation_intent,
            gate_provenance.get("phase_manifest_path"),
        ]
        unique_rollback_artifact_paths = [
            path
            for index, path in enumerate(rollback_artifact_paths)
            if path and path not in rollback_artifact_paths[:index]
        ]
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
            "rollback_artifacts": [
                item for item in unique_rollback_artifact_paths if item is not None
            ],
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
        logger.error(
            "Emergency stop triggered reasons=%s canceled_open_orders=%s evidence=%s",
            reasons,
            cancelled_count,
            incident_path,
        )

    def _load_last_gate_provenance(self) -> dict[str, object | None]:
        gate_path_raw = self.state.last_autonomy_gates
        actuation_path_raw = (
            str(self.state.last_autonomy_actuation_intent or "").strip()
        )
        phase_manifest_path_raw = str(
            self.state.last_autonomy_phase_manifest or ""
        ).strip()
        payload: dict[str, Any] = {}
        phase_lineage: dict[str, Any] = {}
        actuation_payload: dict[str, Any] = {}
        phase_payload: dict[str, Any] = {}
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
        if phase_manifest_path_raw:
            try:
                manifest_raw = json.loads(
                    Path(phase_manifest_path_raw).read_text(encoding="utf-8")
                )
                if isinstance(manifest_raw, dict):
                    phase_payload = cast(dict[str, Any], manifest_raw)
            except Exception:
                phase_payload = {}
        actuation_gates_raw = actuation_payload.get("gates")
        actuation_gates = (
            cast(dict[str, Any], actuation_gates_raw)
            if isinstance(actuation_gates_raw, dict)
            else {}
        )
        if isinstance(phase_payload.get("phase_lineage"), dict):
            phase_lineage = cast(dict[str, Any], phase_payload.get("phase_lineage"))
        raw_phase_trace = phase_lineage.get("stage_ids")
        if isinstance(raw_phase_trace, list):
            phase_manifest_trace = [
                str(item).strip() for item in raw_phase_trace if str(item).strip()
            ]
        else:
            phase_manifest_trace = []
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
            "phase_manifest_path": phase_manifest_path_raw or None,
            "phase_manifest_hash": str(phase_payload.get("manifest_hash")).strip()
                or None,
            "phase_manifest_lineage_root": str(
                phase_lineage.get("lineage_root")
            ).strip()
                or None,
            "phase_manifest_lineage_tail": str(
                phase_lineage.get("lineage_tail")
            ).strip()
                or None,
            "phase_manifest_trace": phase_manifest_trace,
        }

    async def start(self) -> None:
        if self._task:
            return
        if not self._pipelines:
            lanes = settings.trading_accounts
            self._pipelines = [self._build_pipeline_for_account(lane) for lane in lanes]
            self._pipeline = self._pipelines[0] if self._pipelines else None
        self._stop_event.clear()
        self.state.running = True
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self.state.running = False
        active_pipelines = self._pipelines or (
            [self._pipeline] if self._pipeline is not None else []
        )
        for pipeline in active_pipelines:
            pipeline.order_feed_ingestor.close()
        self._pipelines = []
        self._pipeline = None

    async def _run_loop(self) -> None:
        poll_interval = settings.trading_poll_ms / 1000
        reconcile_interval = settings.trading_reconcile_ms / 1000
        autonomy_interval = max(30, settings.trading_autonomy_interval_seconds)
        evidence_interval = max(
            300, settings.trading_evidence_continuity_interval_seconds
        )
        last_reconcile = datetime.now(timezone.utc)
        last_autonomy = datetime.now(timezone.utc)
        last_evidence_check = datetime.now(timezone.utc)

        while not self._stop_event.is_set():
            await self._run_trading_iteration()
            now = datetime.now(timezone.utc)
            if self._interval_elapsed(last_reconcile, reconcile_interval, now=now):
                await self._run_reconcile_iteration()
                last_reconcile = now

            if settings.trading_autonomy_enabled and self._interval_elapsed(
                last_autonomy, autonomy_interval, now=now
            ):
                await self._run_autonomy_iteration()
                last_autonomy = now

            if settings.trading_evidence_continuity_enabled and self._interval_elapsed(
                last_evidence_check, evidence_interval, now=now
            ):
                await self._run_evidence_iteration()
                last_evidence_check = now

            await asyncio.sleep(poll_interval)

    @staticmethod
    def _interval_elapsed(
        last_run: datetime,
        interval_seconds: float,
        *,
        now: datetime,
    ) -> bool:
        return now - last_run >= timedelta(seconds=interval_seconds)

    async def _run_trading_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            active_pipelines = self._pipelines or [self._pipeline]
            for pipeline in active_pipelines:
                try:
                    await asyncio.to_thread(pipeline.run_once)
                except Exception as lane_exc:
                    logger.exception(
                        "Trading lane failed account=%s: %s",
                        pipeline.account_label,
                        lane_exc,
                    )
            self.state.last_run_at = datetime.now(timezone.utc)
            self.state.last_error = None
        except Exception as exc:  # pragma: no cover - loop guard
            logger.exception("Trading loop failed: %s", exc)
            self.state.last_error = str(exc)
        finally:
            self._evaluate_safety_controls()

    async def _run_reconcile_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            updates = 0
            active_pipelines = self._pipelines or [self._pipeline]
            for pipeline in active_pipelines:
                try:
                    updates += await asyncio.to_thread(pipeline.reconcile)
                except Exception as lane_exc:
                    logger.exception(
                        "Reconcile lane failed account=%s: %s",
                        pipeline.account_label,
                        lane_exc,
                    )
            if updates:
                logger.info("Reconciled %s executions", updates)
            self.state.last_reconcile_at = datetime.now(timezone.utc)
            self.state.last_error = None
        except Exception as exc:  # pragma: no cover - loop guard
            logger.exception("Reconcile loop failed: %s", exc)
            self.state.last_error = str(exc)
        finally:
            self._evaluate_safety_controls()

    async def _run_autonomy_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            await asyncio.to_thread(self._run_autonomous_cycle)
            self.state.last_autonomy_error = None
        except Exception as exc:  # pragma: no cover - loop guard
            logger.exception("Autonomous loop failed: %s", exc)
            self.state.last_error = str(exc)
            self.state.last_autonomy_error = str(exc)
            self.state.autonomy_failure_streak += 1
            self._clear_autonomy_result_state()
        finally:
            self._evaluate_safety_controls()

    async def _run_evidence_iteration(self) -> None:
        try:
            if self._pipeline is None:
                raise RuntimeError("trading_pipeline_not_initialized")
            await asyncio.to_thread(self._run_evidence_continuity_check)
        except Exception as exc:  # pragma: no cover - loop guard
            logger.exception("Evidence continuity check failed: %s", exc)
            self.state.last_error = str(exc)

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
        governance_repository: str | None = None,
        governance_base: str | None = None,
        governance_head: str | None = None,
        governance_artifact_root: str | None = None,
        priority_id: str | None = None,
        governance_inputs: Mapping[str, Any] | None = None,
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
        now = datetime.now(timezone.utc)
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
            governance_repository=governance_repository or "proompteng/lab",
            governance_base=governance_base or "main",
            governance_head=(
                governance_head
                or f"agentruns/torghut-autonomy-{now.strftime('%Y%m%dT%H%M%S')}"
            ),
            governance_artifact_path=str(run_output_dir),
            priority_id=priority_id,
            artifact_root=artifact_root,
            governance_inputs=self._build_autonomy_governance_inputs(
                governance_inputs=governance_inputs,
                artifact_root=artifact_root,
                promotion_target=promotion_target,
                governance_repository=governance_repository,
                governance_base=governance_base,
                governance_head=governance_head,
                priority_id=priority_id,
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
        governance_repository: str | None = None,
        governance_base: str | None = None,
        governance_head: str | None = None,
        priority_id: str | None = None,
    ) -> dict[str, str]:
        repository = (
            governance_repository
            or (os.getenv("GITHUB_REPOSITORY") or "unknown")
            or "unknown"
        ).strip() or "unknown"
        base_ref = (
            governance_base
            or os.getenv("GITHUB_BASE_REF")
            or os.getenv("GITHUB_REF")
            or "unknown"
        )
        if base_ref.startswith("refs/heads/"):
            base_ref = base_ref.removeprefix("refs/heads/")
        head_ref = (
            governance_head
            or os.getenv("GITHUB_HEAD_REF")
            or os.getenv("GITHUB_REF_NAME")
            or ("live" if promotion_target == "live" else "unknown")
        )
        priority_id = (
            priority_id or os.getenv("PRIORITY_ID") or os.getenv("CODEX_PRIORITY_ID") or ""
        )
        return {
            "repository": repository,
            "base": base_ref,
            "head": head_ref,
            "artifactPath": str(artifact_root),
            "priorityId": priority_id,
        }

    def _build_autonomy_governance_inputs(
        self,
        *,
        governance_inputs: Mapping[str, Any] | None = None,
        artifact_root: Path,
        promotion_target: str,
        governance_repository: str | None,
        governance_base: str | None,
        governance_head: str | None,
        priority_id: str | None,
    ) -> dict[str, Any]:
        merged_governance_inputs: dict[str, Any] = {}
        if governance_inputs is not None:
            merged_governance_inputs = dict(governance_inputs)

        caller_execution_context = merged_governance_inputs.get(
            "execution_context",
            {},
        )
        caller_runtime_governance = merged_governance_inputs.get(
            "runtime_governance",
            {},
        )
        caller_rollback_proof = merged_governance_inputs.get("rollback_proof", {})

        execution_context = self._build_autonomy_execution_context(
            artifact_root=artifact_root,
            promotion_target=promotion_target,
            governance_repository=governance_repository,
            governance_base=governance_base,
            governance_head=governance_head,
            priority_id=priority_id,
        )
        if isinstance(caller_execution_context, Mapping):
            execution_context.update(
                cast(Mapping[str, Any], caller_execution_context)
            )
        runtime_governance: dict[str, Any] = {
            "governance_status": "pass",
            "drift_status": "queued",
            "artifact_refs": [],
            "rollback_triggered": False,
            "reasons": ["autonomy_runtime_governance_pending"],
        }
        if isinstance(caller_runtime_governance, Mapping):
            runtime_governance.update(
                cast(Mapping[str, Any], caller_runtime_governance)
            )
        rollback_proof: dict[str, Any] = {
            "rollback_triggered": False,
            "rollback_incident_evidence_path": "",
            "reasons": [],
        }
        if isinstance(caller_rollback_proof, Mapping):
            rollback_proof.update(cast(Mapping[str, Any], caller_rollback_proof))

        merged_governance_inputs["execution_context"] = execution_context
        merged_governance_inputs["runtime_governance"] = runtime_governance
        merged_governance_inputs["rollback_proof"] = rollback_proof
        return merged_governance_inputs

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
        self.state.last_autonomy_phase_manifest = None
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
        artifact_root: Path | None = None,
        execution_context: Mapping[str, str] | None = None,
        governance_inputs: Mapping[str, Any] | None = None,
    ) -> Any | None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")
        governance_payload: dict[str, Any] | None = None
        if governance_inputs is not None:
            governance_payload = dict(governance_inputs)
        elif execution_context is not None:
            governance_payload = {
                "execution_context": dict(execution_context),
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
                governance_change="autonomous-promotion",
                governance_reason=(
                    f"Autonomous recommendation for {promotion_target} target."
                ),
                governance_inputs=cast(Mapping[str, Any] | None, governance_payload),
                persist_results=True,
                session_factory=self._pipeline.session_factory,
            )
        except Exception as exc:
            self.state.autonomy_failure_streak += 1
            self.state.last_autonomy_phase_manifest = None
            self.state.last_autonomy_error = str(exc)
            self.state.last_autonomy_reason = "lane_execution_failed"
            self._clear_autonomy_result_state()
            logger.exception("Autonomous lane execution failed: %s", exc)
            self._evaluate_safety_controls()
            return None

    def _clear_autonomy_result_state(self) -> None:
        self.state.last_autonomy_run_id = None
        self.state.last_autonomy_candidate_id = None
        self.state.last_autonomy_gates = None
        self.state.last_autonomy_phase_manifest = None
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
        self.state.last_autonomy_phase_manifest = (
            str(result.phase_manifest_path) if result.phase_manifest_path else None
        )
        self.state.last_autonomy_actuation_intent = (
            str(result.actuation_intent_path)
            if result.actuation_intent_path
            else None
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
        actuation_gates_payload: Mapping[str, Any] = cast(
            Mapping[str, Any], {}
        )
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
                    drift_governance_payload=cast(Mapping[str, Any], drift_governance_payload),
                    now=now,
                )
        else:
            self.state.drift_status = "disabled"
            self.state.drift_live_promotion_eligible = False
            self.state.drift_live_promotion_reasons = ["drift_governance_disabled"]
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

        def _to_items(raw: Any) -> list[Any]:
            if isinstance(raw, list):
                return cast(list[Any], raw)
            if isinstance(raw, tuple):
                return list(cast(tuple[Any, ...], raw))
            if isinstance(raw, set):
                return list(cast(set[Any], raw))
            return []

        def _coerce_strs(raw: Any) -> list[str]:
            raw_items = _to_items(raw)
            if not raw_items:
                return []
            return sorted(
                {
                    str(item).strip()
                    for item in raw_items
                    if str(item).strip()
                }
            )

        def _coerce_path(raw: Any) -> str:
            if not isinstance(raw, str):
                return ""
            return raw.strip()

        def _coerce_reason_codes(raw: Any) -> list[str]:
            raw_items = _to_items(raw)
            if not raw_items:
                return []
            return sorted(
                {
                    str(item).strip()
                    for item in raw_items
                    if str(item).strip()
                }
            )

        def _build_placeholder_phase(name: str) -> dict[str, Any]:
            return {
                "name": name,
                "status": "skip",
                "timestamp": now.isoformat(),
                "observations": {"note": "stage not evaluated"},
                "slo_gates": [],
                "artifact_refs": [],
            }

        drift_status = str(
            drift_governance_payload.get("drift_status")
            or self.state.drift_status
            or "skipped"
        ).strip().lower()

        drift_reasons = _coerce_reason_codes(
            drift_governance_payload.get("reasons", [])
        )
        action_payload = drift_governance_payload.get("action")
        detection_payload = drift_governance_payload.get("detection")
        if isinstance(action_payload, dict):
            action_payload_map = cast(dict[str, Any], action_payload)
            action_type = str(action_payload_map.get("action_type", "")).strip()
            action_triggered = bool(action_payload_map.get("triggered", False))
            action_reasons = _coerce_reason_codes(
                action_payload_map.get("reason_codes", [])
            )
        else:
            action_type = ""
            action_triggered = False
            action_reasons = []

        if isinstance(detection_payload, dict):
            detection_payload_map = cast(dict[str, Any], detection_payload)
            detection_reasons = _coerce_reason_codes(
                detection_payload_map.get("reason_codes", [])
            )
        else:
            detection_reasons = []

        evidence_refs = [
            _coerce_path(self.state.drift_last_detection_path),
            _coerce_path(self.state.drift_last_action_path),
            _coerce_path(self.state.drift_last_outcome_path),
            _coerce_path(self.state.rollback_incident_evidence_path),
        ]
        artifact_refs_payload = drift_governance_payload.get("artifact_refs", [])
        if isinstance(artifact_refs_payload, (list, tuple, set)):
            evidence_refs.extend(
                [
                    _coerce_path(item)
                    for item in _to_items(artifact_refs_payload)
                    if _coerce_path(item)
                ]
            )
        evidence_refs = sorted({item for item in evidence_refs if item})
        rollback_incident_evidence = _coerce_path(
            drift_governance_payload.get("rollback_incident_evidence")
        ) or _coerce_path(self.state.rollback_incident_evidence_path)
        if rollback_incident_evidence:
            evidence_refs.append(rollback_incident_evidence)
        evidence_refs = sorted(set(evidence_refs))

        rollback_triggered = bool(
            self.state.emergency_stop_active
            or drift_governance_payload.get("rollback_triggered", False)
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

        governance_phase: dict[str, Any] = {
            "name": "runtime-governance",
            "status": governance_status,
            "timestamp": now.isoformat(),
            "observations": {
                "requested_promotion_target": requested_promotion_target,
                "drift_status": drift_status,
                "action_type": action_type or None,
                "action_triggered": action_triggered,
                "rollback_triggered": rollback_triggered,
            },
            "slo_gates": [
                {
                    "id": "slo_runtime_rollback_not_triggered",
                    "status": "pass" if not rollback_triggered else "fail",
                    "threshold": False,
                    "value": rollback_triggered,
                },
            ],
            "reasons": reasons,
            "artifact_refs": evidence_refs,
        }

        rollback_proof_status = (
            "pass" if (not rollback_triggered or rollback_incident_evidence) else "fail"
        )
        rollback_proof_phase: dict[str, Any] = {
            "name": "rollback-proof",
            "status": rollback_proof_status,
            "timestamp": now.isoformat(),
            "slo_gates": [
                {
                    "id": "slo_rollback_evidence_required_when_triggered",
                    "status": "pass" if not rollback_triggered else (
                        "pass" if rollback_incident_evidence else "fail"
                    ),
                    "threshold": True,
                    "value": bool(rollback_incident_evidence),
                },
            ],
            "observations": {
                "rollback_triggered": rollback_triggered,
                "rollback_incident_evidence_path": rollback_incident_evidence,
            },
            "reasons": reasons,
            "artifact_refs": (
                [rollback_incident_evidence] if rollback_incident_evidence else []
            ),
        }

        existing_phases = manifest.get("phases", [])
        phase_lookup: dict[str, dict[str, Any]] = {}
        if isinstance(existing_phases, list):
            for raw_phase in cast(list[Any], existing_phases):
                if not isinstance(raw_phase, dict):
                    continue
                phase = cast(dict[str, Any], raw_phase)
                name = str(phase.get("name", "")).strip()
                if name:
                    phase_lookup[name] = dict(phase)
        phase_lookup["runtime-governance"] = governance_phase
        phase_lookup["rollback-proof"] = rollback_proof_phase

        ordered_phases: list[dict[str, Any]] = []
        for name in _AUTONOMY_PHASE_ORDER:
            phase_payload = phase_lookup.get(name)
            if phase_payload is None:
                ordered_phases.append(_build_placeholder_phase(name))
                continue
            phase_payload["name"] = name
            phase_payload["status"] = coerce_phase_status(
                phase_payload.get("status"), default="skip"
            )
            phase_payload["artifact_refs"] = _coerce_strs(
                phase_payload.get("artifact_refs", [])
            )
            ordered_phases.append(phase_payload)

        manifest["phases"] = ordered_phases
        manifest["runtime_governance"] = {
            "requested_promotion_target": requested_promotion_target,
            "drift_status": drift_status,
            "governance_status": governance_status,
            "rollback_triggered": rollback_triggered,
            "rollback_incident_evidence": rollback_incident_evidence,
            "rollback_incident_evidence_path": rollback_incident_evidence,
            "artifact_refs": evidence_refs,
            "phase_count": len(ordered_phases),
            "action_type": action_type,
            "action_triggered": action_triggered,
            "reasons": reasons,
        }
        manifest["rollback_proof"] = {
            "requested_promotion_target": requested_promotion_target,
            "rollback_triggered": rollback_triggered,
            "rollback_incident_evidence_path": rollback_incident_evidence,
            "rollback_incident_evidence": rollback_incident_evidence,
            "artifact_refs": (
                [rollback_incident_evidence]
                if rollback_incident_evidence
                else []
            ),
            "reasons": reasons,
            "status": rollback_proof_status,
        }

        manifest["status"] = (
            "fail"
            if any(
                str(phase.get("status")) not in {"pass", "skipped", "skip"}
                for phase in ordered_phases
            )
            else "pass"
        )
        manifest["phase_count"] = len(ordered_phases)
        manifest["updated_at"] = now.isoformat()

        existing_artifact_refs = _coerce_strs(manifest.get("artifact_refs", []))
        artifact_refs = [
            str(item)
            for phase in ordered_phases
            for item in _coerce_strs(phase.get("artifact_refs", []))
        ]
        artifact_refs.extend(evidence_refs)
        artifact_refs.extend(existing_artifact_refs)
        manifest["artifact_refs"] = sorted(
            {
                artifact_ref
                for artifact_ref in artifact_refs
                if str(artifact_ref).strip()
            }
        )
        manifest["phase_transitions"] = normalize_phase_transitions(ordered_phases)
        manifest_payload_without_hash = dict(manifest)
        manifest_payload_without_hash.pop("manifest_hash", None)
        manifest["manifest_hash"] = hashlib.sha256(
            json.dumps(
                manifest_payload_without_hash,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8"),
        ).hexdigest()

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


__all__ = ["TradingScheduler", "TradingState", "TradingMetrics"]


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
