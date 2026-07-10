"""Simplified trading pipeline with a minimal direct-submit hot path."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from sqlalchemy.orm import Session

from ...config import settings
from ...models import (
    Strategy,
)
from ..autonomy import detect_drift
from ..feature_quality import evaluate_feature_batch_quality
from ..ingest import SignalBatch
from ..models import SignalEnvelope
from ..paper_route_target_plan import (
    fetch_paper_route_target_plan_url,
)
from ..proof_floor import build_profitability_proof_floor_receipt
from ..submission_authority import operational_submission_gate_status
from ..submission_council import (
    build_hypothesis_runtime_summary,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..tca import build_tca_gate_inputs
from ..time_source import trading_now
from .pipeline import TradingPipeline
from .pipeline.contexts import (
    AllocationDecisionContext,
    BatchSignalProcessingContext,
    LiveSubmissionGateInputs,
)
from .paper_route_materialization import SimplePipelinePaperRouteMaterializationMixin
from .paper_route_probe.probe_processing import (
    SimplePipelinePaperRouteProbeProcessingMixin,
)
from .paper_route_probe.retry_decisions import (
    SimplePipelinePaperRouteProbeRetryDecisionMixin,
)
from .proof_floor import SimplePipelineProofFloorMixin
from .source_collection.decision_lineage import (
    SimplePipelineSourceCollectionLineageMixin,
)
from .source_collection.source_decisions import (
    SimplePipelineSourceCollectionDecisionMixin,
)
from .source_collection.target_plan_fetch import (
    SimplePipelineSourceCollectionTargetPlanMixin,
)
from .submission_preparation.direct_submission import (
    SimplePipelineDirectSubmissionMixin,
)
from .submission_preparation.quote_routeability import (
    SimplePipelineSubmissionQuoteRouteabilityMixin,
)
from .submission_preparation.quote_sizing import (
    SimplePipelineSubmissionQuoteSizingMixin,
)
from .target_plan_helpers import (
    PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS as _PAPER_ROUTE_TARGET_PLAN_FETCH_ATTEMPTS,
    SIGNAL_INGEST_UNAVAILABLE_REASONS as _SIGNAL_INGEST_UNAVAILABLE_REASONS,
    after_hours_testnet_route_enabled as _after_hours_testnet_route_enabled,
    bounded_sim_collection_reserves_account as _bounded_sim_collection_reserves_account,
    safe_text as _safe_text,
    simple_drift_feature_thresholds as _simple_drift_feature_thresholds,
    simple_drift_thresholds as _simple_drift_thresholds,
    target_requires_bounded_sim_collection_gate as _target_requires_bounded_sim_collection_gate,
    target_probe_window as _target_probe_window,
    target_symbols as _target_symbols,
)


logger = logging.getLogger(__name__)


class SimpleTradingPipeline(
    SimplePipelinePaperRouteProbeRetryDecisionMixin,
    SimplePipelinePaperRouteProbeProcessingMixin,
    SimplePipelinePaperRouteMaterializationMixin,
    SimplePipelineSubmissionQuoteSizingMixin,
    SimplePipelineSubmissionQuoteRouteabilityMixin,
    SimplePipelineDirectSubmissionMixin,
    SimplePipelineSourceCollectionTargetPlanMixin,
    SimplePipelineSourceCollectionDecisionMixin,
    SimplePipelineSourceCollectionLineageMixin,
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
        return trading_now(account_label=getattr(self, "account_label", None))

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
            batch = self._fetch_signal_batch(
                session,
                signal_scope=signal_scope,
                strategies=strategies,
            )
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
                self._commit_signal_cursor(batch)
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
                self._commit_signal_cursor(batch)
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
                context=BatchSignalProcessingContext(
                    session=session,
                    batch=batch,
                    strategies=strategies,
                    account_snapshot=account_snapshot,
                    account=account,
                    positions=positions,
                    allowed_symbols=allowed_symbols,
                )
            )
            self._process_paper_route_probe_retry_decisions_unless_target_reserved(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self._commit_signal_cursor(batch)

    def _fetch_signal_batch(
        self,
        session: Session,
        *,
        signal_scope: tuple[set[str], set[str]] | None,
        strategies: Sequence[Strategy] | None = None,
    ) -> SignalBatch:
        if signal_scope is None:
            signal_scope = self._live_bounded_collection_signal_scope(strategies or ())
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
                "Signal ingestor does not support scoped polling; using unscoped fetch account_label=%s symbols=%s timeframes=%s",
                self.account_label,
                ",".join(sorted(symbols)) or "*",
                ",".join(sorted(timeframes)) or "*",
            )
            return self.ingestor.fetch_signals(session)

    def _live_bounded_collection_signal_scope(
        self,
        strategies: Sequence[Strategy],
    ) -> tuple[set[str], set[str]] | None:
        if settings.trading_mode != "live":
            return None
        if not settings.trading_simple_paper_route_probe_allow_live_mode:
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        symbols = {
            str(symbol).strip().upper()
            for symbol in settings.trading_static_symbols
            if str(symbol).strip()
        }
        timeframes = {
            str(strategy.base_timeframe).strip()
            for strategy in strategies
            if str(strategy.base_timeframe).strip()
        }
        for strategy in strategies:
            if strategy.universe_type != "static":
                continue
            symbols.update(
                str(symbol).strip().upper()
                for symbol in strategy.universe_symbols or ()
                if str(symbol).strip()
            )
        if not symbols:
            return None
        return symbols, timeframes

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
            "degraded_signal_count": len(batch.fallback_signals),
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
            "Blocking bounded paper-route evidence decisions because signal ingest is unavailable account_label=%s reason=%s symbols=%s timeframes=%s degraded_signal_count=%s",
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
        state = getattr(self, "state", None)
        if state is not None:
            setattr(state, "last_bounded_evidence_collection_blocker", blocker)
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
        if settings.trading_mode not in {"paper", "live"}:
            return None
        if (
            settings.trading_mode == "live"
            and not settings.trading_simple_paper_route_probe_allow_live_mode
        ):
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        market_session_open = self._is_market_session_open(now)
        testnet_after_hours_route = _after_hours_testnet_route_enabled(
            trading_mode=settings.trading_mode,
            paper_route_probe_enabled=settings.trading_simple_paper_route_probe_enabled,
            paper_route_probe_allow_live_mode=(
                settings.trading_simple_paper_route_probe_allow_live_mode
            ),
            testnet_after_hours_enabled=settings.trading_testnet_after_hours_enabled,
            market_session_open=market_session_open,
        )
        if not market_session_open and not testnet_after_hours_route:
            return None
        if testnet_after_hours_route:
            return self._live_bounded_collection_signal_scope(strategies)
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
        inputs: LiveSubmissionGateInputs | None = None,
    ) -> dict[str, object]:
        inputs = inputs or LiveSubmissionGateInputs()
        gate = TradingPipeline._live_submission_gate(
            self,
            inputs=inputs,
        )
        if settings.trading_mode != "live":
            return gate

        simple_blocked_reasons: list[str] = []
        if not settings.trading_enabled:
            simple_blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            simple_blocked_reasons.append("kill_switch_enabled")
        if not settings.trading_simple_submit_enabled:
            simple_blocked_reasons.append("submit_disabled")
        if not settings.trading_live_submit_enabled:
            simple_blocked_reasons.append("live_submit_disabled")
        if settings.trading_emergency_stop_enabled and bool(
            getattr(self.state, "emergency_stop_active", False)
        ):
            simple_blocked_reasons.append(
                str(
                    getattr(self.state, "emergency_stop_reason", "")
                    or "emergency_stop_active"
                )
            )

        operational_gate = operational_submission_gate_status(gate)
        gate_blocked_reasons = [
            str(item).strip()
            for item in cast(
                list[object], operational_gate.get("blocked_reasons") or []
            )
            if str(item).strip()
        ]
        merged_blocked_reasons = list(
            dict.fromkeys([*gate_blocked_reasons, *simple_blocked_reasons])
        )
        allowed = bool(operational_gate.get("allowed", False)) and not (
            simple_blocked_reasons
        )
        reason = str(
            simple_blocked_reasons[0]
            if simple_blocked_reasons
            else operational_gate.get("reason") or "operational_submission_ready"
        )
        gate["allowed"] = allowed
        gate["blocked_reasons"] = merged_blocked_reasons
        gate["reason"] = reason
        if simple_blocked_reasons:
            gate["capital_stage"] = "shadow"
            gate["capital_state"] = "observe"
        elif allowed:
            gate["capital_stage"] = "live"
            gate["capital_state"] = "live"
        gate["operational_submission_gate"] = {
            "allowed": allowed,
            "reason": reason,
            "blocked_reasons": merged_blocked_reasons,
            "execution_route": operational_gate.get("execution_route")
            or gate.get("execution_route"),
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
        context: BatchSignalProcessingContext,
    ) -> None:
        allocation_context = AllocationDecisionContext(
            session=context.session,
            strategies=context.strategies,
            account=context.account,
            positions=context.positions,
            allowed_symbols=context.allowed_symbols,
        )
        filtered_signals = self._quality_gate_signals(
            signals=context.batch.signals,
            strategies=context.strategies,
            allowed_symbols=context.allowed_symbols,
        )
        for signal in filtered_signals:
            decisions = self._evaluate_signal_decisions(
                signal,
                context.strategies,
                equity=context.account_snapshot.equity,
                positions=context.positions,
            )
            if not decisions:
                continue
            for decision in decisions:
                self.state.metrics.decisions_total += 1
                try:
                    submitted = self._handle_decision(
                        allocation_context,
                        decision,
                    )
                    if submitted is not None:
                        self._apply_simple_projected_buying_power(
                            context.account,
                            context.positions,
                            submitted,
                        )
                        self._apply_simple_projected_position(
                            context.positions,
                            submitted,
                        )
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
                    AllocationDecisionContext(
                        session=session,
                        strategies=strategies,
                        account=account,
                        positions=positions,
                        allowed_symbols=allowed_symbols,
                    ),
                    decision,
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
