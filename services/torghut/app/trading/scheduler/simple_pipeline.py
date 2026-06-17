"""Simplified trading pipeline with a minimal direct-submit hot path."""
# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false
# ruff: noqa: F401

from __future__ import annotations

import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Literal, Optional, TypeAlias, cast
from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import desc, select  # pyright: ignore[reportUnknownVariableType]
from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Execution,
    PositionSnapshot,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ...strategies.catalog import extract_catalog_metadata
from ..autonomy import DriftThresholds, detect_drift
from ..empirical_jobs import build_empirical_jobs_status
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..firewall import OrderFirewallBlocked
from ..ingest import SignalBatch
from ..models import SignalEnvelope, StrategyDecision
from ..paper_route_target_plan import (
    fetch_paper_route_target_plan_url,
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ..prices import MarketSnapshot
from ..quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    status as _status,
    assess_signal_quote_quality,
)
from ..quantity_rules import quantize_qty_for_symbol, resolve_quantity_resolution
from ..proof_floor import build_profitability_proof_floor_receipt
from ..runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_strategy_resolution import strategy_names_from_strategy_id
from ..session_context import regular_session_open_utc_for
from ..simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
from ..submission_council import (
    build_hypothesis_runtime_summary,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..live_submit_activation import (
    live_submit_activation_blocker,
    live_submit_activation_status,
)
from ..tca import build_tca_gate_inputs
from ..time_source import trading_now
from .pipeline import TradingPipeline
from .pipeline_helpers import (
    extract_json_error_payload as _extract_json_error_payload,
    price_snapshot_payload as _price_snapshot_payload,
)
from .paper_route_materialization import SimplePipelinePaperRouteMaterializationMixin
from .paper_route_probe import SimplePipelinePaperRouteProbeMixin
from .proof_floor import SimplePipelineProofFloorMixin
from .source_collection import SimplePipelineSourceCollectionMixin
from .submission_preparation import SimplePipelineSubmissionPreparationMixin
from .target_plan_helpers import (
    PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS as _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
    SIGNAL_INGEST_UNAVAILABLE_REASONS as _SIGNAL_INGEST_UNAVAILABLE_REASONS,
    TargetProbeQuantityResolution as _TargetProbeQuantityResolution,
    bounded_paper_route_collection_entry_metadata as _bounded_paper_route_collection_entry_metadata,
    bounded_sim_collection_blockers as _bounded_sim_collection_blockers,
    bounded_sim_collection_metadata_from_decision as _bounded_sim_collection_metadata_from_decision,
    bounded_sim_collection_reserves_account as _bounded_sim_collection_reserves_account,
    bounded_sim_collection_target_with_runtime_account_audit as _bounded_sim_collection_target_with_runtime_account_audit,
    executable_bid_ask_present as _executable_bid_ask_present,
    paper_route_probe_entry_metadata as _paper_route_probe_entry_metadata,
    paper_route_probe_lineage_from_params as _paper_route_probe_lineage_from_params,
    parse_target_datetime as _parse_target_datetime,
    quote_snapshot_matches_symbol as _quote_snapshot_matches_symbol,
    quote_snapshot_reference_price as _quote_snapshot_reference_price,
    safe_text as _safe_text,
    safe_int as _safe_int,
    simple_drift_feature_thresholds as _simple_drift_feature_thresholds,
    simple_drift_thresholds as _simple_drift_thresholds,
    strategy_signal_paper_entry_metadata as _strategy_signal_paper_entry_metadata,
    target_active_in_window as _target_active_in_window,
    target_metadata_quote_snapshot as _target_metadata_quote_snapshot,
    target_notional_sizing_audit_from_params as _target_notional_sizing_audit_from_params,
    target_pair_balance_state as _target_pair_balance_state,
    target_probe_action as _target_probe_action,
    target_requires_bounded_sim_collection_gate as _target_requires_bounded_sim_collection_gate,
    target_probe_symbol_actions as _target_probe_symbol_actions,
    target_probe_symbol_notional_budget as _target_probe_symbol_notional_budget,
    target_probe_symbol_quantities as _target_probe_symbol_quantities,
    target_probe_window as _target_probe_window,
    target_runtime_account_matches as _target_runtime_account_matches,
    target_symbols as _target_symbols,
    target_truthy as _target_truthy,
)


logger = logging.getLogger(__name__)


class SimpleTradingPipeline(
    SimplePipelinePaperRouteProbeMixin,
    SimplePipelinePaperRouteMaterializationMixin,
    SimplePipelineSubmissionPreparationMixin,
    SimplePipelineSourceCollectionMixin,
    SimplePipelineProofFloorMixin,
    TradingPipeline,
):
    """Minimal signal -> hard-risk -> direct execution lane."""

    _paper_route_target_plan_cache: (
        tuple[
            set[str],
            str | None,
            list[dict[str, Any]],
            datetime,
        ]
        | None
    ) = None
    _paper_route_target_plan_success_cache: (
        tuple[
            set[str],
            list[dict[str, Any]],
            datetime,
        ]
        | None
    ) = None

    def _trading_now(self) -> datetime:
        return trading_now(account_label=self.account_label)

    def _fetch_paper_route_target_plan_url(
        self,
        url: str,
        *,
        timeout_seconds: float,
        attempts: int,
        retry_backoff_seconds: float,
    ) -> Mapping[str, Any]:
        return fetch_paper_route_target_plan_url(
            url,
            timeout_seconds=timeout_seconds,
            attempts=attempts,
            retry_backoff_seconds=retry_backoff_seconds,
        )

    def _build_submission_gate_market_context_status(self) -> Mapping[str, Any]:
        return build_submission_gate_market_context_status(self.state)

    def _build_hypothesis_runtime_summary(
        self,
        session: Session,
        *,
        market_context_status: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        return build_hypothesis_runtime_summary(
            session,
            state=self.state,
            market_context_status=market_context_status,
        )

    def _build_empirical_jobs_status(self, *, session: Session) -> Mapping[str, Any]:
        return build_empirical_jobs_status(
            session=session,
            stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
        )

    def _load_quant_evidence_status(self) -> Mapping[str, Any]:
        return load_quant_evidence_status(account_label=self.account_label)

    def _build_tca_gate_inputs(self, *, session: Session) -> Mapping[str, Any]:
        return build_tca_gate_inputs(
            session=session,
            account_label=self.account_label,
            symbols=self.universe_resolver.get_resolution().symbols,
        )

    def _build_profitability_proof_floor_receipt(
        self,
        **kwargs: Any,
    ) -> Mapping[str, Any]:
        return build_profitability_proof_floor_receipt(**kwargs)

    def run_once(self) -> None:
        self._label_mature_rejected_signal_outcome_events()
        with self.session_factory() as session:
            self.state.metrics.planned_decision_age_seconds = 0
            strategies = self._prepare_run_once(session)
            if not strategies:
                return
            self._capture_runtime_window_account_snapshot_if_due(session)
            self._warm_session_context_from_open(session, strategies=strategies)

            signal_scope = self._bounded_paper_route_signal_scope(
                strategies,
                session=session,
            )
            batch = self._fetch_signal_batch(session, signal_scope=signal_scope)
            self._record_ingest_window(batch)
            if self._signal_ingest_unavailable(batch):
                self._prepare_batch_for_decisions(
                    session,
                    batch,
                    quality_signals=[],
                )
                context = self._build_run_context(session)
                if context is not None:
                    _account_snapshot, account, positions, allowed_symbols = context
                    self._process_paper_route_probe_exit_decisions(
                        session=session,
                        strategies=strategies,
                        account=account,
                        positions=positions,
                        allowed_symbols=allowed_symbols,
                    )
                    self._process_paper_route_materialized_decisions(
                        session=session,
                        strategies=strategies,
                        account=account,
                        positions=positions,
                        allowed_symbols=allowed_symbols,
                    )
                    self._process_paper_route_probe_retry_decisions_unless_target_reserved(
                        session=session,
                        strategies=strategies,
                        account=account,
                        positions=positions,
                        allowed_symbols=allowed_symbols,
                    )
                self._record_bounded_signal_ingest_blocker(
                    batch=batch,
                    signal_scope=signal_scope,
                )
                return
            if not batch.signals:
                self._prepare_batch_for_decisions(
                    session,
                    batch,
                    quality_signals=batch.signals,
                )
                context = self._build_run_context(session)
                if context is None:
                    return
                _account_snapshot, account, positions, allowed_symbols = context
                self._process_paper_route_probe_exit_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                self._process_paper_route_materialized_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                self._process_paper_route_target_source_decisions(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                self._process_paper_route_probe_retry_decisions_unless_target_reserved(
                    session=session,
                    strategies=strategies,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
                return
            context = self._build_run_context(session)
            if context is None:
                self.ingestor.commit_cursor(session, batch)
                return
            account_snapshot, account, positions, allowed_symbols = context
            self._process_paper_route_probe_exit_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._process_paper_route_materialized_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._process_paper_route_target_source_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            if self._paper_route_target_plan_reserves_account(
                allowed_symbols=allowed_symbols
            ):
                logger.info(
                    "Skipping regular simple-lane signal processing while bounded "
                    "paper-route evidence collection owns account=%s",
                    self.account_label,
                )
                self.ingestor.commit_cursor(session, batch)
                return
            quality_signals = self._quality_gate_signals(
                signals=batch.signals,
                strategies=strategies,
                allowed_symbols=allowed_symbols,
            )
            if not self._prepare_batch_for_decisions(
                session,
                batch,
                quality_signals=quality_signals,
            ):
                return
            self._process_batch_signals(
                session=session,
                batch=batch,
                strategies=strategies,
                account_snapshot=account_snapshot,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._process_paper_route_probe_retry_decisions_unless_target_reserved(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self.ingestor.commit_cursor(session, batch)

    def _fetch_signal_batch(
        self,
        session: Session,
        *,
        signal_scope: tuple[set[str], set[str]] | None,
    ) -> SignalBatch:
        if signal_scope is None:
            return self.ingestor.fetch_signals(session)
        symbols, timeframes = signal_scope
        try:
            return self.ingestor.fetch_signals(
                session,
                symbols=symbols,
                timeframes=timeframes,
            )
        except TypeError as exc:
            if "unexpected keyword" not in str(exc):
                raise
            logger.warning(
                "Signal ingestor does not support scoped polling; falling back to unscoped fetch account_label=%s symbols=%s timeframes=%s",
                self.account_label,
                ",".join(sorted(symbols)) or "*",
                ",".join(sorted(timeframes)) or "*",
            )
            return self.ingestor.fetch_signals(session)

    @staticmethod
    def _signal_ingest_unavailable(batch: SignalBatch) -> bool:
        return (
            batch.no_signal_reason in _SIGNAL_INGEST_UNAVAILABLE_REASONS
            or not batch.signals_authoritative
        )

    def _record_bounded_signal_ingest_blocker(
        self,
        *,
        batch: SignalBatch,
        signal_scope: tuple[set[str], set[str]] | None,
    ) -> None:
        reason = batch.no_signal_reason or "signal_ingest_unavailable"
        symbols: set[str] = set()
        timeframes: set[str] = set()
        if signal_scope is not None:
            symbols, timeframes = signal_scope
        blocker = {
            "blockers": [reason],
            "reason": reason,
            "account_label": self.account_label,
            "symbols": sorted(symbols),
            "timeframes": sorted(timeframes),
            "signals_authoritative": batch.signals_authoritative,
            "fallback_signal_count": len(batch.fallback_signals),
            "degraded_signal_source": batch.degraded_signal_source,
            "query_start": batch.query_start.isoformat()
            if batch.query_start is not None
            else None,
            "query_end": batch.query_end.isoformat()
            if batch.query_end is not None
            else None,
        }
        setattr(self.state, "last_bounded_evidence_collection_blocker", blocker)
        logger.warning(
            "Blocking bounded paper-route evidence decisions because signal ingest is unavailable account_label=%s reason=%s symbols=%s timeframes=%s fallback_signal_count=%s",
            self.account_label,
            reason,
            ",".join(sorted(symbols)) or "*",
            ",".join(sorted(timeframes)) or "*",
            len(batch.fallback_signals),
        )

    def _record_bounded_target_plan_blocker(
        self,
        *,
        reason: str,
        symbols: set[str] | None = None,
        targets: Sequence[Mapping[str, Any]] | None = None,
    ) -> None:
        normalized_reason = reason.strip() or "paper_route_target_plan_unavailable"
        blocker = {
            "blockers": [normalized_reason],
            "reason": normalized_reason,
            "account_label": self.account_label,
            "source": "external_target_plan_url",
            "target_plan_url_configured": bool(
                str(settings.trading_paper_route_target_plan_url or "").strip()
            ),
            "target_symbols": sorted(symbols or set()),
            "target_count": len(targets or []),
            "fetch_attempts": _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
        }
        setattr(self.state, "last_bounded_evidence_collection_blocker", blocker)
        logger.warning(
            "Blocking bounded paper-route evidence decisions because target plan is unavailable account_label=%s reason=%s symbols=%s target_count=%s attempts=%s",
            self.account_label,
            normalized_reason,
            ",".join(sorted(symbols or set())) or "*",
            len(targets or []),
            _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
        )

    def _bounded_paper_route_signal_scope(
        self,
        strategies: Sequence[Strategy],
        *,
        session: Session | None = None,
    ) -> tuple[set[str], set[str]] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            return None
        target_symbols, target_plan_error, targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            self._record_bounded_target_plan_blocker(
                reason=target_plan_error,
                symbols=target_symbols,
                targets=targets,
            )
            return None
        if not target_symbols:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason="paper_route_target_plan_probe_symbols_missing",
                    symbols=target_symbols,
                    targets=targets,
                )
            return None

        symbols: set[str] = set()
        timeframes: set[str] = set()
        for target in targets:
            if not _target_requires_bounded_sim_collection_gate(target):
                continue
            if not _bounded_sim_collection_reserves_account(
                target,
                account_label=self.account_label,
            ):
                continue
            window = _target_probe_window(target)
            if window is None:
                continue
            window_start, window_end = window
            if now < window_start or now >= window_end:
                continue
            strategy = self._paper_route_target_strategy(target, strategies)
            if strategy is None:
                continue
            scoped_symbols = _target_symbols(target) & target_symbols
            strategy_symbols = self._paper_route_target_strategy_symbols(strategy)
            if strategy_symbols:
                scoped_symbols = scoped_symbols & strategy_symbols
            symbols.update(scoped_symbols)
            timeframe = (
                _safe_text(target.get("timeframe"))
                or _safe_text(target.get("base_timeframe"))
                or _safe_text(strategy.base_timeframe)
            )
            if timeframe:
                timeframes.add(timeframe)
        if not symbols:
            return None
        return symbols, timeframes

    def _live_submission_gate(
        self,
        *,
        session: Session | None = None,
        hypothesis_summary: Mapping[str, Any] | None = None,
        empirical_jobs_status: Mapping[str, Any] | None = None,
        dspy_runtime_status: Mapping[str, Any] | None = None,
        quant_health_status: Mapping[str, Any] | None = None,
    ) -> dict[str, object]:
        gate = super()._live_submission_gate(
            session=session,
            hypothesis_summary=hypothesis_summary,
            empirical_jobs_status=empirical_jobs_status,
            dspy_runtime_status=dspy_runtime_status,
            quant_health_status=quant_health_status,
        )
        if settings.trading_mode != "live":
            return gate

        simple_blocked_reasons: list[str] = []
        if not settings.trading_enabled:
            simple_blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            simple_blocked_reasons.append("kill_switch_enabled")
        if not settings.trading_simple_submit_enabled:
            simple_blocked_reasons.append("simple_submit_disabled")
        activation_blocker = live_submit_activation_blocker()
        if activation_blocker is not None:
            simple_blocked_reasons.append(activation_blocker)
        if settings.trading_emergency_stop_enabled and bool(
            getattr(self.state, "emergency_stop_active", False)
        ):
            simple_blocked_reasons.append(
                str(
                    getattr(self.state, "emergency_stop_reason", "")
                    or "emergency_stop_active"
                )
            )

        gate_blocked_reasons = [
            str(item).strip()
            for item in cast(list[object], gate.get("blocked_reasons") or [])
            if str(item).strip()
        ]
        merged_blocked_reasons = list(
            dict.fromkeys([*gate_blocked_reasons, *simple_blocked_reasons])
        )
        gate["allowed"] = (
            bool(gate.get("allowed", False)) and not simple_blocked_reasons
        )
        gate["blocked_reasons"] = merged_blocked_reasons
        if simple_blocked_reasons:
            gate["reason"] = simple_blocked_reasons[0]
            gate["capital_stage"] = "shadow"
            gate["capital_state"] = "observe"
        gate["pipeline_mode"] = "simple"
        gate["simple_lane"] = {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": simple_blocked_reasons,
            "live_submit_activation": live_submit_activation_status(),
            "paper_route_probe_max_notional": (
                settings.trading_simple_paper_route_probe_max_notional
            ),
            "max_notional_per_order": settings.trading_simple_max_notional_per_order,
            "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
            "max_gross_exposure_pct_equity": (
                settings.trading_simple_max_gross_exposure_pct_equity
            ),
        }
        self._last_live_submission_gate = dict(gate)
        return gate

    def _prepare_run_once(self, session: Session) -> list[Strategy]:
        if settings.trading_simple_order_feed_telemetry_enabled:
            self._ingest_order_feed(session)
        self.order_firewall.cancel_open_orders_if_kill_switch()
        if self.strategy_catalog is not None:
            self.strategy_catalog.refresh(session)
        self._refresh_market_context_for_proof_floor()
        strategies = self._load_strategies(session)
        if not strategies:
            logger.info("No enabled strategies found; skipping simple trading cycle")
        return strategies

    def _prepare_batch_for_decisions(
        self,
        session: Session,
        batch: SignalBatch,
        *,
        quality_signals: list[SignalEnvelope],
    ) -> bool:
        if not super()._prepare_batch_for_decisions(
            session,
            batch,
            quality_signals=quality_signals,
        ):
            return False
        self._run_simple_drift_check(quality_signals)
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.last_signal_continuity_state = "signals_present"
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = False
        return True

    def _run_simple_drift_check(self, quality_signals: list[SignalEnvelope]) -> None:
        if not settings.trading_drift_governance_enabled or not quality_signals:
            return
        now = datetime.now(timezone.utc)
        feature_report = evaluate_feature_batch_quality(
            quality_signals,
            thresholds=_simple_drift_feature_thresholds(),
        )
        fallback_total = sum(self.state.metrics.execution_fallback_total.values())
        submitted_total = max(1, self.state.metrics.orders_submitted_total)
        detection = detect_drift(
            run_id=f"simple-runtime:{self.account_label}:{now.isoformat()}",
            feature_quality_report=feature_report,
            gate_report_payload={},
            fallback_ratio=Decimal(str(fallback_total / submitted_total)),
            thresholds=_simple_drift_thresholds(),
            detected_at=now,
        )
        self.state.metrics.drift_detection_checks_total += 1
        self.state.drift_last_detection_at = detection.detected_at
        if detection.drift_detected:
            self.state.metrics.drift_incidents_total += 1
            self.state.drift_active_incident_id = detection.incident_id
            self.state.drift_active_reason_codes = list(detection.reason_codes)
            self.state.drift_status = "drift_detected"
            self.state.drift_live_promotion_eligible = False
            self.state.drift_live_promotion_reasons = list(detection.reason_codes)
            for reason_code in detection.reason_codes:
                self.state.metrics.drift_incident_reason_total[reason_code] = (
                    self.state.metrics.drift_incident_reason_total.get(reason_code, 0)
                    + 1
                )
        else:
            self.state.drift_active_incident_id = None
            self.state.drift_active_reason_codes = []
            self.state.drift_status = "stable"
            self.state.drift_live_promotion_eligible = True
            self.state.drift_live_promotion_reasons = []

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
        filtered_signals = self._quality_gate_signals(
            signals=batch.signals,
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        for signal in filtered_signals:
            decisions = self._evaluate_signal_decisions(
                signal,
                strategies,
                equity=account_snapshot.equity,
                positions=positions,
            )
            if not decisions:
                continue
            for decision in decisions:
                self.state.metrics.decisions_total += 1
                try:
                    submitted = self._handle_decision(
                        session,
                        decision,
                        strategies,
                        account,
                        positions,
                        allowed_symbols,
                    )
                    if submitted is not None:
                        self._apply_simple_projected_buying_power(
                            account,
                            positions,
                            submitted,
                        )
                        self._apply_simple_projected_position(positions, submitted)
                except Exception:
                    logger.exception(
                        "Simple decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                        decision.strategy_id,
                        decision.symbol,
                        decision.timeframe,
                    )
                    self.state.metrics.orders_rejected_total += 1
                    self.state.metrics.record_decision_rejection_reasons(
                        ["broker_submit_failed"]
                    )

    def _process_paper_route_target_source_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_target_source_decisions(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
            positions=positions,
            session=session,
        )
        for decision in decisions:
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    decision,
                    strategies,
                    account,
                    positions,
                    allowed_symbols,
                )
                if submitted is not None:
                    self._apply_simple_projected_buying_power(
                        account,
                        positions,
                        submitted,
                    )
                    self._apply_simple_projected_position(positions, submitted)
            except Exception:
                logger.exception(
                    "Paper-route target source decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )
