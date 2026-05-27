"""Simplified trading pipeline with a minimal direct-submit hot path."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import Any, Optional, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import Execution, Strategy, TradeDecision
from ...strategies.catalog import extract_catalog_metadata
from ..autonomy import DriftThresholds, detect_drift
from ..empirical_jobs import build_empirical_jobs_status
from ..feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ..firewall import OrderFirewallBlocked
from ..ingest import SignalBatch
from ..models import SignalEnvelope, StrategyDecision
from ..paper_route_target_plan import (
    fetch_paper_route_target_plan_url,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
)
from ..prices import MarketSnapshot
from ..proof_floor import build_profitability_proof_floor_receipt
from ..session_context import REGULAR_OPEN_UTC
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
from ..time_source import trading_now
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
_REGULAR_SESSION_MINUTES = 390


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float | str | Decimal):
        try:
            return int(value)
        except ValueError:
            return 0
    try:
        return int(cast(Any, value))
    except (TypeError, ValueError):
        return 0


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _target_symbols(target: Mapping[str, Any]) -> set[str]:
    raw_symbols = target.get("paper_route_probe_symbols")
    if isinstance(raw_symbols, str):
        values = raw_symbols.split(",")
    elif isinstance(raw_symbols, Sequence) and not isinstance(
        raw_symbols, (str, bytes, bytearray)
    ):
        values = cast(Sequence[object], raw_symbols)
    else:
        values = ()
    return {symbol for raw in values if (symbol := str(raw).strip().upper())}


def _target_plan_lineage(
    targets: list[dict[str, Any]], symbol: str
) -> dict[str, object]:
    normalized_symbol = symbol.strip().upper()
    lineage_targets: list[dict[str, str]] = []
    candidate_ids: list[str] = []
    hypothesis_ids: list[str] = []
    strategy_names: list[str] = []
    for target in targets:
        target_symbols = _target_symbols(target)
        if target_symbols and normalized_symbol not in target_symbols:
            continue
        candidate_id = _safe_text(target.get("candidate_id"))
        hypothesis_id = _safe_text(target.get("hypothesis_id"))
        strategy_name = _safe_text(target.get("strategy_name"))
        item = {
            key: value
            for key, value in {
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "strategy_name": strategy_name,
            }.items()
            if value
        }
        if item:
            lineage_targets.append(item)
        if candidate_id and candidate_id not in candidate_ids:
            candidate_ids.append(candidate_id)
        if hypothesis_id and hypothesis_id not in hypothesis_ids:
            hypothesis_ids.append(hypothesis_id)
        if strategy_name and strategy_name not in strategy_names:
            strategy_names.append(strategy_name)
    return {
        "paper_route_probe_lineage_targets": lineage_targets,
        "source_candidate_ids": candidate_ids,
        "source_hypothesis_ids": hypothesis_ids,
        "source_strategy_names": strategy_names,
    }


class SimpleTradingPipeline(TradingPipeline):
    """Minimal signal -> hard-risk -> direct execution lane."""

    def run_once(self) -> None:
        self._label_mature_rejected_signal_outcome_events()
        with self.session_factory() as session:
            self.state.metrics.planned_decision_age_seconds = 0
            strategies = self._prepare_run_once(session)
            if not strategies:
                return
            self._warm_session_context_from_open(session, strategies=strategies)

            batch = self.ingestor.fetch_signals(session)
            self._record_ingest_window(batch)
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
                self._process_paper_route_probe_retry_decisions(
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
            self._process_paper_route_probe_retry_decisions(
                session=session,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )
            self.ingestor.commit_cursor(session, batch)

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

    @staticmethod
    def _trade_decision_from_retry_row(
        decision_row: TradeDecision,
    ) -> StrategyDecision | None:
        decision_json = decision_row.decision_json
        if not isinstance(decision_json, Mapping):
            return None
        try:
            return StrategyDecision.model_validate(decision_json)
        except Exception:
            logger.warning(
                "Skipping paper route probe retry with invalid decision payload decision_id=%s",
                decision_row.id,
                exc_info=True,
            )
            return None

    @staticmethod
    def _paper_route_probe_exit_metadata(
        decision: StrategyDecision,
    ) -> Mapping[str, Any] | None:
        metadata = decision.params.get("paper_route_probe_exit")
        if not isinstance(metadata, Mapping):
            return None
        metadata_mapping = cast(Mapping[str, Any], metadata)
        mode = str(metadata_mapping.get("mode") or "").strip()
        if mode != "paper_route_exit":
            return None
        return metadata_mapping

    def _paper_route_probe_retry_session_open(self) -> datetime:
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        return datetime.combine(now.date(), REGULAR_OPEN_UTC, tzinfo=timezone.utc)

    @staticmethod
    def _paper_route_probe_strategy(
        *,
        session: Session,
        decision: StrategyDecision,
    ) -> Strategy | None:
        try:
            strategy_id = UUID(decision.strategy_id)
        except (TypeError, ValueError):
            return None
        return session.get(Strategy, strategy_id)

    @staticmethod
    def _paper_route_probe_exit_minute_value(raw_value: object) -> int | None:
        if raw_value is None:
            return None
        if isinstance(raw_value, str):
            text = raw_value.strip().lower()
            if not text:
                return None
            if text == "close":
                return _REGULAR_SESSION_MINUTES
            try:
                return max(0, int(Decimal(text)))
            except Exception:
                return None
        try:
            return max(0, int(cast(Any, raw_value)))
        except (TypeError, ValueError, ArithmeticError):
            return None

    @staticmethod
    def _paper_route_probe_exit_minute_after_open(
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> int | None:
        direct_exit_minute = SimpleTradingPipeline._paper_route_probe_exit_minute_value(
            decision.params.get("exit_minute_after_open")
        )
        if direct_exit_minute is not None:
            return direct_exit_minute
        probe_metadata = decision.params.get("paper_route_probe")
        if isinstance(probe_metadata, Mapping):
            probe_mapping = cast(Mapping[str, object], probe_metadata)
            for key in (
                "exit_minute_after_open",
                "effective_exit_minute_after_open",
            ):
                metadata_exit_minute = (
                    SimpleTradingPipeline._paper_route_probe_exit_minute_value(
                        probe_mapping.get(key)
                    )
                )
                if metadata_exit_minute is not None:
                    return metadata_exit_minute
        if strategy is None:
            return None
        metadata = extract_catalog_metadata(strategy.description)
        metadata_params = metadata.get("params")
        if not isinstance(metadata_params, Mapping):
            return None
        params = cast(Mapping[str, object], metadata_params)
        return SimpleTradingPipeline._paper_route_probe_exit_minute_value(
            params.get("exit_minute_after_open")
        )

    @staticmethod
    def _paper_route_probe_session_open(value: datetime) -> datetime:
        ts = (
            value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        ).astimezone(timezone.utc)
        return datetime.combine(ts.date(), REGULAR_OPEN_UTC, tzinfo=timezone.utc)

    @staticmethod
    def _paper_route_probe_exit_session_open(
        *,
        decision: StrategyDecision,
        fallback: datetime,
    ) -> datetime:
        metadata = SimpleTradingPipeline._paper_route_probe_exit_metadata(decision)
        if metadata is not None:
            raw_session_open = metadata.get("session_open")
            if isinstance(raw_session_open, datetime):
                return SimpleTradingPipeline._paper_route_probe_session_open(
                    raw_session_open
                )
            raw_text = str(raw_session_open or "").strip()
            if raw_text:
                try:
                    parsed = datetime.fromisoformat(raw_text.replace("Z", "+00:00"))
                    return SimpleTradingPipeline._paper_route_probe_session_open(parsed)
                except ValueError:
                    pass
        return SimpleTradingPipeline._paper_route_probe_session_open(fallback)

    def _paper_route_probe_entry_after_exit_minute(
        self,
        *,
        decision: StrategyDecision,
        strategy: Strategy | None = None,
    ) -> bool:
        if decision.action != "buy":
            return False
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        if exit_minute is None:
            return False
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        session_open = datetime.combine(
            now.date(),
            REGULAR_OPEN_UTC,
            tzinfo=timezone.utc,
        )
        minutes_elapsed = int((now - session_open).total_seconds() // 60)
        return minutes_elapsed >= exit_minute

    def _created_in_current_regular_session(
        self,
        decision_row: TradeDecision,
        decision: StrategyDecision,
        *,
        session_open: datetime,
    ) -> bool:
        for raw_ts in (decision.event_ts, decision_row.created_at):
            ts = (
                raw_ts
                if raw_ts.tzinfo is not None
                else raw_ts.replace(tzinfo=timezone.utc)
            )
            if ts.astimezone(timezone.utc) >= session_open:
                return True
        return False

    def _paper_route_probe_retry_decisions(
        self,
        *,
        session: Session,
    ) -> list[StrategyDecision]:
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        batch_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_batch_limit),
            0,
        )
        scan_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_scan_limit),
            0,
        )
        if batch_limit <= 0 or scan_limit <= 0:
            return []

        session_open = self._paper_route_probe_retry_session_open()
        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.status == "blocked",
                    TradeDecision.alpaca_account_label == self.account_label,
                )
                .order_by(TradeDecision.created_at.desc())
                .limit(scan_limit)
            )
            .scalars()
            .all()
        )
        decisions: list[StrategyDecision] = []
        for decision_row in rows:
            if len(decisions) >= batch_limit:
                break
            if self._paper_route_probe_retry_metadata(decision_row) is None:
                continue
            if self.executor.execution_exists(session, decision_row):
                continue
            decision = self._trade_decision_from_retry_row(decision_row)
            if decision is None:
                continue
            if not self._created_in_current_regular_session(
                decision_row,
                decision,
                session_open=session_open,
            ):
                continue
            strategy = self._paper_route_probe_strategy(
                session=session,
                decision=decision,
            )
            if self._paper_route_probe_entry_after_exit_minute(
                decision=decision,
                strategy=strategy,
            ):
                logger.warning(
                    "Skipping stale paper route probe entry retry after strategy exit minute strategy_id=%s symbol=%s",
                    decision.strategy_id,
                    decision.symbol,
                )
                continue
            decisions.append(decision)
        return decisions

    def _paper_route_probe_exit_decisions(
        self,
        *,
        session: Session,
    ) -> list[StrategyDecision]:
        if settings.trading_mode != "paper":
            return []
        if not settings.trading_simple_paper_route_probe_enabled:
            return []
        now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
        if not self._is_market_session_open(now):
            return []

        session_open = datetime.combine(
            now.date(),
            REGULAR_OPEN_UTC,
            tzinfo=timezone.utc,
        )
        exit_lookback_hours = max(
            0,
            _safe_int(settings.trading_simple_paper_route_probe_exit_lookback_hours),
        )
        lookback_start = (
            now - timedelta(hours=exit_lookback_hours)
            if exit_lookback_hours > 0
            else session_open
        )
        rows = session.execute(
            select(Execution, TradeDecision)
            .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
            .where(
                Execution.alpaca_account_label == self.account_label,
                TradeDecision.alpaca_account_label == self.account_label,
                Execution.status == "filled",
                Execution.filled_qty > Decimal("0"),
                Execution.created_at >= lookback_start,
            )
            .order_by(Execution.created_at.asc())
        ).all()
        exposures: dict[tuple[str, str, str], dict[str, Any]] = {}
        for execution, decision_row in rows:
            decision = self._trade_decision_from_retry_row(decision_row)
            if decision is None:
                continue
            decision_json = decision_row.decision_json
            if not isinstance(decision_json, Mapping):
                continue
            params = decision.params
            is_entry = isinstance(params.get("paper_route_probe"), Mapping)
            is_exit = isinstance(params.get("paper_route_probe_exit"), Mapping)
            if not is_entry and not is_exit:
                continue
            side = str(execution.side or "").strip().lower()
            if side not in {"buy", "sell"}:
                continue
            filled_qty = _optional_decimal(execution.filled_qty)
            if filled_qty is None or filled_qty <= 0:
                continue
            strategy = session.get(Strategy, decision_row.strategy_id)
            if strategy is None:
                continue
            symbol = str(execution.symbol or decision_row.symbol or "").strip().upper()
            if not symbol:
                continue

            entry_session_open = (
                self._paper_route_probe_session_open(decision.event_ts)
                if is_entry
                else self._paper_route_probe_exit_session_open(
                    decision=decision,
                    fallback=decision.event_ts,
                )
            )
            key = (str(strategy.id), symbol, entry_session_open.isoformat())
            exposure = exposures.setdefault(
                key,
                {
                    "strategy": strategy,
                    "symbol": symbol,
                    "timeframe": decision.timeframe,
                    "session_open": entry_session_open,
                    "net_qty": Decimal("0"),
                    "buy_qty": Decimal("0"),
                    "buy_notional": Decimal("0"),
                    "latest_entry_at": None,
                    "exit_minute_after_open": None,
                },
            )
            signed_qty = filled_qty if side == "buy" else -filled_qty
            exposure["net_qty"] = cast(Decimal, exposure["net_qty"]) + signed_qty
            if side == "buy":
                exit_minute = self._paper_route_probe_exit_minute_after_open(
                    decision=decision,
                    strategy=strategy,
                )
                if exit_minute is not None:
                    exposure["exit_minute_after_open"] = exit_minute
                avg_fill_price = _optional_decimal(execution.avg_fill_price)
                if avg_fill_price is not None and avg_fill_price > 0:
                    exposure["buy_qty"] = (
                        cast(Decimal, exposure["buy_qty"]) + filled_qty
                    )
                    exposure["buy_notional"] = cast(
                        Decimal,
                        exposure["buy_notional"],
                    ) + (filled_qty * avg_fill_price)
                latest_entry_at = exposure.get("latest_entry_at")
                execution_created_at = (
                    execution.created_at
                    if execution.created_at.tzinfo is not None
                    else execution.created_at.replace(tzinfo=timezone.utc)
                ).astimezone(timezone.utc)
                if not isinstance(latest_entry_at, datetime) or (
                    execution_created_at > latest_entry_at
                ):
                    exposure["latest_entry_at"] = execution_created_at

        decisions: list[StrategyDecision] = []
        for exposure in exposures.values():
            net_qty = cast(Decimal, exposure["net_qty"])
            if net_qty <= 0:
                continue
            raw_exit_minute = exposure.get("exit_minute_after_open")
            exit_minute = raw_exit_minute if isinstance(raw_exit_minute, int) else None
            if exit_minute is None:
                continue
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            entry_session_open = cast(datetime, exposure["session_open"])
            exit_due_at = entry_session_open + timedelta(minutes=effective_exit_minute)
            if now < exit_due_at:
                continue
            strategy = cast(Strategy, exposure["strategy"])
            symbol = str(exposure["symbol"])
            if self._paper_route_probe_exit_already_recorded(
                session=session,
                strategy=strategy,
                symbol=symbol,
                session_open=entry_session_open,
                exit_due_at=exit_due_at,
            ):
                continue
            buy_qty = cast(Decimal, exposure["buy_qty"])
            buy_notional = cast(Decimal, exposure["buy_notional"])
            avg_entry_price = buy_notional / buy_qty if buy_qty > 0 else None
            params: dict[str, Any] = {
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "source": "filled_paper_route_probe_executions",
                    "symbol": symbol,
                    "strategy_id": str(strategy.id),
                    "db_open_qty": str(net_qty),
                    "exit_minute_after_open": exit_minute,
                    "effective_exit_minute_after_open": effective_exit_minute,
                    "exit_due_at": exit_due_at.isoformat(),
                    "session_open": entry_session_open.isoformat(),
                    "stale_exit_repair": entry_session_open.date() < now.date(),
                    "latest_entry_at": exposure["latest_entry_at"].isoformat()
                    if isinstance(exposure.get("latest_entry_at"), datetime)
                    else None,
                    "avg_entry_price": str(avg_entry_price)
                    if avg_entry_price is not None
                    else None,
                },
                "simple_lane": {
                    "final_qty": str(net_qty),
                    "notional": str(net_qty * avg_entry_price)
                    if avg_entry_price is not None
                    else None,
                    "quantity_resolution": {
                        "reason": "sell_reducing_paper_route_probe_exit",
                        "short_increasing": False,
                        "position_qty": str(net_qty),
                    },
                },
            }
            if avg_entry_price is not None:
                params["price"] = avg_entry_price
            decisions.append(
                StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol=symbol,
                    event_ts=exit_due_at,
                    timeframe=str(exposure["timeframe"] or strategy.base_timeframe),
                    action="sell",
                    qty=net_qty,
                    rationale="paper-route-probe-exit",
                    params=params,
                )
            )
        return decisions

    def _paper_route_probe_exit_already_recorded(
        self,
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        session_open: datetime,
        exit_due_at: datetime,
    ) -> bool:
        rows = (
            session.execute(
                select(TradeDecision)
                .where(
                    TradeDecision.strategy_id == strategy.id,
                    TradeDecision.alpaca_account_label == self.account_label,
                    TradeDecision.symbol == symbol,
                    TradeDecision.created_at >= session_open,
                )
                .order_by(TradeDecision.created_at.desc())
            )
            .scalars()
            .all()
        )
        exit_due_at_text = exit_due_at.isoformat()
        for row in rows:
            decision = self._trade_decision_from_retry_row(row)
            if decision is None or decision.action != "sell":
                continue
            metadata = self._paper_route_probe_exit_metadata(decision)
            if metadata is None:
                continue
            if str(metadata.get("exit_due_at") or "") != exit_due_at_text:
                continue
            if row.status in {"planned", "submitted", "filled", "rejected"}:
                return True
        return False

    @staticmethod
    def _restore_simulation_paper_route_probe_exit_position(
        *,
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        metadata: Mapping[str, Any],
        price: Decimal | None,
        execution_adapter: Any | None,
        trading_mode: str | None,
    ) -> Decimal | None:
        if str(trading_mode or "").strip().lower() != "paper":
            return None
        if (
            str(getattr(execution_adapter, "name", "") or "").strip().lower()
            != "simulation"
        ):
            return None
        db_open_qty = _optional_decimal(metadata.get("db_open_qty"))
        if db_open_qty is None or db_open_qty <= 0:
            return None
        seed_missing = getattr(
            execution_adapter, "seed_missing_position_snapshot", None
        )
        if not callable(seed_missing):
            return None

        restored_qty = (
            min(db_open_qty, decision.qty) if decision.qty > 0 else db_open_qty
        )
        position: dict[str, Any] = {
            "symbol": decision.symbol,
            "qty": str(restored_qty),
            "side": "long",
        }
        if price is not None and price > 0:
            position["market_value"] = str(restored_qty * price)
        try:
            seeded = bool(seed_missing(position))
        except Exception as exc:
            logger.warning(
                "Failed to restore simulation paper route probe exit position symbol=%s error=%s",
                decision.symbol,
                exc,
            )
            return None
        if not seeded:
            return None
        positions.append(dict(position))
        return restored_qty

    @staticmethod
    def _prepare_paper_route_probe_exit_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        *,
        execution_adapter: Any | None = None,
        trading_mode: str | None = None,
    ) -> StrategyDecision | None:
        if SimpleTradingPipeline._paper_route_probe_exit_metadata(decision) is None:
            return decision
        current_qty = position_qty_for_symbol(positions, decision.symbol)
        params = dict(decision.params)
        metadata = dict(cast(Mapping[str, Any], params["paper_route_probe_exit"]))
        simple_lane = dict(cast(Mapping[str, Any], params.get("simple_lane") or {}))
        quantity_resolution = dict(
            cast(Mapping[str, Any], simple_lane.get("quantity_resolution") or {})
        )
        if current_qty <= 0:
            price = _optional_decimal(params.get("price"))
            restored_qty = (
                SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                    positions=positions,
                    decision=decision,
                    metadata=metadata,
                    price=price,
                    execution_adapter=execution_adapter,
                    trading_mode=trading_mode,
                )
                if current_qty == 0
                else None
            )
            if restored_qty is None:
                return None
            metadata["broker_position_qty"] = str(current_qty)
            metadata["db_position_qty_fallback"] = True
            metadata["position_source"] = "source_execution_db_open_qty"
            current_qty = restored_qty
        if current_qty < decision.qty:
            decision = decision.model_copy(update={"qty": current_qty})
            metadata["qty_capped_to_position"] = True
        metadata.setdefault("broker_position_qty", str(current_qty))
        metadata["effective_position_qty"] = str(current_qty)

        quantity_resolution["position_qty"] = str(decision.qty)
        simple_lane["final_qty"] = str(decision.qty)
        simple_lane["quantity_resolution"] = quantity_resolution
        price = _optional_decimal(params.get("price"))
        if price is not None and price > 0:
            simple_lane["notional"] = str(decision.qty * price)
        params["paper_route_probe_exit"] = metadata
        params["simple_lane"] = simple_lane
        return decision.model_copy(update={"params": params})

    def _process_paper_route_probe_retry_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_probe_retry_decisions(session=session)
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
                    "Paper route probe retry handling failed strategy_id=%s symbol=%s timeframe=%s",
                    decision.strategy_id,
                    decision.symbol,
                    decision.timeframe,
                )
                self.state.metrics.orders_rejected_total += 1
                self.state.metrics.record_decision_rejection_reasons(
                    ["broker_submit_failed"]
                )

    def _process_paper_route_probe_exit_decisions(
        self,
        *,
        session: Session,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decisions = self._paper_route_probe_exit_decisions(session=session)
        for decision in decisions:
            prepared_decision = self._prepare_paper_route_probe_exit_position(
                positions,
                decision,
                execution_adapter=self.execution_adapter,
                trading_mode=settings.trading_mode,
            )
            if prepared_decision is None:
                continue
            self.state.metrics.decisions_total += 1
            try:
                submitted = self._handle_decision(
                    session,
                    prepared_decision,
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
                    "Paper route probe exit handling failed strategy_id=%s symbol=%s timeframe=%s",
                    prepared_decision.strategy_id,
                    prepared_decision.symbol,
                    prepared_decision.timeframe,
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
                    "order_feed_lifecycle_required": (
                        settings.trading_pipeline_mode == "simple"
                        and settings.trading_mode in {"paper", "live"}
                    ),
                    "order_feed_lifecycle_status": (
                        "enabled"
                        if settings.trading_simple_order_feed_telemetry_enabled
                        else "disabled"
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
    def _external_paper_route_target_probe_symbols() -> tuple[
        set[str],
        str | None,
        list[dict[str, Any]],
    ]:
        url = str(settings.trading_paper_route_target_plan_url or "").strip()
        if not url:
            return set(), None, []
        plan = fetch_paper_route_target_plan_url(
            url,
            timeout_seconds=settings.trading_paper_route_target_plan_timeout_seconds,
            attempts=2,
            retry_backoff_seconds=0.25,
        )
        load_error = str(plan.get("load_error") or "").strip()
        if load_error:
            logger.warning(
                "Paper-route target plan unavailable for bounded probe url=%s error=%s attempts=%s",
                url,
                load_error,
                plan.get("fetch_attempts") or 1,
            )
            return set(), load_error, []
        symbols = paper_route_target_plan_probe_symbols(plan)
        if not symbols:
            return set(), "paper_route_target_plan_probe_symbols_missing", []
        return symbols, None, paper_route_target_plan_targets(plan)

    def _paper_route_probe_context(
        self,
        *,
        proof_floor: Mapping[str, object],
        decision: StrategyDecision,
        strategy: Strategy | None = None,
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
        if self._paper_route_probe_entry_after_exit_minute(
            decision=decision,
            strategy=strategy,
        ):
            return None
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        effective_exit_minute: int | None = None
        exit_due_at: str | None = None
        if exit_minute is not None:
            effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
            now = trading_now(account_label=self.account_label).astimezone(timezone.utc)
            session_open = datetime.combine(
                now.date(),
                REGULAR_OPEN_UTC,
                tzinfo=timezone.utc,
            )
            exit_due_at = (
                session_open + timedelta(minutes=effective_exit_minute)
            ).isoformat()

        blocking_reasons = {
            str(item).strip()
            for item in cast(list[object], proof_floor.get("blocking_reasons") or [])
            if str(item).strip()
        }
        symbol = decision.symbol.strip().upper()
        target_plan_symbols, target_plan_error, target_plan_targets = (
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
            **_target_plan_lineage(target_plan_targets, symbol),
            "exit_minute_after_open": exit_minute,
            "effective_exit_minute_after_open": effective_exit_minute,
            "exit_due_at": exit_due_at,
            "simple_submit_enabled": settings.trading_simple_submit_enabled,
            "simple_submit_bypass_scope": "paper_route_probe_only"
            if not settings.trading_simple_submit_enabled
            else None,
        }

    @staticmethod
    def _paper_route_probe_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        if decision_row.status != "blocked":
            return None
        decision_json_raw = decision_row.decision_json
        if not isinstance(decision_json_raw, Mapping):
            return None
        decision_json = cast(Mapping[str, object], decision_json_raw)
        if decision_json.get("submission_stage") != "blocked_profitability_proof_floor":
            return None
        reason = str(decision_json.get("submission_block_reason") or "").strip()
        if not reason:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        retry_limit = max(
            _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        if retry_limit <= 0 or retry_attempts >= retry_limit:
            return None
        proof_floor = decision_json.get("profitability_proof_floor")
        if not isinstance(proof_floor, Mapping):
            return None
        return {
            "previous_submission_stage": "blocked_profitability_proof_floor",
            "previous_submission_block_reason": reason,
            "previous_decision_status": "blocked",
            "previous_paper_route_probe_retry_attempts": retry_attempts,
        }

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
        retry_metadata = self._paper_route_probe_retry_metadata(decision_row)
        if retry_metadata is None:
            return super()._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
        if self.executor.execution_exists(session, decision_row):
            return None

        proof_floor = self._profitability_proof_floor(session=session)
        if self._proof_floor_submission_block_reason(proof_floor) is None:
            return None
        probe_context = self._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=decision,
            strategy=strategy,
        )
        if probe_context is None:
            return None
        if self._paper_route_probe_reference_price(decision) is None:
            return None

        decision_row.status = "planned"
        decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        decision_json["paper_route_probe_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_probe_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_probe_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
            "context": dict(probe_context),
        }
        decision_json["submission_stage"] = "paper_route_probe_retry_pending"
        decision_json.pop("submission_block_reason", None)
        decision_json.pop("submission_block_atomic", None)
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening proof-floor-blocked decision for bounded paper route probe strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_submission_block_reason"],
        )
        return decision_row

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
            if (
                settings.trading_mode == "paper"
                and self._paper_route_probe_exit_metadata(decision) is not None
            ):
                paper_route_probe_applied = True
            else:
                strategy = self._paper_route_probe_strategy(
                    session=session,
                    decision=decision,
                )
                probe_context = self._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision,
                    strategy=strategy,
                )
                if probe_context is not None and self._apply_paper_route_probe_cap(
                    session=session,
                    decision=decision,
                    decision_row=decision_row,
                    proof_floor=proof_floor,
                    context=probe_context,
                ):
                    paper_route_probe_applied = True
            if not paper_route_probe_applied:
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
