"""Simplified trading pipeline with a minimal direct-submit hot path."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Optional, cast

from sqlalchemy.orm import Session

from ...config import settings
from ...models import Strategy, TradeDecision
from ..autonomy import DriftThresholds, detect_drift
from ..empirical_jobs import build_empirical_jobs_status
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..firewall import OrderFirewallBlocked
from ..ingest import SignalBatch
from ..models import SignalEnvelope, StrategyDecision
from ..paper_route_target_plan import (
    fetch_paper_route_target_plan_url,
    paper_route_target_plan_probe_symbols,
)
from ..prices import MarketSnapshot
from ..proof_floor import build_profitability_proof_floor_receipt
from ..simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
from ..submission_council import (
    build_hypothesis_runtime_summary,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..tca import build_tca_gate_inputs
from .pipeline import TradingPipeline
from .pipeline_helpers import (
    _extract_json_error_payload,
)

logger = logging.getLogger(__name__)

_SIMPLE_ALLOWED_REJECT_REASONS = {
    "kill_switch_enabled",
    "invalid_qty_increment",
    "qty_below_min_after_clamp",
    "insufficient_buying_power",
    "max_notional_exceeded",
    "max_symbol_exposure_exceeded",
    "shorting_not_allowed_for_asset",
    "broker_precheck_failed",
    "broker_submit_failed",
}
_PAPER_ROUTE_PROBE_REASONS = {
    "execution_tca_route_universe_empty",
    "execution_tca_symbol_missing",
    "route_tca_passed_but_dependency_receipts_block_capital",
    "tca_evidence_stale",
}
_PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS = 86_400
_SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL = timedelta(seconds=30)
_PAPER_ROUTE_PROBE_QTY_STEP = Decimal("0.0001")


class SimpleTradingPipeline(TradingPipeline):
    """Minimal signal -> hard-risk -> direct execution lane."""

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

    def _submission_control_plane_snapshot(
        self,
        *,
        capital_stage: str | None = None,
    ) -> dict[str, object]:
        snapshot = super()._submission_control_plane_snapshot(
            capital_stage=capital_stage
        )
        snapshot["pipeline_mode"] = settings.trading_pipeline_mode
        snapshot["execution_lane"] = "simple"
        snapshot["submit_path"] = "direct_alpaca"
        return snapshot

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
        decision, snapshot = self._ensure_decision_price(
            decision, signal_price=decision.params.get("price")
        )
        max_notional_per_order = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_max_notional_per_order),
            _optional_decimal(settings.trading_max_notional_per_trade),
            _optional_decimal(strategy.max_notional_per_trade),
        )
        equity = _optional_decimal(account.get("equity"))
        max_notional_per_symbol = _min_optional_decimal(
            _optional_decimal(settings.trading_simple_max_notional_per_symbol),
            _optional_decimal(settings.trading_allocator_max_symbol_notional),
            _pct_cap_to_notional(
                equity=equity,
                pct=_optional_decimal(settings.trading_max_position_pct_equity),
            ),
            _pct_cap_to_notional(
                equity=equity,
                pct=_optional_decimal(strategy.max_position_pct_equity),
            ),
        )
        preparation = prepare_simple_decision(
            decision=decision,
            account=account,
            positions=positions,
            fractional_equities_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            max_notional_per_order=max_notional_per_order,
            max_notional_per_symbol=max_notional_per_symbol,
            buying_power_reserve_bps=_optional_decimal(
                settings.trading_simple_buying_power_reserve_bps
            )
            or Decimal("0"),
        )
        self.executor.sync_decision_state(session, decision_row, preparation.decision)
        if preparation.diagnostics:
            params_update = dict(preparation.decision.params)
            params_update["simple_lane_precheck"] = preparation.diagnostics
            self.executor.update_decision_params(session, decision_row, params_update)
        if not preparation.approved or preparation.reject_reason is not None:
            reason = preparation.reject_reason or "broker_precheck_failed"
            self._record_decision_rejection(
                session=session,
                decision=preparation.decision,
                decision_row=decision_row,
                reasons=[reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        return preparation.decision, snapshot

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
        _ = (strategy, account, symbol_allowlist, execution_advisor)
        short_reason = self._simple_shortability_reason(
            decision=decision,
            positions=positions,
        )
        if short_reason is None:
            return True
        self._record_decision_rejection(
            session=session,
            decision=decision,
            decision_row=decision_row,
            reasons=[short_reason],
            log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
        )
        return False

    def _profitability_proof_floor(self, *, session: Session) -> Mapping[str, object]:
        try:
            self._refresh_market_context_for_proof_floor()
            market_context_status = build_submission_gate_market_context_status(
                self.state
            )
            hypothesis_payload = build_hypothesis_runtime_summary(
                session,
                state=self.state,
                market_context_status=market_context_status,
            )
            empirical_jobs_status = build_empirical_jobs_status(
                session=session,
                stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
            )
            quant_evidence = load_quant_evidence_status(
                account_label=self.account_label
            )
            live_submission_gate = self._live_submission_gate(
                session=session,
                hypothesis_summary=hypothesis_payload,
                empirical_jobs_status=empirical_jobs_status,
                quant_health_status=quant_evidence,
            )
            return build_profitability_proof_floor_receipt(
                account_label=self.account_label,
                torghut_revision=None,
                trading_mode=settings.trading_mode,
                market_session_open=cast(
                    bool | None,
                    getattr(self.state, "market_session_open", None),
                ),
                live_submission_gate=live_submission_gate,
                hypothesis_payload=hypothesis_payload,
                empirical_jobs_status=empirical_jobs_status,
                quant_evidence=quant_evidence,
                market_context_status=market_context_status,
                tca_summary=build_tca_gate_inputs(
                    session=session,
                    account_label=self.account_label,
                    symbols=self.universe_resolver.get_resolution().symbols,
                ),
                simple_lane_status={
                    "enabled": settings.trading_pipeline_mode == "simple",
                    "submit_enabled": settings.trading_simple_submit_enabled,
                    "order_feed_telemetry_enabled": (
                        settings.trading_simple_order_feed_telemetry_enabled
                    ),
                    "paper_route_probe_enabled": (
                        settings.trading_simple_paper_route_probe_enabled
                    ),
                    "paper_route_probe_max_notional": (
                        settings.trading_simple_paper_route_probe_max_notional
                    ),
                    "route_symbol_filter_enabled": True,
                    "max_notional_per_order": settings.trading_simple_max_notional_per_order,
                    "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
                    "allowed_reject_reasons": sorted(_SIMPLE_ALLOWED_REJECT_REASONS),
                },
                tca_max_age_seconds=_PROFITABILITY_PROOF_FLOOR_TCA_MAX_AGE_SECONDS,
            )
        except Exception as exc:  # pragma: no cover - defensive capital safety
            logger.exception("Simple-lane proof floor unavailable")
            return {
                "schema_version": "torghut.profitability-proof-floor.v1",
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    f"profitability_proof_floor_unavailable:{type(exc).__name__}"
                ],
            }

    def _refresh_market_context_for_proof_floor(self) -> None:
        """Keep simple-lane proof-floor market context fresh without the LLM path.

        The legacy pipeline records market context while building LLM review
        requests. Simple mode can run with LLM disabled, so the proof floor must
        refresh the same state explicitly before alpha-readiness checks.
        """

        if not settings.trading_market_context_url:
            return

        now = datetime.now(timezone.utc)
        self._age_market_context_freshness(now)
        if self._market_context_refresh_recent(now):
            return
        freshness_seconds = self.state.last_market_context_freshness_seconds
        if (
            freshness_seconds is not None
            and freshness_seconds
            <= settings.trading_market_context_max_staleness_seconds
            and not self.state.market_context_alert_active
        ):
            return

        symbol = self._market_context_probe_symbol()
        if not symbol:
            return
        market_context, market_context_error = self._fetch_market_context(symbol)
        self._record_market_context_observation(
            symbol=symbol,
            market_context=market_context,
            market_context_error=market_context_error,
        )

    def _age_market_context_freshness(self, now: datetime) -> None:
        as_of = self.state.last_market_context_as_of
        if as_of is None:
            return
        if as_of.tzinfo is None:
            as_of = as_of.replace(tzinfo=timezone.utc)
        freshness_seconds = max(
            0,
            int(
                (
                    now.astimezone(timezone.utc) - as_of.astimezone(timezone.utc)
                ).total_seconds()
            ),
        )
        self.state.last_market_context_freshness_seconds = freshness_seconds

    def _market_context_refresh_recent(self, now: datetime) -> bool:
        checked_at = self.state.last_market_context_checked_at
        if checked_at is None:
            return False
        if checked_at.tzinfo is None:
            checked_at = checked_at.replace(tzinfo=timezone.utc)
        return (
            now.astimezone(timezone.utc) - checked_at.astimezone(timezone.utc)
        ) < _SIMPLE_MARKET_CONTEXT_RETRY_INTERVAL

    def _market_context_probe_symbol(self) -> str | None:
        existing_symbol = (
            str(self.state.last_market_context_symbol or "").strip().upper()
        )
        if existing_symbol:
            return existing_symbol
        try:
            symbols = self.universe_resolver.get_resolution().symbols
        except Exception:
            logger.exception("Simple-lane market context probe symbol unavailable")
            return None
        for raw_symbol in symbols:
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                return symbol
        return None

    @staticmethod
    def _proof_floor_submission_block_reason(
        proof_floor: Mapping[str, object],
    ) -> str | None:
        route_state = str(proof_floor.get("route_state") or "").strip()
        capital_state = str(proof_floor.get("capital_state") or "").strip()
        max_notional = _optional_decimal(proof_floor.get("max_notional"))
        if (
            route_state == "repair_only"
            or capital_state == "zero_notional"
            or (max_notional is not None and max_notional <= 0)
        ):
            blocking_reasons = proof_floor.get("blocking_reasons")
            if isinstance(blocking_reasons, list):
                for item in cast(list[object], blocking_reasons):
                    reason = str(item).strip()
                    if reason:
                        return reason
            return "profitability_proof_floor_zero_notional"
        return None

    @staticmethod
    def _proof_floor_market_session_open(proof_floor: Mapping[str, object]) -> bool:
        market_window = proof_floor.get("market_window")
        if not isinstance(market_window, Mapping):
            return False
        return bool(cast(Mapping[str, object], market_window).get("session_open"))

    @staticmethod
    def _proof_floor_route_candidate_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        summary = route_book_mapping.get("summary")
        if not isinstance(summary, Mapping):
            return set()
        summary_mapping = cast(Mapping[str, Any], summary)
        raw_symbols = summary_mapping.get("candidate_symbols")
        if not isinstance(raw_symbols, list):
            return set()
        candidate_symbols: set[str] = set()
        for raw_symbol in cast(list[object], raw_symbols):
            symbol = str(raw_symbol).strip().upper()
            if symbol:
                candidate_symbols.add(symbol)
        return candidate_symbols

    @staticmethod
    def _proof_floor_route_repair_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        summary = cast(Mapping[str, Any], route_book).get("summary")
        if not isinstance(summary, Mapping):
            return set()
        repair_symbols: set[str] = set()
        for key in ("repair_candidate_symbols", "candidate_symbols"):
            raw_symbols = cast(Mapping[str, Any], summary).get(key)
            if not isinstance(raw_symbols, list):
                continue
            for raw_symbol in cast(list[object], raw_symbols):
                symbol = str(raw_symbol).strip().upper()
                if symbol:
                    repair_symbols.add(symbol)
        return repair_symbols

    @staticmethod
    def _proof_floor_paper_route_probe_symbols(
        proof_floor: Mapping[str, object],
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        probe = route_book_mapping.get("paper_route_probe")
        summary = route_book_mapping.get("summary")
        symbols: set[str] = set()
        for source, keys in (
            (probe, ("active_symbols", "eligible_symbols")),
            (
                summary,
                (
                    "paper_route_probe_active_symbols",
                    "paper_route_probe_eligible_symbols",
                ),
            ),
        ):
            if not isinstance(source, Mapping):
                continue
            source_mapping = cast(Mapping[str, Any], source)
            for key in keys:
                raw_symbols = source_mapping.get(key)
                if not isinstance(raw_symbols, list):
                    continue
                for raw_symbol in cast(list[object], raw_symbols):
                    symbol = str(raw_symbol).strip().upper()
                    if symbol:
                        symbols.add(symbol)
        return symbols

    @staticmethod
    def _proof_floor_symbol_route_probe_reasons(
        proof_floor: Mapping[str, object],
        symbol: str,
    ) -> set[str]:
        route_book = proof_floor.get("route_reacquisition_book")
        if not isinstance(route_book, Mapping):
            return set()
        raw_summary = cast(Mapping[str, Any], route_book).get("summary")
        summary: Mapping[str, Any]
        if isinstance(raw_summary, Mapping):
            summary = cast(Mapping[str, Any], raw_summary)
        else:
            summary = {}
        normalized_symbol = symbol.strip().upper()
        reasons: set[str] = set()
        route_book_mapping = cast(Mapping[str, Any], route_book)
        candidate_sources: list[object] = [
            summary.get("repair_candidates"),
            route_book_mapping.get("records"),
        ]
        for raw_candidates in candidate_sources:
            if not isinstance(raw_candidates, list):
                continue
            for raw_candidate in cast(list[object], raw_candidates):
                if not isinstance(raw_candidate, Mapping):
                    continue
                candidate = cast(Mapping[str, Any], raw_candidate)
                candidate_symbol = str(candidate.get("symbol") or "").strip().upper()
                if not candidate_symbol or candidate_symbol != normalized_symbol:
                    continue
                state = str(candidate.get("state") or "").strip()
                if state not in {"missing", "probing"}:
                    continue
                reason = str(candidate.get("reason") or "").strip()
                if reason in _PAPER_ROUTE_PROBE_REASONS:
                    reasons.add(reason)
        return reasons

    @staticmethod
    def _paper_route_probe_reference_price(
        decision: StrategyDecision,
    ) -> Decimal | None:
        for value in (
            decision.limit_price,
            decision.params.get("price"),
            cast(Mapping[str, Any], decision.params.get("simple_lane") or {}).get(
                "price"
            )
            if isinstance(decision.params.get("simple_lane"), Mapping)
            else None,
            cast(Mapping[str, Any], decision.params.get("price_snapshot") or {}).get(
                "price"
            )
            if isinstance(decision.params.get("price_snapshot"), Mapping)
            else None,
        ):
            price = _optional_decimal(value)
            if price is not None and price > 0:
                return price
        return None

    @staticmethod
    def _paper_route_probe_short_increasing_sell(decision: StrategyDecision) -> bool:
        if decision.action != "sell":
            return False
        for key in ("simple_lane", "sizing"):
            section = decision.params.get(key)
            if not isinstance(section, Mapping):
                continue
            quantity_resolution = cast(Mapping[str, Any], section).get(
                "quantity_resolution"
            )
            if not isinstance(quantity_resolution, Mapping):
                continue
            resolution = cast(Mapping[str, Any], quantity_resolution)
            short_increasing = resolution.get("short_increasing")
            if isinstance(short_increasing, bool):
                return short_increasing
            if isinstance(short_increasing, str):
                normalized = short_increasing.strip().lower()
                if normalized in {"true", "1", "yes", "on"}:
                    return True
                if normalized in {"false", "0", "no", "off"}:
                    return False
            reason = str(resolution.get("reason") or "").strip().lower()
            if reason.startswith("sell_reducing_"):
                return False
            if "short_increasing" in reason:
                return True
        return True

    @staticmethod
    def _external_paper_route_target_probe_symbols() -> tuple[set[str], str | None]:
        url = str(settings.trading_paper_route_target_plan_url or "").strip()
        if not url:
            return set(), None
        plan = fetch_paper_route_target_plan_url(
            url,
            timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
        )
        load_error = str(plan.get("load_error") or "").strip()
        if load_error:
            return set(), load_error
        symbols = paper_route_target_plan_probe_symbols(plan)
        if not symbols:
            return set(), "paper_route_target_plan_probe_symbols_missing"
        return symbols, None

    def _paper_route_probe_context(
        self,
        *,
        proof_floor: Mapping[str, object],
        decision: StrategyDecision,
    ) -> dict[str, object] | None:
        if settings.trading_mode != "paper":
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        if (
            decision.action == "sell"
            and not settings.trading_allow_shorts
            and self._paper_route_probe_short_increasing_sell(decision)
        ):
            return None
        if decision.action not in {"buy", "sell"}:
            return None
        cap = _optional_decimal(settings.trading_simple_paper_route_probe_max_notional)
        if cap is None or cap <= 0:
            return None
        if not self._proof_floor_market_session_open(proof_floor):
            return None

        blocking_reasons = {
            str(item).strip()
            for item in cast(list[object], proof_floor.get("blocking_reasons") or [])
            if str(item).strip()
        }
        symbol = decision.symbol.strip().upper()
        target_plan_symbols, target_plan_error = (
            self._external_paper_route_target_probe_symbols()
        )
        if target_plan_error:
            return None
        if target_plan_symbols and symbol not in target_plan_symbols:
            return None
        symbol_route_probe_reasons = self._proof_floor_symbol_route_probe_reasons(
            proof_floor,
            symbol,
        )
        paper_route_probe_symbols = self._proof_floor_paper_route_probe_symbols(
            proof_floor
        )
        symbol_paper_route_probe_eligible = symbol in paper_route_probe_symbols
        if not (
            (blocking_reasons & _PAPER_ROUTE_PROBE_REASONS)
            or symbol_route_probe_reasons
            or symbol_paper_route_probe_eligible
        ):
            return None

        repair_symbols = self._proof_floor_route_repair_symbols(proof_floor)
        if (
            repair_symbols
            and symbol not in repair_symbols
            and not symbol_paper_route_probe_eligible
        ):
            return None

        return {
            "enabled": True,
            "mode": "paper_route_acquisition",
            "max_notional": str(cap),
            "symbol": symbol,
            "side": decision.action,
            "blocking_reasons": sorted(blocking_reasons | symbol_route_probe_reasons),
            "route_repair_symbols": sorted(repair_symbols),
            "paper_route_probe_symbols": sorted(paper_route_probe_symbols),
            "paper_route_target_plan_symbols": sorted(target_plan_symbols),
            "paper_route_target_plan_source": "external_target_plan_url"
            if target_plan_symbols
            else None,
            "simple_submit_enabled": settings.trading_simple_submit_enabled,
            "simple_submit_bypass_scope": "paper_route_probe_only"
            if not settings.trading_simple_submit_enabled
            else None,
        }

    def _apply_paper_route_probe_cap(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        proof_floor: Mapping[str, object],
        context: Mapping[str, object],
    ) -> bool:
        cap = _optional_decimal(context.get("max_notional"))
        price = self._paper_route_probe_reference_price(decision)
        if cap is None or cap <= 0 or price is None or price <= 0:
            return False

        capped_qty = (cap / price).quantize(
            _PAPER_ROUTE_PROBE_QTY_STEP,
            rounding=ROUND_DOWN,
        )
        if capped_qty <= 0:
            return False
        if decision.qty > 0:
            capped_qty = min(decision.qty, capped_qty)

        capped_notional = capped_qty * price
        params = dict(decision.params)
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        simple_lane["final_qty"] = str(capped_qty)
        simple_lane["notional"] = str(capped_notional)
        simple_lane["paper_route_probe_cap_applied"] = True
        params["simple_lane"] = simple_lane
        params["paper_route_probe"] = {
            **dict(context),
            "reference_price": str(price),
            "capped_qty": str(capped_qty),
            "capped_notional": str(capped_notional),
            "capital_stage": str(proof_floor.get("capital_state") or "zero_notional"),
        }
        decision.qty = capped_qty
        decision.params = params
        self.executor.sync_decision_state(session, decision_row, decision)
        self.executor.update_decision_params(session, decision_row, params)
        logger.warning(
            "Allowing bounded paper route-acquisition probe strategy_id=%s symbol=%s qty=%s notional=%s reasons=%s",
            decision.strategy_id,
            decision.symbol,
            capped_qty,
            capped_notional,
            ",".join(cast(list[str], context.get("blocking_reasons") or [])),
        )
        return True

    @staticmethod
    def _proof_floor_symbol_block_reason(
        proof_floor: Mapping[str, object],
        symbol: str,
    ) -> str | None:
        candidate_symbols = SimpleTradingPipeline._proof_floor_route_candidate_symbols(
            proof_floor
        )
        if not candidate_symbols:
            return None
        normalized_symbol = symbol.strip().upper()
        if normalized_symbol and normalized_symbol not in candidate_symbols:
            return "profitability_route_symbol_excluded"
        return None

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> bool:
        if not settings.trading_enabled:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason="trading_disabled",
                submission_stage="blocked_trading_disabled",
            )
            return False
        firewall_status = self.order_firewall.status()
        if firewall_status.kill_switch_enabled:
            self._record_decision_rejection(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reasons=["kill_switch_enabled"],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return False
        if settings.trading_mode == "live":
            live_submission_gate = self._live_submission_gate(session=session)
            if not bool(live_submission_gate.get("allowed", False)):
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason=str(
                        live_submission_gate.get("reason")
                        or "live_submission_gate_blocked"
                    ),
                    submission_stage="blocked_live_submission_gate",
                    extra_metadata={"live_submission_gate": live_submission_gate},
                )
                return False
        proof_floor = self._profitability_proof_floor(session=session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        paper_route_probe_applied = False
        if proof_floor_block_reason is not None:
            probe_context = self._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
            )
            if probe_context is None or not self._apply_paper_route_probe_cap(
                session=session,
                decision=decision,
                decision_row=decision_row,
                proof_floor=proof_floor,
                context=probe_context,
            ):
                self._block_decision_submission(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    reason=proof_floor_block_reason,
                    submission_stage="blocked_profitability_proof_floor",
                    capital_stage=str(
                        proof_floor.get("capital_state") or "zero_notional"
                    ),
                    extra_metadata={"profitability_proof_floor": dict(proof_floor)},
                )
                return False
            paper_route_probe_applied = True
        proof_floor_symbol_block_reason = (
            self._proof_floor_symbol_block_reason(
                proof_floor,
                decision.symbol,
            )
            if not paper_route_probe_applied
            else None
        )
        if proof_floor_symbol_block_reason is not None:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=proof_floor_symbol_block_reason,
                submission_stage="blocked_profitability_route_symbol",
                capital_stage=str(proof_floor.get("capital_state") or "zero_notional"),
                extra_metadata={"profitability_proof_floor": dict(proof_floor)},
            )
            return False
        if settings.trading_emergency_stop_enabled and self.state.emergency_stop_active:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=self.state.emergency_stop_reason or "emergency_stop_active",
                submission_stage="blocked_emergency_stop",
            )
            return False
        return True

    def _execution_client_for_symbol(
        self, symbol: str, *, symbol_allowlist: set[str] | None = None
    ) -> Any:
        _ = (symbol, symbol_allowlist)
        return self.execution_adapter

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
        except OrderFirewallBlocked:
            return self._reject_submit(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                reason="kill_switch_enabled",
                rejection_type="firewall_blocked",
            )
        except Exception as exc:
            payload = _extract_json_error_payload(exc) or {}
            reason = self._map_submit_exception(payload)
            metadata = {"broker_precheck": payload} if payload else None
            return self._reject_submit(
                session=session,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name=selected_adapter_name,
                reason=reason,
                rejection_type="submit_failed",
                metadata=metadata,
            )

    def _reject_submit(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        selected_adapter_name: str,
        reason: str,
        rejection_type: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons([reason])
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=selected_adapter_name,
        )
        self.executor.mark_rejected(
            session,
            decision_row,
            reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit",
                extra=metadata,
            ),
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.rejected",
            severity="warning",
            decision=decision,
            decision_row=decision_row,
            reason_codes=[reason],
            extra_properties={"rejection_type": rejection_type},
        )
        return None, True

    @staticmethod
    def _map_submit_exception(payload: Mapping[str, Any]) -> str:
        source = str(payload.get("source") or "").strip().lower()
        code = str(payload.get("code") or "").strip().lower()
        if source == "local_pre_submit":
            if code in {"local_qty_invalid_increment"}:
                return "invalid_qty_increment"
            if code in {"local_qty_below_min", "local_qty_non_positive"}:
                return "qty_below_min_after_clamp"
            if code in {
                "local_account_shorting_disabled",
                "local_symbol_not_shortable",
                "local_symbol_not_tradable",
                "local_shorts_not_allowed",
                "shorting_metadata_unavailable",
            }:
                return "shorting_not_allowed_for_asset"
            return "broker_precheck_failed"
        return "broker_submit_failed"

    def _simple_shortability_reason(
        self,
        *,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
    ) -> str | None:
        if decision.action != "sell":
            return None
        current_qty = position_qty_for_symbol(positions, decision.symbol)
        if current_qty > 0 and decision.qty <= current_qty:
            return None
        if not settings.trading_allow_shorts:
            return "shorting_not_allowed_for_asset"

        account = self.order_firewall.get_account()
        if account is not None:
            shorting_enabled = account.get("shorting_enabled")
            if isinstance(shorting_enabled, bool) and not shorting_enabled:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"

        asset = self.order_firewall.get_asset(decision.symbol)
        if asset is not None:
            tradable = asset.get("tradable")
            shortable = asset.get("shortable")
            if isinstance(tradable, bool) and not tradable:
                return "shorting_not_allowed_for_asset"
            if isinstance(shortable, bool) and not shortable:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"
        return None

    @staticmethod
    def _apply_simple_projected_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
    ) -> None:
        normalized_symbol = decision.symbol.strip().upper()
        updated = False
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            raw_qty = position.get("qty") or position.get("quantity") or "0"
            try:
                qty = Decimal(str(raw_qty))
            except (ArithmeticError, ValueError):
                qty = Decimal("0")
            side = str(position.get("side") or "").strip().lower()
            signed_qty = -abs(qty) if side == "short" else qty
            delta = decision.qty if decision.action == "buy" else -decision.qty
            next_qty = signed_qty + delta
            position["qty"] = str(abs(next_qty))
            position["side"] = "short" if next_qty < 0 else "long"
            updated = True
            break
        if not updated:
            positions.append(
                {
                    "symbol": normalized_symbol,
                    "qty": str(decision.qty),
                    "side": "long" if decision.action == "buy" else "short",
                }
            )

    @staticmethod
    def _apply_simple_projected_buying_power(
        account: dict[str, str],
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
    ) -> None:
        buying_power = _optional_decimal(account.get("buying_power"))
        if buying_power is None:
            return
        notional = _simple_decision_notional(decision)
        if notional is None or notional <= 0:
            return
        consumed = _simple_buying_power_consumption(
            positions=positions,
            decision=decision,
            notional=notional,
        )
        if consumed <= 0:
            return
        account["buying_power"] = str(max(buying_power - consumed, Decimal("0")))


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _min_optional_decimal(*values: Decimal | None) -> Decimal | None:
    candidates = [value for value in values if value is not None and value >= 0]
    if not candidates:
        return None
    return min(candidates)


def _simple_drift_feature_thresholds() -> FeatureQualityThresholds:
    return FeatureQualityThresholds(
        max_required_null_rate=settings.trading_drift_max_required_null_rate,
        max_staleness_ms=settings.trading_drift_max_staleness_ms_p95,
        max_duplicate_ratio=settings.trading_drift_max_duplicate_ratio,
    )


def _simple_drift_thresholds() -> DriftThresholds:
    return DriftThresholds(
        max_required_null_rate=Decimal(
            str(settings.trading_drift_max_required_null_rate)
        ),
        max_staleness_ms_p95=max(0, int(settings.trading_drift_max_staleness_ms_p95)),
        max_duplicate_ratio=Decimal(str(settings.trading_drift_max_duplicate_ratio)),
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


def _pct_cap_to_notional(
    *, equity: Decimal | None, pct: Decimal | None
) -> Decimal | None:
    if equity is None or equity <= 0 or pct is None or pct <= 0:
        return None
    return equity * pct


def _simple_decision_notional(decision: StrategyDecision) -> Decimal | None:
    simple_lane = decision.params.get("simple_lane")
    if isinstance(simple_lane, Mapping):
        simple_lane_payload = cast(Mapping[str, Any], simple_lane)
        notional = _optional_decimal(simple_lane_payload.get("notional"))
        if notional is not None:
            return notional
    price = _optional_decimal(decision.params.get("price"))
    if price is None:
        return None
    return price * decision.qty


def _simple_buying_power_consumption(
    *,
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
    notional: Decimal,
) -> Decimal:
    action = decision.action.strip().lower()
    if action == "buy":
        return notional
    if action != "sell" or decision.qty <= 0:
        return Decimal("0")
    current_qty = position_qty_for_symbol(positions, decision.symbol)
    if current_qty >= decision.qty:
        return Decimal("0")
    short_increasing_qty = (
        decision.qty if current_qty <= 0 else decision.qty - current_qty
    )
    return notional * (short_increasing_qty / decision.qty)
