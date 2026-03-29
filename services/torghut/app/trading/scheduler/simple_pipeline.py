"""Simplified trading pipeline with a minimal direct-submit hot path."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from ...config import settings
from ...models import Strategy, TradeDecision
from ..firewall import OrderFirewallBlocked
from ..ingest import SignalBatch
from ..models import StrategyDecision
from ..prices import MarketSnapshot
from ..simple_risk import (
    position_qty_for_symbol,
    prepare_simple_decision,
)
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


@dataclass(frozen=True)
class SimplePolicyOutcome:
    retry_delays: list[int]
    advisor_metadata: dict[str, object]


class SimpleTradingPipeline(TradingPipeline):
    """Minimal signal -> hard-risk -> direct execution lane."""

    def _prepare_run_once(self, session: Session) -> list[Strategy]:
        if settings.trading_simple_order_feed_telemetry_enabled:
            self._ingest_order_feed(session)
        self.order_firewall.cancel_open_orders_if_kill_switch()
        if self.strategy_catalog is not None:
            self.strategy_catalog.refresh(session)
        strategies = self._load_strategies(session)
        if not strategies:
            logger.info("No enabled strategies found; skipping simple trading cycle")
        return strategies

    def _prepare_batch_for_decisions(
        self,
        session: Session,
        batch: SignalBatch,
        *,
        quality_signals: list[Any],
    ) -> bool:
        if not batch.signals:
            self.record_no_signal_batch(batch)
            self.ingestor.commit_cursor(session, batch)
            return False
        market_session_open = self._is_market_session_open()
        self.state.market_session_open = market_session_open
        self.state.metrics.market_session_open = 1 if market_session_open else 0
        self.state.metrics.no_signal_reason_streak = {}
        self.state.metrics.no_signal_streak = 0
        self.state.metrics.signal_lag_seconds = None
        self.state.metrics.signal_continuity_actionable = 0
        self.state.last_signal_continuity_state = "signals_present"
        self.state.last_signal_continuity_reason = None
        self.state.last_signal_continuity_actionable = False
        return True

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
        for signal in batch.signals:
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
        snapshot = super()._submission_control_plane_snapshot(capital_stage=capital_stage)
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
        _ = (session, decision_row, strategy, positions, snapshot)
        return (
            decision,
            SimplePolicyOutcome(
                retry_delays=[],
                advisor_metadata={
                    "enabled": False,
                    "applied": False,
                    "fallback_reason": "simple_lane",
                },
            ),
        )

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
        if settings.trading_mode == "live" and not settings.trading_simple_submit_enabled:
            self._block_decision_submission(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason="trading_simple_submit_disabled",
                submission_stage="blocked_simple_submit_disabled",
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


def _pct_cap_to_notional(*, equity: Decimal | None, pct: Decimal | None) -> Decimal | None:
    if equity is None or equity <= 0 or pct is None or pct <= 0:
        return None
    return equity * pct
