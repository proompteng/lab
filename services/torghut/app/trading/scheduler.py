"""Background scheduler for the trading pipeline."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
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
from ..config import settings
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
from .llm.guardrails import evaluate_llm_guardrails
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
from .route_metadata import coerce_route_text

logger = logging.getLogger(__name__)

_RECOVERABLE_EMERGENCY_STOP_PREFIXES: tuple[str, ...] = (
    "signal_lag_exceeded:",
    "signal_staleness_streak_exceeded:",
)


def _split_emergency_stop_reasons(raw: str | None) -> list[str]:
    if not raw:
        return []
    parts = [part.strip() for part in raw.split(";")]
    return [part for part in parts if part]


def _is_recoverable_emergency_stop_reason(reason: str) -> bool:
    return reason.startswith(_RECOVERABLE_EMERGENCY_STOP_PREFIXES)


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
        parts: list[str] = (
            ["broker_precheck_rejected"]
            if source == "broker_precheck"
            else ["alpaca_order_rejected"]
        )
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
    no_signal_windows_total: int = 0
    no_signal_reason_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    no_signal_reason_streak: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
    no_signal_streak: int = 0
    signal_lag_seconds: int | None = None
    signal_staleness_alert_total: dict[str, int] = field(
        default_factory=lambda: cast(dict[str, int], {})
    )
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

    def record_no_signal(self, reason: str | None) -> None:
        normalized = reason.strip() if isinstance(reason, str) else ""
        if not normalized:
            normalized = "unknown"
        self.no_signal_windows_total += 1
        current = self.no_signal_reason_total.get(normalized, 0)
        self.no_signal_reason_total[normalized] = current + 1
        for existing_reason in list(self.no_signal_reason_streak):
            if existing_reason != normalized:
                del self.no_signal_reason_streak[existing_reason]
        self.no_signal_reason_streak[normalized] = (
            self.no_signal_reason_streak.get(normalized, 0) + 1
        )

    def record_signal_staleness_alert(self, reason: str | None) -> None:
        normalized = reason.strip() if isinstance(reason, str) else ""
        if not normalized:
            normalized = "unknown"
        current = self.signal_staleness_alert_total.get(normalized, 0)
        self.signal_staleness_alert_total[normalized] = current + 1

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
        if result.approved:
            self.allocator_approved_total += 1
        else:
            self.allocator_rejected_total += 1
        if result.clipped:
            self.allocator_clipped_total += 1
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
        normalized_recommendation = (
            recommendation.strip() if isinstance(recommendation, str) else ""
        )
        if not normalized_recommendation:
            normalized_recommendation = "unknown"
        self.autonomy_recommendation_total[normalized_recommendation] = (
            self.autonomy_recommendation_total.get(normalized_recommendation, 0) + 1
        )
        normalized_outcome = outcome.strip() if isinstance(outcome, str) else ""
        if not normalized_outcome:
            normalized_outcome = "unknown"
        self.autonomy_outcome_total[normalized_outcome] = (
            self.autonomy_outcome_total.get(normalized_outcome, 0) + 1
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
    last_autonomy_gates: Optional[str] = None
    last_autonomy_patch: Optional[str] = None
    last_autonomy_recommendation: Optional[str] = None
    last_autonomy_promotion_action: Optional[str] = None
    last_autonomy_promotion_eligible: Optional[bool] = None
    last_autonomy_recommendation_trace_id: Optional[str] = None
    last_autonomy_throughput: Optional[dict[str, int | bool | str | None]] = None
    last_ingest_signals_total: int = 0
    last_ingest_window_start: Optional[datetime] = None
    last_ingest_window_end: Optional[datetime] = None
    last_ingest_reason: Optional[str] = None
    autonomy_no_signal_streak: int = 0
    last_evidence_continuity_report: Optional[dict[str, Any]] = None
    autonomy_failure_streak: int = 0
    universe_source_status: Optional[str] = None
    universe_source_reason: Optional[str] = None
    universe_symbols_count: int = 0
    universe_cache_age_seconds: Optional[int] = None
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
        if llm_review_engine is not None:
            self.llm_review_engine = llm_review_engine
        elif settings.llm_enabled:
            self.llm_review_engine = LLMReviewEngine()
        else:
            self.llm_review_engine = None

    def run_once(self) -> None:
        with self.session_factory() as session:
            self._ingest_order_feed(session)
            self.order_firewall.cancel_open_orders_if_kill_switch()
            if self.strategy_catalog is not None:
                self.strategy_catalog.refresh(session)
            strategies = self._load_strategies(session)
            if not strategies:
                logger.info("No enabled strategies found; skipping trading cycle")
                return

            batch = self.ingestor.fetch_signals(session)
            self.state.last_ingest_signals_total = len(batch.signals)
            self.state.last_ingest_window_start = batch.query_start
            self.state.last_ingest_window_end = batch.query_end
            self.state.last_ingest_reason = batch.no_signal_reason
            if not batch.signals:
                self.record_no_signal_batch(batch)
                self.ingestor.commit_cursor(session, batch)
                return
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
                self.state.metrics.feature_duplicate_ratio = (
                    quality_report.duplicate_ratio
                )
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
                    return
            self.state.metrics.no_signal_reason_streak = {}
            self.state.metrics.no_signal_streak = 0
            self.state.metrics.signal_lag_seconds = None

            account_snapshot = self._get_account_snapshot(session)
            account = {
                "equity": str(account_snapshot.equity),
                "cash": str(account_snapshot.cash),
                "buying_power": str(account_snapshot.buying_power),
            }
            positions = account_snapshot.positions

            universe_resolution = self.universe_resolver.get_resolution()
            self.state.universe_source_status = universe_resolution.status
            self.state.universe_source_reason = universe_resolution.reason
            self.state.universe_symbols_count = len(universe_resolution.symbols)
            self.state.universe_cache_age_seconds = (
                universe_resolution.cache_age_seconds
            )
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
                self.state.metrics.record_signal_staleness_alert(
                    "universe_source_unavailable"
                )
                self.state.last_error = (
                    f"universe_source_unavailable reason={universe_resolution.reason}"
                )
                logger.error(
                    "Blocking decision execution: authoritative Jangar universe unavailable reason=%s status=%s",
                    universe_resolution.reason,
                    universe_resolution.status,
                )
                self.ingestor.commit_cursor(session, batch)
                return

            for signal in batch.signals:
                try:
                    decisions = self.decision_engine.evaluate(
                        signal, strategies, equity=account_snapshot.equity
                    )
                    self.state.metrics.record_strategy_runtime(
                        self.decision_engine.consume_runtime_telemetry()
                    )
                    for telemetry in self.decision_engine.consume_forecast_telemetry():
                        self.state.metrics.record_forecast_telemetry(
                            telemetry.to_payload()
                        )
                except Exception:
                    logger.exception(
                        "Decision evaluation failed symbol=%s timeframe=%s",
                        signal.symbol,
                        signal.timeframe,
                    )
                    continue

                if not decisions:
                    continue

                regime_label = _resolve_signal_regime(signal)
                allocator = allocator_from_settings(account_snapshot.equity)
                allocation_results = allocator.allocate(
                    decisions,
                    account=account,
                    positions=positions,
                    regime_label=regime_label,
                )
                for allocation_result in allocation_results:
                    self.state.metrics.record_allocator_result(allocation_result)
                    decision = allocation_result.decision
                    self.state.metrics.decisions_total += 1
                    try:
                        self._handle_decision(
                            session,
                            decision,
                            strategies,
                            account,
                            positions,
                            allowed_symbols,
                        )
                    except Exception:
                        # Keep the loop alive and commit the cursor so we don't reprocess the same signals forever.
                        logger.exception(
                            "Decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                            decision.strategy_id,
                            decision.symbol,
                            decision.timeframe,
                        )
                        self.state.metrics.orders_rejected_total += 1

            self.ingestor.commit_cursor(session, batch)

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
        if batch.signal_lag_seconds is not None:
            self.state.metrics.signal_lag_seconds = int(batch.signal_lag_seconds)
        else:
            self.state.metrics.signal_lag_seconds = None
        self.state.metrics.record_no_signal(reason)
        streak = self.state.metrics.no_signal_reason_streak.get(reason or "unknown", 0)
        if (
            reason
            in {
                "no_signals_in_window",
                "cursor_tail_stable",
                "cursor_ahead_of_stream",
                "empty_batch_advanced",
            }
            and streak >= settings.trading_signal_no_signal_streak_alert_threshold
        ):
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal continuity alert: reason=%s consecutive_no_signal=%s lag_seconds=%s",
                reason,
                streak,
                batch.signal_lag_seconds,
            )
        elif (
            batch.signal_lag_seconds is not None
            and batch.signal_lag_seconds
            >= settings.trading_signal_stale_lag_alert_seconds
        ):
            self.state.metrics.record_signal_staleness_alert(reason)
            logger.warning(
                "Signal freshness alert: reason=%s lag_seconds=%s",
                reason,
                batch.signal_lag_seconds,
            )

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
    ) -> None:
        decision_row: Optional[TradeDecision] = None
        try:
            strategy = next(
                (s for s in strategies if str(s.id) == decision.strategy_id), None
            )
            if strategy is None:
                return

            strategy_symbols = _coerce_strategy_symbols(strategy.universe_symbols)
            if strategy_symbols:
                if allowed_symbols:
                    symbol_allowlist = strategy_symbols & allowed_symbols
                else:
                    symbol_allowlist = strategy_symbols
            else:
                symbol_allowlist = allowed_symbols

            decision_row = self.executor.ensure_decision(
                session, decision, strategy, self.account_label
            )
            if decision_row.status != "planned":
                return
            if self.executor.execution_exists(session, decision_row):
                return

            allocator_rejection = _allocator_rejection_reasons(decision)
            if allocator_rejection:
                self.state.metrics.orders_rejected_total += 1
                for reason in allocator_rejection:
                    logger.info(
                        "Decision rejected by allocator strategy_id=%s symbol=%s reason=%s",
                        decision.strategy_id,
                        decision.symbol,
                        reason,
                    )
                self.executor.mark_rejected(
                    session, decision_row, ";".join(allocator_rejection)
                )
                return

            decision, snapshot = self._ensure_decision_price(
                decision, signal_price=decision.params.get("price")
            )
            if snapshot is not None:
                params_update = decision.model_dump(mode="json").get("params", {})
                if isinstance(params_update, Mapping):
                    self.executor.update_decision_params(
                        session, decision_row, cast(Mapping[str, Any], params_update)
                    )

            sizing_result = self._apply_portfolio_sizing(
                decision, strategy, account, positions
            )
            decision = sizing_result.decision
            sizing_params = decision.model_dump(mode="json").get("params", {})
            if (
                isinstance(sizing_params, Mapping)
                and "portfolio_sizing" in sizing_params
            ):
                self.executor.update_decision_params(
                    session, decision_row, cast(Mapping[str, Any], sizing_params)
                )
            if not sizing_result.approved:
                self.state.metrics.orders_rejected_total += 1
                for reason in sizing_result.reasons:
                    logger.info(
                        "Decision rejected by portfolio sizing strategy_id=%s symbol=%s reason=%s",
                        decision.strategy_id,
                        decision.symbol,
                        reason,
                    )
                self.executor.mark_rejected(
                    session, decision_row, ";".join(sizing_result.reasons)
                )
                return

            decision, llm_reject_reason = self._apply_llm_review(
                session,
                decision,
                decision_row,
                account,
                positions,
            )
            if llm_reject_reason:
                self.state.metrics.orders_rejected_total += 1
                self.executor.mark_rejected(session, decision_row, llm_reject_reason)
                return

            adaptive_policy = derive_adaptive_execution_policy(
                session,
                symbol=decision.symbol,
                regime_label=_resolve_decision_regime_label(decision),
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
            self.state.metrics.record_adaptive_policy_result(
                adaptive_policy,
                applied=bool(
                    policy_outcome.adaptive is not None
                    and policy_outcome.adaptive.applied
                ),
            )
            if not policy_outcome.approved:
                self.state.metrics.orders_rejected_total += 1
                for reason in policy_outcome.reasons:
                    logger.info(
                        "Decision rejected by execution policy strategy_id=%s symbol=%s reason=%s",
                        decision.strategy_id,
                        decision.symbol,
                        reason,
                    )
                self.executor.mark_rejected(
                    session, decision_row, ";".join(policy_outcome.reasons)
                )
                return

            verdict = self.risk_engine.evaluate(
                session, decision, strategy, account, positions, symbol_allowlist
            )
            if not verdict.approved:
                self.state.metrics.orders_rejected_total += 1
                for reason in verdict.reasons:
                    logger.info(
                        "Decision rejected strategy_id=%s symbol=%s reason=%s",
                        decision.strategy_id,
                        decision.symbol,
                        reason,
                    )
                self.executor.mark_rejected(
                    session, decision_row, ";".join(verdict.reasons)
                )
                return

            if not settings.trading_enabled:
                return
            if (
                settings.trading_emergency_stop_enabled
                and self.state.emergency_stop_active
            ):
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
                return

            execution_client = self._execution_client_for_symbol(
                decision.symbol,
                symbol_allowlist=symbol_allowlist,
            )
            selected_adapter_name = self._execution_client_name(execution_client)
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
            try:
                execution = self.executor.submit_order(
                    session,
                    execution_client,
                    decision,
                    decision_row,
                    self.account_label,
                    execution_expected_adapter=selected_adapter_name,
                    retry_delays=policy_outcome.retry_delays,
                )
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
                return
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
                return

            if execution is None:
                self.state.metrics.orders_submitted_total += 1
                return

            actual_adapter_name = str(
                getattr(execution_client, "last_route", selected_adapter_name)
            )
            if actual_adapter_name == "alpaca_fallback":
                actual_adapter_name = "alpaca"
            if actual_adapter_name != selected_adapter_name:
                fallback_reason = execution.execution_fallback_reason
                self.state.metrics.record_execution_fallback(
                    expected_adapter=selected_adapter_name,
                    actual_adapter=actual_adapter_name,
                    fallback_reason=fallback_reason or "adaptive_fallback",
                )
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
            self.state.metrics.orders_submitted_total += 1
            logger.info(
                "Order submitted strategy_id=%s decision_id=%s symbol=%s adapter=%s alpaca_order_id=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                actual_adapter_name,
                execution.alpaca_order_id,
            )
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
            return

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
        self.state.metrics.record_llm_policy_resolution(
            cast(str | None, policy_resolution.get("classification"))
        )
        if bool(policy_resolution["stage_policy_violation"]):
            self.state.metrics.llm_stage_policy_violation_total += 1
        if bool(policy_resolution["fail_mode_exception_active"]):
            self.state.metrics.llm_fail_mode_exception_total += 1
        elif bool(policy_resolution["fail_mode_violation_active"]):
            self.state.metrics.llm_fail_mode_override_total += 1
        if not guardrails.allow_requests:
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

        engine = self.llm_review_engine or LLMReviewEngine()
        if engine.circuit_breaker.is_open():
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
        request_json: dict[str, Any] = {}
        market_context: Optional[MarketContextBundle] = None
        try:
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
            market_context_status = evaluate_market_context(market_context)
            if market_context_error is not None:
                market_context_status = MarketContextStatus(
                    allow_llm=False,
                    reason="market_context_fetch_error",
                    risk_flags=["market_context_fetch_error"],
                )
            if not market_context_status.allow_llm:
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
            request_json = request.model_dump(mode="json")
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
            if outcome.response.verdict == "abstain":
                self.state.metrics.llm_abstain_total += 1
            elif outcome.response.verdict == "escalate":
                self.state.metrics.llm_escalate_total += 1
            policy_outcome = apply_policy(
                decision,
                outcome.response,
                adjustment_allowed=guardrails.adjustment_allowed,
            )

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

            committee_payload = response_json.get("committee")
            if isinstance(committee_payload, Mapping):
                committee_roles = cast(Mapping[str, Any], committee_payload).get(
                    "roles", {}
                )
                if isinstance(committee_roles, Mapping):
                    for role, role_payload in cast(
                        Mapping[str, Any], committee_roles
                    ).items():
                        if not isinstance(role_payload, Mapping):
                            continue
                        role_data = cast(Mapping[str, Any], role_payload)
                        self.state.metrics.record_llm_committee_member(
                            role=str(role),
                            verdict=str(role_data.get("verdict", "unknown")),
                            latency_ms=_optional_int(role_data.get("latency_ms")),
                            schema_error=bool(role_data.get("schema_error", False)),
                        )

            if outcome.tokens_prompt is not None:
                self.state.metrics.llm_tokens_prompt_total += outcome.tokens_prompt
            if outcome.tokens_completion is not None:
                self.state.metrics.llm_tokens_completion_total += (
                    outcome.tokens_completion
                )

            adjusted_qty = None
            adjusted_order_type = None
            if policy_outcome.verdict == "adjust":
                self.state.metrics.llm_adjust_total += 1
                adjusted_qty = Decimal(str(policy_outcome.decision.qty))
                adjusted_order_type = policy_outcome.decision.order_type
                self._persist_llm_adjusted_decision(
                    session, decision_row, policy_outcome.decision
                )
            elif policy_outcome.verdict == "approve":
                self.state.metrics.llm_approve_total += 1
            elif policy_outcome.verdict == "veto":
                self.state.metrics.llm_veto_total += 1

            if outcome.tokens_prompt is not None:
                self.state.metrics.llm_tokens_prompt_total += outcome.tokens_prompt
            if outcome.tokens_completion is not None:
                self.state.metrics.llm_tokens_completion_total += (
                    outcome.tokens_completion
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
            if guardrails.shadow_mode:
                self.state.metrics.llm_shadow_total += 1
                if not settings.llm_shadow_mode:
                    self.state.metrics.llm_guardrail_shadow_total += 1
                return decision, None
            if policy_outcome.verdict == "veto":
                self.state.metrics.record_llm_committee_veto_alignment(
                    committee_veto=bool(outcome.response.committee),
                    deterministic_veto=True,
                )
                return decision, policy_outcome.reason or "llm_veto"

            return policy_outcome.decision, None
        except Exception as exc:
            engine.circuit_breaker.record_error()
            self.state.metrics.llm_error_total += 1
            error_label = _classify_llm_error(exc)
            if error_label == "llm_response_not_json":
                self.state.metrics.llm_parse_error_total += 1
            elif error_label == "llm_response_invalid":
                self.state.metrics.llm_validation_error_total += 1
            fallback = self._resolve_llm_fallback(guardrails.effective_fail_mode)
            effective_verdict = "veto" if fallback == "veto" else "approve"
            response_json = {
                "error": str(exc),
                "fallback": fallback,
                "effective_verdict": effective_verdict,
                "policy_resolution": policy_resolution,
                "guardrail_controls": _llm_guardrail_controls_snapshot(),
            }
            if guardrails.reasons:
                response_json["mrm_guardrails"] = list(guardrails.reasons)
            if not request_json:
                request_json = {"decision": decision.model_dump(mode="json")}
            response_json["advisory_only"] = True
            response_json["request_hash"] = _hash_payload(request_json)
            response_json["response_hash"] = _hash_payload(response_json)
            self._persist_llm_review(
                session=session,
                decision_row=decision_row,
                model=settings.llm_model,
                prompt_version=settings.llm_prompt_version,
                request_json=request_json,
                response_json=response_json,
                verdict="error",
                confidence=None,
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale=f"llm_error_{fallback}",
                risk_flags=[type(exc).__name__] + list(guardrails.reasons),
                tokens_prompt=None,
                tokens_completion=None,
            )
            if guardrails.shadow_mode:
                self.state.metrics.llm_shadow_total += 1
                if not settings.llm_shadow_mode:
                    self.state.metrics.llm_guardrail_shadow_total += 1
                return decision, None
            if fallback == "veto":
                logger.warning(
                    "LLM review failed; vetoing decision_id=%s error=%s",
                    decision_row.id,
                    exc,
                )
                return decision, "llm_error"
            logger.warning(
                "LLM review failed; pass-through decision_id=%s error=%s",
                decision_row.id,
                exc,
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
            model=settings.llm_model,
            prompt_version=settings.llm_prompt_version,
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
    direct = payload_map.get("regime_label")
    if isinstance(direct, str) and direct.strip():
        return direct.strip().lower()
    regime = payload_map.get("regime")
    if isinstance(regime, Mapping):
        regime_map = cast(Mapping[str, Any], regime)
        label = regime_map.get("label")
        if isinstance(label, str) and label.strip():
            return label.strip().lower()
    return None


def _resolve_decision_regime_label(decision: StrategyDecision) -> Optional[str]:
    params = decision.params
    allocator = params.get("allocator")
    if isinstance(allocator, Mapping):
        allocator_map = cast(Mapping[str, Any], allocator)
        allocator_regime = allocator_map.get("regime_label")
        if isinstance(allocator_regime, str) and allocator_regime.strip():
            return allocator_regime.strip().lower()
    direct = params.get("regime_label")
    if isinstance(direct, str) and direct.strip():
        return direct.strip().lower()
    regime = params.get("regime")
    if isinstance(regime, Mapping):
        regime_map = cast(Mapping[str, Any], regime)
        label = regime_map.get("label")
        if isinstance(label, str) and label.strip():
            return label.strip().lower()
    return None


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
    fallback_roots = [Path("/tmp/torghut/autonomy"), Path("/tmp/torghut"), Path("/tmp")]

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


def _hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
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
            "trading_parity_policy": settings.trading_parity_policy,
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
            "parity_policy": settings.trading_parity_policy,
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

    def _build_pipeline(self) -> TradingPipeline:
        price_fetcher = ClickHousePriceFetcher()
        strategy_catalog = StrategyCatalog.from_settings()
        alpaca_client = TorghutAlpacaClient()
        order_firewall = OrderFirewall(alpaca_client)
        execution_adapter = build_execution_adapter(
            alpaca_client=alpaca_client, order_firewall=order_firewall
        )
        return TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=order_firewall,
            ingestor=ClickHouseSignalIngestor(),
            decision_engine=DecisionEngine(price_fetcher=price_fetcher),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=execution_adapter,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=self.state,
            account_label=settings.trading_account_label,
            price_fetcher=price_fetcher,
            strategy_catalog=strategy_catalog,
            order_feed_ingestor=OrderFeedIngestor(),
        )

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

        reasons: list[str] = []
        lag_seconds = self.state.metrics.signal_lag_seconds
        if (
            isinstance(lag_seconds, int)
            and lag_seconds >= settings.trading_rollback_signal_lag_seconds_limit
        ):
            if self._is_market_session_open():
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
        for reason in sorted(critical_reasons):
            streak = self.state.metrics.no_signal_reason_streak.get(reason, 0)
            if streak >= critical_staleness_limit:
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

        if self.state.emergency_stop_active:
            self._evaluate_emergency_stop_recovery(reasons)
            return
        if reasons:
            self._trigger_emergency_stop(
                reasons=reasons, fallback_ratio=fallback_ratio, drawdown=drawdown
            )

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
            return
        now = datetime.now(timezone.utc)
        self.state.emergency_stop_active = False
        self.state.emergency_stop_reason = None
        self.state.emergency_stop_triggered_at = None
        self.state.emergency_stop_resolved_at = now
        self.state.emergency_stop_recovery_streak = 0
        logger.info(
            "Emergency stop cleared reason=%s resolved_at=%s", reason, now.isoformat()
        )

    def _is_market_session_open(self, now: datetime | None = None) -> bool:
        trading_client: Any | None = None
        if self._pipeline is not None:
            alpaca_client = cast(Any, self._pipeline.alpaca_client)
            trading_client = getattr(alpaca_client, "trading", None)
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
        logger.error(
            "Emergency stop triggered reasons=%s canceled_open_orders=%s evidence=%s",
            reasons,
            cancelled_count,
            incident_path,
        )

    def _load_last_gate_provenance(self) -> dict[str, str | None]:
        gate_path_raw = self.state.last_autonomy_gates
        payload: dict[str, Any] = {}
        if gate_path_raw:
            try:
                parsed = json.loads(Path(gate_path_raw).read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    payload = cast(dict[str, Any], parsed)
            except Exception:
                payload = {}
        provenance_raw = payload.get("provenance")
        provenance: dict[str, Any] = (
            cast(dict[str, Any], provenance_raw)
            if isinstance(provenance_raw, dict)
            else {}
        )
        return {
            "run_id": str(payload.get("run_id")).strip() or None,
            "gate_report_trace_id": str(provenance.get("gate_report_trace_id")).strip()
            or None,
            "recommendation_trace_id": str(
                provenance.get("recommendation_trace_id")
            ).strip()
            or None,
        }

    async def start(self) -> None:
        if self._task:
            return
        if self._pipeline is None:
            self._pipeline = self._build_pipeline()
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
        if self._pipeline is not None:
            self._pipeline.order_feed_ingestor.close()

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
            try:
                if self._pipeline is None:
                    raise RuntimeError("trading_pipeline_not_initialized")
                await asyncio.to_thread(self._pipeline.run_once)
                self.state.last_run_at = datetime.now(timezone.utc)
                self.state.last_error = None
            except Exception as exc:  # pragma: no cover - loop guard
                logger.exception("Trading loop failed: %s", exc)
                self.state.last_error = str(exc)
            finally:
                self._evaluate_safety_controls()

            now = datetime.now(timezone.utc)
            if now - last_reconcile >= timedelta(seconds=reconcile_interval):
                try:
                    if self._pipeline is None:
                        raise RuntimeError("trading_pipeline_not_initialized")
                    updates = await asyncio.to_thread(self._pipeline.reconcile)
                    if updates:
                        logger.info("Reconciled %s executions", updates)
                    self.state.last_reconcile_at = datetime.now(timezone.utc)
                    self.state.last_error = None
                except Exception as exc:  # pragma: no cover - loop guard
                    logger.exception("Reconcile loop failed: %s", exc)
                    self.state.last_error = str(exc)
                finally:
                    self._evaluate_safety_controls()
                last_reconcile = now

            if settings.trading_autonomy_enabled and now - last_autonomy >= timedelta(
                seconds=autonomy_interval
            ):
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
                finally:
                    self._evaluate_safety_controls()
                    last_autonomy = now

            if (
                settings.trading_evidence_continuity_enabled
                and now - last_evidence_check >= timedelta(seconds=evidence_interval)
            ):
                try:
                    if self._pipeline is None:
                        raise RuntimeError("trading_pipeline_not_initialized")
                    await asyncio.to_thread(self._run_evidence_continuity_check)
                except Exception as exc:  # pragma: no cover - loop guard
                    logger.exception("Evidence continuity check failed: %s", exc)
                    self.state.last_error = str(exc)
                finally:
                    last_evidence_check = now

            await asyncio.sleep(poll_interval)

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

    def _run_autonomous_cycle(self) -> None:
        if self._pipeline is None:
            raise RuntimeError("trading_pipeline_not_initialized")

        strategy_config_path = settings.trading_strategy_config_path
        gate_policy_path = settings.trading_autonomy_gate_policy_path
        if not strategy_config_path:
            raise RuntimeError("strategy_config_path_missing_for_autonomy")
        if not gate_policy_path:
            raise RuntimeError("autonomy_gate_policy_path_missing")

        artifact_root = _resolve_autonomy_artifact_root(
            Path(settings.trading_autonomy_artifact_dir)
        )

        now = datetime.now(timezone.utc)
        lookback_minutes = max(
            1, int(settings.trading_autonomy_signal_lookback_minutes)
        )
        start = now - timedelta(minutes=lookback_minutes)
        autonomy_batch = self._pipeline.ingestor.fetch_signals_with_reason(
            start=start, end=now
        )
        signals = autonomy_batch.signals
        self.state.last_ingest_signals_total = len(signals)
        self.state.last_ingest_window_start = autonomy_batch.query_start
        self.state.last_ingest_window_end = autonomy_batch.query_end
        self.state.last_ingest_reason = autonomy_batch.no_signal_reason
        self.state.last_autonomy_run_at = now
        self.state.autonomy_signals_total = len(signals)
        if not signals:
            self._pipeline.record_no_signal_batch(autonomy_batch)
            self.state.autonomy_no_signal_streak += 1
            self.state.metrics.no_signal_streak = self.state.autonomy_no_signal_streak
            run_output_dir = artifact_root / now.strftime("%Y%m%dT%H%M%S")
            run_output_dir.mkdir(parents=True, exist_ok=True)
            no_signal_path = run_output_dir / "no-signals.json"
            reason = autonomy_batch.no_signal_reason or "no_signal"
            no_signal_reason_record = {
                "status": "skipped",
                "no_signal_reason": reason,
                "query_start": autonomy_batch.query_start.isoformat()
                if autonomy_batch.query_start
                else None,
                "query_end": autonomy_batch.query_end.isoformat()
                if autonomy_batch.query_end
                else None,
            }
            no_signal_path.write_text(
                json.dumps(no_signal_reason_record, indent=2), encoding="utf-8"
            )

            self.state.last_autonomy_run_id = None
            self.state.last_autonomy_gates = str(no_signal_path)
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
            query_start = autonomy_batch.query_start or start
            query_end = autonomy_batch.query_end or now
            try:
                self.state.last_autonomy_run_id = upsert_autonomy_no_signal_run(
                    session_factory=self._pipeline.session_factory,
                    query_start=query_start,
                    query_end=query_end,
                    strategy_config_path=Path(strategy_config_path),
                    gate_policy_path=Path(gate_policy_path),
                    no_signal_reason=reason,
                    now=now,
                    code_version="live",
                )
            except Exception as exc:
                self.state.autonomy_failure_streak += 1
                self.state.last_autonomy_reason = (
                    "autonomy_no_signal_persistence_failed"
                )
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
                autonomy_batch.no_signal_reason,
                autonomy_batch.query_start,
                autonomy_batch.query_end,
            )
            self._evaluate_safety_controls()
            return

        run_output_dir = artifact_root / now.strftime("%Y%m%dT%H%M%S")
        run_output_dir.mkdir(parents=True, exist_ok=True)
        signals_path = run_output_dir / "signals.json"
        signal_payloads = [signal.model_dump(mode="json") for signal in signals]
        signals_path.write_text(json.dumps(signal_payloads, indent=2), encoding="utf-8")

        self.state.autonomy_no_signal_streak = 0
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.signal_lag_seconds = None
        self.state.autonomy_signals_total = len(signals)
        drift_gate_evidence = self._current_drift_gate_evidence(now=now)

        promotion_target: Literal["paper", "live"]
        approval_token: str | None
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
                promotion_target = "paper"
                approval_token = None
            else:
                promotion_target = "live"
                approval_token = settings.trading_autonomy_approval_token
        elif (
            settings.trading_autonomy_allow_live_promotion
            and not settings.trading_autonomy_approval_token
        ):
            logger.warning(
                "Autonomy live promotion enabled but no approval token configured; fallback to paper target."
            )
            promotion_target = "paper"
            approval_token = None
        else:
            promotion_target = "paper"
            approval_token = None

        try:
            result = run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=Path(strategy_config_path),
                gate_policy_path=Path(gate_policy_path),
                output_dir=run_output_dir,
                promotion_target=promotion_target,
                strategy_configmap_path=Path("/etc/torghut/strategies.yaml"),
                code_version="live",
                approval_token=approval_token,
                drift_promotion_evidence=drift_gate_evidence,
                persist_results=True,
                session_factory=self._pipeline.session_factory,
            )
        except Exception as exc:
            self.state.autonomy_failure_streak += 1
            self.state.last_autonomy_error = str(exc)
            self.state.last_autonomy_reason = "lane_execution_failed"
            logger.exception("Autonomous lane execution failed: %s", exc)
            self._evaluate_safety_controls()
            return

        self.state.autonomy_failure_streak = 0
        self.state.autonomy_runs_total += 1
        self.state.last_autonomy_run_id = result.run_id
        self.state.last_autonomy_gates = str(result.gate_report_path)
        self.state.last_autonomy_reason = None

        gate_report = json.loads(result.gate_report_path.read_text(encoding="utf-8"))
        recommended_mode = str(gate_report.get("recommended_mode") or "shadow")
        self.state.last_autonomy_recommendation = recommended_mode
        throughput_raw = gate_report.get("throughput")
        throughput = (
            cast(Mapping[str, Any], throughput_raw)
            if isinstance(throughput_raw, Mapping)
            else {}
        )
        promotion_decision_raw = gate_report.get("promotion_decision")
        promotion_decision = (
            cast(Mapping[str, Any], promotion_decision_raw)
            if isinstance(promotion_decision_raw, Mapping)
            else {}
        )
        promotion_allowed = bool(promotion_decision.get("promotion_allowed", False))
        if promotion_allowed:
            outcome = f"promoted_{recommended_mode}"
        else:
            outcome = f"blocked_{recommended_mode}"
        self.state.metrics.record_autonomy_promotion_outcome(
            signal_count=_int_from_mapping(throughput, "signal_count"),
            decision_count=_int_from_mapping(throughput, "decision_count"),
            trade_count=_int_from_mapping(throughput, "trade_count"),
            recommendation=recommended_mode,
            promotion_allowed=promotion_allowed,
            outcome=outcome,
        )
        recommendation_payload = gate_report.get("promotion_recommendation")
        if isinstance(recommendation_payload, dict):
            recommendation = cast(dict[str, Any], recommendation_payload)
            action = str(recommendation.get("action", "")).strip().lower()
            if action:
                self.state.last_autonomy_promotion_action = action
                self.state.metrics.autonomy_promotion_action_total[action] = (
                    self.state.metrics.autonomy_promotion_action_total.get(action, 0)
                    + 1
                )
            self.state.last_autonomy_promotion_eligible = bool(
                recommendation.get("eligible", False)
            )
            self.state.last_autonomy_recommendation_trace_id = (
                str(recommendation.get("trace_id", "")).strip() or None
            )
            if action == "promote":
                self.state.metrics.autonomy_promotions_total += 1
            elif action == "deny":
                self.state.metrics.autonomy_denials_total += 1
            elif action == "demote":
                self.state.metrics.autonomy_demotions_total += 1
        else:
            self.state.last_autonomy_promotion_action = None
            self.state.last_autonomy_promotion_eligible = None
            self.state.last_autonomy_recommendation_trace_id = None

        throughput_payload = gate_report.get("throughput")
        if isinstance(throughput_payload, Mapping):
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
        else:
            self.state.last_autonomy_throughput = None

        self.state.last_autonomy_error = None
        if settings.trading_drift_governance_enabled:
            self._evaluate_drift_governance(
                run_output_dir=run_output_dir,
                run_id=result.run_id,
                signals=signals,
                gate_report_payload=gate_report,
                now=now,
            )
        else:
            self.state.drift_status = "disabled"
            self.state.drift_live_promotion_eligible = False
            self.state.drift_live_promotion_reasons = ["drift_governance_disabled"]

        if result.paper_patch_path is not None:
            self.state.last_autonomy_patch = str(result.paper_patch_path)
            self.state.autonomy_patches_total += 1
            self._evaluate_safety_controls()
            return

        self.state.last_autonomy_patch = None
        self._evaluate_safety_controls()


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
