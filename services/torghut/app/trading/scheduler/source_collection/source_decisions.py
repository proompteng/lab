from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Execution,
    PositionSnapshot,
    Strategy,
    TradeDecision,
)
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
)
from ..target_plan_helpers import (
    PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK as _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK,
    after_hours_testnet_route_enabled as _after_hours_testnet_route_enabled,
    target_bounded_collection_authorized as _target_bounded_collection_authorized,
    bounded_sim_collection_blockers as _bounded_sim_collection_blockers,
    bounded_sim_collection_reserves_account as _bounded_sim_collection_reserves_account,
    bounded_sim_collection_target_with_runtime_account_audit as _bounded_sim_collection_target_with_runtime_account_audit,
    merge_paper_route_probe_lineage as _merge_paper_route_probe_lineage,
    optional_decimal as _optional_decimal,
    paper_route_probe_lineage_from_params as _paper_route_probe_lineage_from_params,
    safe_text as _safe_text,
    target_active_in_window as _target_active_in_window,
    target_owns_bounded_sim_collection_account as _target_owns_bounded_sim_collection_account,
    target_pair_balance_state as _target_pair_balance_state,
    target_plan_has_active_bounded_sim_collection_owner as _target_plan_has_active_bounded_sim_collection_owner,
    target_probe_action as _target_probe_action,
    target_probe_cap as _target_probe_cap,
    target_probe_exit_minute_after_open as _target_probe_exit_minute_after_open,
    target_probe_symbol_actions as _target_probe_symbol_actions,
    target_probe_symbol_quantities as _target_probe_symbol_quantities,
    target_probe_window as _target_probe_window,
    target_requires_bounded_sim_collection_gate as _target_requires_bounded_sim_collection_gate,
    target_runtime_account_matches as _target_runtime_account_matches,
    target_symbols as _target_symbols,
    target_truthy as _target_truthy,
)
from ..submission_preparation.shared import TargetQuantityResolutionRequest
from .collection_types import (
    SourceCollectionAction,
    SourceCollectionDecisionPayload,
    SourceCollectionDecisionRun,
    SourceCollectionMode,
    SourceCollectionState,
    SourceCollectionTargetContext,
)
from .decision_helpers import (
    apply_source_collection_quantity_resolution,
    balanced_pair_needs_short_permission,
    log_target_notional_sizing_blocker,
    source_collection_broker_quantity_resolution,
    source_collection_has_unrepaired_exposure,
    source_collection_params,
    source_collection_profit_proof_exposure,
    source_collection_execution_metadata,
    source_collection_strategy_exposure,
    source_collection_symbols,
    source_collection_timeframe,
    source_collection_window_active,
)

if TYPE_CHECKING:
    from .collection_types import (
        SourceCollectionRuntime as SourceCollectionRuntimeMixin,
    )
else:
    SourceCollectionRuntimeMixin = object

logger = logging.getLogger(__name__)


class SimplePipelineSourceCollectionDecisionMixin(SourceCollectionRuntimeMixin):
    def _paper_route_target_source_decisions(
        self,
        *,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        positions: Sequence[Mapping[str, Any]] | None = None,
        session: Session | None = None,
    ) -> list[StrategyDecision]:
        state = self._paper_route_target_source_collection_state(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
            session=session,
        )
        if state is None:
            return []

        decisions: list[StrategyDecision] = []
        seen: set[tuple[str, str, str, str]] = set()
        for raw_target in state.target_plan_targets:
            context = self._paper_route_target_source_context(
                raw_target,
                strategies=strategies,
                positions=positions,
                state=state,
            )
            if context is None:
                continue
            blocked_symbols = self._paper_route_target_blocked_open_exposure_symbols(
                context,
                positions=positions,
                session=session,
            )
            if blocked_symbols and context.pair_balance_state == "balanced":
                logger.warning(
                    "Skipping balanced paper-route pair target because existing "
                    "strategy exposure is still open strategy=%s symbols=%s "
                    "blocked_symbols=%s",
                    context.strategy.name,
                    context.symbols,
                    blocked_symbols,
                )
                continue
            run = SourceCollectionDecisionRun(
                session=session,
                positions=positions,
                blocked_symbols=set(blocked_symbols),
                seen=seen,
                now=state.now,
            )
            for symbol in context.symbols:
                decision = self._paper_route_target_source_decision_for_symbol(
                    context,
                    symbol=symbol,
                    run=run,
                )
                if decision is not None:
                    decisions.append(decision)
        if not decisions and state.target_plan_targets:
            self._record_bounded_target_plan_blocker(
                reason="paper_route_target_plan_source_decisions_missing",
                symbols=state.target_symbols,
                targets=state.target_plan_targets,
            )
        return decisions

    def _paper_route_target_source_collection_state(
        self,
        *,
        strategies: Sequence[Strategy],
        allowed_symbols: set[str],
        session: Session | None,
    ) -> SourceCollectionState | None:
        trading_mode = settings.trading_mode
        if trading_mode not in {"paper", "live"}:
            return None
        if not settings.trading_simple_paper_route_probe_enabled:
            return None
        now = self._trading_now().astimezone(timezone.utc)
        if trading_mode == "live" and (
            blocker := self._live_bounded_paper_route_source_collection_blocker(now)
        ):
            self._record_bounded_target_plan_blocker(reason=blocker)
            return None
        market_session_open = self._is_market_session_open(now)
        if not market_session_open and _after_hours_testnet_route_enabled(
            trading_mode=trading_mode,
            paper_route_probe_enabled=settings.trading_simple_paper_route_probe_enabled,
            paper_route_probe_allow_live_mode=(
                settings.trading_simple_paper_route_probe_allow_live_mode
            ),
            testnet_after_hours_enabled=settings.trading_testnet_after_hours_enabled,
            market_session_open=market_session_open,
        ):
            return None
        if not market_session_open:
            self._record_bounded_target_plan_blocker(
                reason="alpaca_regular_session_closed"
            )
            return None
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=session,
                strategies=strategies,
            )
        )
        if target_plan_error:
            self._record_bounded_target_plan_blocker(
                reason=target_plan_error,
                symbols=target_symbols,
                targets=target_plan_targets,
            )
            return None
        if not target_symbols:
            if str(settings.trading_paper_route_target_plan_url or "").strip():
                self._record_bounded_target_plan_blocker(
                    reason="paper_route_target_plan_probe_symbols_missing",
                    symbols=target_symbols,
                    targets=target_plan_targets,
                )
            return None

        normalized_allowed = {
            symbol.strip().upper() for symbol in allowed_symbols if symbol.strip()
        }
        bounded_sim_owner_active = _target_plan_has_active_bounded_sim_collection_owner(
            target_plan_targets,
            account_label=self.account_label,
            now=now,
        )
        return SourceCollectionState(
            now=now,
            target_symbols=target_symbols,
            target_plan_targets=target_plan_targets,
            normalized_allowed=normalized_allowed,
            bounded_sim_owner_active=bounded_sim_owner_active,
        )

    def _paper_route_target_source_context(
        self,
        raw_target: Mapping[str, Any],
        *,
        strategies: Sequence[Strategy],
        positions: Sequence[Mapping[str, Any]] | None,
        state: SourceCollectionState,
    ) -> SourceCollectionTargetContext | None:
        if settings.trading_mode == "live":
            target = self._live_bounded_paper_route_target(raw_target)
            if target is None:
                return None
        else:
            target = _bounded_sim_collection_target_with_runtime_account_audit(
                raw_target,
                positions=(
                    positions
                    if _target_requires_bounded_sim_collection_gate(raw_target)
                    else None
                ),
                account_label=self.account_label,
            )
        window = _target_probe_window(target)
        target_cap = _target_probe_cap(target)
        strategy = self._paper_route_target_strategy(target, strategies)
        if self._paper_route_target_owner_skip(target, state=state):
            return None
        if self._paper_route_target_bounded_gate_blocked(target):
            return None
        if window is None or not source_collection_window_active(window, state.now):
            return None
        if self._paper_route_target_entry_window_elapsed(
            target,
            window=window,
            state=state,
        ):
            return None
        if target_cap is None or target_cap <= 0 or strategy is None:
            return None

        symbols = source_collection_symbols(
            target,
            target_symbols=state.target_symbols,
            normalized_allowed=state.normalized_allowed,
            strategy_symbols=self._paper_route_target_strategy_symbols(strategy),
        )
        symbol_actions = _target_probe_symbol_actions(target, symbols)
        symbol_quantities = _target_probe_symbol_quantities(target, symbols)
        pair_balance_state = _target_pair_balance_state(target, symbol_actions)
        context = SourceCollectionTargetContext(
            target=target,
            strategy=strategy,
            symbols=symbols,
            symbol_actions=symbol_actions,
            symbol_quantities=symbol_quantities,
            pair_balance_state=pair_balance_state,
            window_start=window[0],
            window_end=window[1],
            target_cap=target_cap,
        )
        if self._paper_route_target_pair_gate_blocked(
            context,
            positions=positions,
        ):
            return None
        return context

    def _paper_route_target_entry_window_elapsed(
        self,
        target: Mapping[str, Any],
        *,
        window: tuple[datetime, datetime],
        state: SourceCollectionState,
    ) -> bool:
        exit_minute, _ = _target_probe_exit_minute_after_open(target)
        if exit_minute is None:
            return False
        window_start, window_end = window
        window_minutes = max(1, int((window_end - window_start).total_seconds() // 60))
        effective_exit_minute = min(exit_minute, window_minutes - 1)
        exit_due_at = window_start + timedelta(minutes=effective_exit_minute)
        if state.now < exit_due_at:
            return False
        self._record_bounded_target_plan_blocker(
            reason="target_plan_entry_window_closed",
            symbols=state.target_symbols,
            targets=[target],
        )
        return True

    def _live_bounded_paper_route_source_collection_blocker(
        self,
        now: datetime,
    ) -> str | None:
        if not settings.trading_simple_paper_route_probe_allow_live_mode:
            return "live_paper_route_probe_collection_disabled"
        if not settings.trading_simple_submit_enabled:
            return "submit_disabled"
        max_notional = _optional_decimal(
            settings.trading_simple_paper_route_probe_max_notional
        )
        if max_notional is None or max_notional <= 0:
            return "paper_route_probe_notional_not_configured"
        return None

    def _live_bounded_paper_route_target(
        self,
        raw_target: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        target = dict(raw_target)
        target_cap = _target_probe_cap(target)
        configured_cap = _optional_decimal(
            settings.trading_simple_paper_route_probe_max_notional
        )
        if target_cap is None or configured_cap is None:
            capped_notional: Decimal | None = None
        else:
            capped_notional = min(target_cap, configured_cap)
        promotion_requested = any(
            _target_truthy(target.get(key))
            for key in (
                "promotion_allowed",
                "capital_promotion_allowed",
                "final_promotion_authorized",
                "final_promotion_allowed",
            )
        )
        if (
            capped_notional is None
            or capped_notional <= 0
            or not _target_bounded_collection_authorized(target)
            or _safe_text(target.get("source_kind")) is None
            or promotion_requested
        ):
            return None

        symbols = sorted(_target_symbols(target))
        if not symbols:
            return None
        target["paper_route_probe_total_max_notional"] = str(capped_notional)
        target["paper_route_probe_next_session_max_notional"] = str(capped_notional)
        target["paper_route_probe_effective_max_notional"] = str(capped_notional)
        target["bounded_evidence_collection_max_notional"] = str(capped_notional)
        target["max_notional"] = str(capped_notional)
        target.setdefault("paper_route_probe_symbols", symbols)
        target.setdefault("observed_stage", "paper")
        target["bounded_evidence_collection_authorized"] = True
        target["bounded_live_paper_collection_authorized"] = True
        target["source_collection_authorized"] = True
        target.setdefault(
            "source_collection_authorization_scope",
            "source_window_evidence_collection_only",
        )
        target.setdefault("evidence_collection_ok", True)
        target.setdefault(
            "source_manifest_ref",
            f"trading_proofs:{_safe_text(target.get('candidate_id')) or _safe_text(target.get('hypothesis_id')) or 'unknown'}",
        )
        target["execution_account_label"] = self.account_label
        target["paper_route_runtime_account_label"] = self.account_label
        target["paper_account_label"] = self.account_label
        return target

    def _paper_route_target_owner_skip(
        self,
        target: Mapping[str, Any],
        *,
        state: SourceCollectionState,
    ) -> bool:
        if not (
            state.bounded_sim_owner_active
            and _target_runtime_account_matches(
                target,
                account_label=self.account_label,
            )
            and not _target_owns_bounded_sim_collection_account(target)
        ):
            return False
        logger.warning(
            "Skipping paper-route target source collection because bounded "
            "H-PAIRS evidence collection owns account=%s hypothesis_id=%s "
            "candidate_id=%s runtime_strategy_name=%s",
            self.account_label,
            _safe_text(target.get("hypothesis_id")),
            _safe_text(target.get("candidate_id")),
            _safe_text(target.get("runtime_strategy_name")),
        )
        return True

    def _paper_route_target_bounded_gate_blocked(
        self,
        target: Mapping[str, Any],
    ) -> bool:
        if settings.trading_mode == "live" and _target_truthy(
            target.get("bounded_live_paper_collection_authorized")
        ):
            return False
        if not _target_requires_bounded_sim_collection_gate(target):
            return False
        collection_blockers = _bounded_sim_collection_blockers(
            target,
            account_label=self.account_label,
        )
        if not collection_blockers:
            return False
        logger.warning(
            "Skipping paper-route target source collection because bounded SIM collection is not authorized blockers=%s",
            ",".join(collection_blockers),
        )
        return True

    def _paper_route_target_pair_gate_blocked(
        self,
        context: SourceCollectionTargetContext,
        *,
        positions: Sequence[Mapping[str, Any]] | None,
    ) -> bool:
        if _target_requires_bounded_sim_collection_gate(
            context.target
        ) and self._paper_route_target_account_has_open_exposure(positions):
            logger.warning(
                "Skipping paper-route target source collection because account "
                "is not flat for bounded SIM evidence strategy=%s symbols=%s",
                context.strategy.name,
                context.symbols,
            )
            return True
        if context.pair_balance_state == "imbalanced":
            logger.warning(
                "Skipping imbalanced paper-route pair target strategy=%s symbols=%s actions=%s",
                context.strategy.name,
                context.symbols,
                context.symbol_actions,
            )
            return True
        if balanced_pair_needs_short_permission(
            context.pair_balance_state,
            context.symbol_actions,
        ):
            logger.warning(
                "Skipping balanced paper-route pair target because shorts are disabled strategy=%s symbols=%s",
                context.strategy.name,
                context.symbols,
            )
            return True
        return False

    def _paper_route_target_blocked_open_exposure_symbols(
        self,
        context: SourceCollectionTargetContext,
        *,
        positions: Sequence[Mapping[str, Any]] | None,
        session: Session | None,
    ) -> list[str]:
        blocked_symbols: list[str] = []
        for symbol in context.symbols:
            if self._paper_route_target_symbol_has_open_position(positions, symbol):
                blocked_symbols.append(symbol)
                continue
            if (
                session is not None
                and self._paper_route_target_symbol_has_open_strategy_exposure(
                    session=session,
                    strategy=context.strategy,
                    symbol=symbol,
                    account_label=self.account_label,
                    window_start=context.window_start,
                )
            ):
                blocked_symbols.append(symbol)
        return blocked_symbols

    def _paper_route_target_source_decision_for_symbol(
        self,
        context: SourceCollectionTargetContext,
        *,
        symbol: str,
        run: SourceCollectionDecisionRun,
    ) -> StrategyDecision | None:
        action = context.symbol_actions.get(
            symbol,
            _target_probe_action(context.target),
        )
        if action == "sell" and not settings.trading_allow_shorts:
            return None
        if symbol in run.blocked_symbols:
            return None
        if (
            run.session is not None
            and self._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=run.session,
                strategy=context.strategy,
                symbol=symbol,
                account_label=self.account_label,
                window_start=context.window_start,
            )
        ):
            return None
        key = (
            str(context.strategy.id),
            symbol,
            context.window_start.isoformat(),
            action,
        )
        if key in run.seen:
            return None
        run.seen.add(key)
        payload = self._paper_route_target_source_decision_payload(
            context,
            symbol=symbol,
            action=action,
            positions=run.positions,
            now=run.now,
        )
        if payload is None:
            return None
        return StrategyDecision(
            strategy_id=str(context.strategy.id),
            symbol=symbol,
            event_ts=run.now,
            timeframe=payload.timeframe,
            action=action,
            qty=payload.qty,
            order_type="market",
            time_in_force="day",
            rationale="external paper-route target plan source decision",
            params=payload.params,
        )

    def _paper_route_target_source_decision_payload(
        self,
        context: SourceCollectionTargetContext,
        *,
        symbol: str,
        action: SourceCollectionAction,
        positions: Sequence[Mapping[str, Any]] | None,
        now: datetime,
    ) -> SourceCollectionDecisionPayload | None:
        metadata, mode = self._paper_route_target_source_collection_metadata(
            context,
            symbol=symbol,
            action=action,
        )
        execution_metadata = source_collection_execution_metadata(
            context,
            metadata=metadata,
            mode=mode,
            action=action,
        )
        params = source_collection_params(
            context,
            symbol=symbol,
            metadata=metadata,
            execution_metadata=execution_metadata,
            mode=mode,
        )
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        timeframe = source_collection_timeframe(context)
        requested_qty = context.symbol_quantities.get(symbol, Decimal("1"))
        quantity_resolution = self._paper_route_target_quantity_resolution(
            TargetQuantityResolutionRequest(
                target=context.target,
                symbol=symbol,
                symbols=context.symbols,
                action=action,
                requested_qty=requested_qty,
                symbol_quantities=context.symbol_quantities,
                max_notional=context.target_cap,
                event_ts=now,
                timeframe=timeframe,
            )
        )
        if quantity_resolution is None:
            return None
        if quantity_resolution.audit.get("sizing_source") != "target_notional":
            log_target_notional_sizing_blocker(
                context,
                symbol=symbol,
                blockers=quantity_resolution.audit.get("blockers"),
            )
            return None
        broker_quantity_resolution = source_collection_broker_quantity_resolution(
            context,
            symbol=symbol,
            action=action,
            positions=positions,
            quantity_resolution=quantity_resolution,
        )
        if broker_quantity_resolution is None:
            return None
        apply_source_collection_quantity_resolution(
            metadata=metadata,
            execution_metadata=execution_metadata,
            params=params,
            quantity_resolution=broker_quantity_resolution,
        )
        return SourceCollectionDecisionPayload(
            params=params,
            qty=broker_quantity_resolution.qty,
            timeframe=timeframe,
        )

    def _paper_route_target_source_collection_metadata(
        self,
        context: SourceCollectionTargetContext,
        *,
        symbol: str,
        action: SourceCollectionAction,
    ) -> tuple[dict[str, Any], SourceCollectionMode]:
        metadata = self._paper_route_target_source_decision_metadata(
            context=context,
            symbol=symbol,
        )
        metadata["paper_route_probe_symbol_actions"] = dict(context.symbol_actions)
        if context.symbol_quantities:
            metadata["paper_route_probe_symbol_quantities"] = {
                item_symbol: str(quantity)
                for item_symbol, quantity in context.symbol_quantities.items()
            }
        metadata["paper_route_probe_pair_balance_required"] = (
            context.pair_balance_state != "not_required"
        )
        metadata["paper_route_probe_pair_balance_state"] = context.pair_balance_state
        metadata["paper_route_probe_leg_action"] = action
        mode = self._paper_route_target_source_collection_mode(
            context,
            metadata=metadata,
            symbol=symbol,
            action=action,
        )
        return metadata, mode

    def _paper_route_target_source_collection_mode(
        self,
        context: SourceCollectionTargetContext,
        *,
        metadata: dict[str, Any],
        symbol: str,
        action: SourceCollectionAction,
    ) -> SourceCollectionMode:
        execution_metadata = (
            self._bounded_paper_route_execution_metadata(
                context=context,
                symbol=symbol,
                action=action,
                account_label=self.account_label,
            )
            if _target_requires_bounded_sim_collection_gate(context.target)
            else {}
        )
        if (
            _safe_text(execution_metadata.get("submit_path"))
            != "bounded_paper_route_collection"
        ):
            return SourceCollectionMode(
                source_decision_mode=ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                profit_proof_eligible=False,
                execution_metadata=execution_metadata,
            )
        metadata["source_decision_mode"] = (
            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        )
        metadata["profit_proof_eligible"] = True
        metadata["bounded_paper_route_submit_path"] = execution_metadata["submit_path"]
        metadata["bounded_paper_route_execution_policy"] = execution_metadata[
            "execution_policy"
        ]
        return SourceCollectionMode(
            source_decision_mode=BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            profit_proof_eligible=True,
            execution_metadata=execution_metadata,
        )

    def _paper_route_target_plan_reserves_account(
        self,
        *,
        allowed_symbols: set[str],
    ) -> bool:
        now = self._trading_now().astimezone(timezone.utc)
        if not self._paper_route_target_plan_reservation_enabled(now):
            return False
        target_symbols, target_plan_error, target_plan_targets = (
            self._external_paper_route_target_probe_symbols_cached()
        )
        if target_plan_error:
            return self._paper_route_target_plan_error_reserves_account(
                target_plan_error=target_plan_error,
                target_symbols=target_symbols,
                target_plan_targets=target_plan_targets,
            )
        if not target_symbols:
            return False
        return any(
            self._paper_route_target_reserves_account(target, now)
            for target in target_plan_targets
        )

    def _paper_route_target_plan_reservation_enabled(self, now: datetime) -> bool:
        return (
            (
                settings.trading_mode == "paper"
                or (
                    settings.trading_mode == "live"
                    and settings.trading_simple_paper_route_probe_allow_live_mode
                )
            )
            and settings.trading_simple_paper_route_probe_enabled
            and self._is_market_session_open(now)
        )

    def _paper_route_target_plan_error_reserves_account(
        self,
        *,
        target_plan_error: str,
        target_symbols: set[str],
        target_plan_targets: list[dict[str, Any]],
    ) -> bool:
        if not str(settings.trading_paper_route_target_plan_url or "").strip():
            return False
        self._record_bounded_target_plan_blocker(
            reason=target_plan_error,
            symbols=target_symbols,
            targets=target_plan_targets,
        )
        return True

    def _paper_route_target_reserves_account(
        self,
        target: Mapping[str, Any],
        now: datetime,
    ) -> bool:
        return (
            _target_requires_bounded_sim_collection_gate(target)
            and _bounded_sim_collection_reserves_account(
                target,
                account_label=self.account_label,
            )
            and _target_owns_bounded_sim_collection_account(target)
            and _target_active_in_window(target, now)
        )

    @staticmethod
    def _paper_route_target_symbol_has_open_strategy_exposure(
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        account_label: str,
        window_start: datetime,
    ) -> bool:
        strategy_id = getattr(strategy, "id", None)
        normalized_symbol = symbol.strip().upper()
        if strategy_id is None or not normalized_symbol:
            return False

        guard_start = window_start - _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK
        try:
            rows = session.execute(
                select(Execution.side, Execution.filled_qty, Execution.created_at)
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == account_label,
                    TradeDecision.alpaca_account_label == account_label,
                    TradeDecision.strategy_id == strategy_id,
                    Execution.symbol == normalized_symbol,
                    TradeDecision.symbol == normalized_symbol,
                    Execution.filled_qty > 0,
                    Execution.status.in_(("filled", "partially_filled")),
                    Execution.created_at >= guard_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route target strategy exposure "
                "strategy_id=%s symbol=%s account_label=%s",
                strategy_id,
                normalized_symbol,
                account_label,
            )
            return True

        exposure = source_collection_strategy_exposure(rows)
        return source_collection_has_unrepaired_exposure(
            session=session,
            account_label=account_label,
            symbol=normalized_symbol,
            exposure=exposure,
            flat_repair_snapshot_lookup=(
                SimplePipelineSourceCollectionDecisionMixin._paper_route_target_symbol_has_flat_repair_snapshot
            ),
        )

    @staticmethod
    def _paper_route_target_symbol_has_flat_repair_snapshot(
        *,
        session: Session,
        account_label: str,
        symbol: str,
        after: datetime | None,
    ) -> bool:
        if after is None:
            return False
        try:
            row = session.execute(
                select(PositionSnapshot.positions, PositionSnapshot.as_of)
                .where(
                    PositionSnapshot.alpaca_account_label == account_label,
                    PositionSnapshot.as_of >= after,
                )
                .order_by(desc(PositionSnapshot.as_of))
                .limit(1)
            ).first()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route flat repair snapshot symbol=%s account_label=%s",
                symbol,
                account_label,
            )
            return False
        if row is None:
            return False
        positions = row[0]
        if not isinstance(positions, Sequence) or isinstance(
            positions, (bytes, bytearray, str)
        ):
            return False
        return not SimplePipelineSourceCollectionDecisionMixin._paper_route_target_symbol_has_open_position(
            cast(Sequence[Mapping[str, Any]], positions),
            symbol,
        )

    @staticmethod
    def _paper_route_target_symbol_has_open_profit_proof_exposure(
        *,
        session: Session,
        strategy: Strategy,
        symbol: str,
        account_label: str,
        window_start: datetime,
    ) -> bool:
        strategy_id = getattr(strategy, "id", None)
        normalized_symbol = symbol.strip().upper()
        if strategy_id is None or not normalized_symbol:
            return False

        guard_start = window_start - _PAPER_ROUTE_TARGET_PROFIT_PROOF_EXPOSURE_LOOKBACK
        try:
            rows = session.execute(
                select(
                    Execution.side,
                    Execution.filled_qty,
                    TradeDecision.decision_json,
                    Execution.created_at,
                )
                .join(TradeDecision, Execution.trade_decision_id == TradeDecision.id)
                .where(
                    Execution.alpaca_account_label == account_label,
                    TradeDecision.alpaca_account_label == account_label,
                    TradeDecision.strategy_id == strategy_id,
                    Execution.symbol == normalized_symbol,
                    TradeDecision.symbol == normalized_symbol,
                    Execution.filled_qty > 0,
                    Execution.status.in_(("filled", "partially_filled")),
                    Execution.created_at >= guard_start,
                )
            ).all()
        except Exception:
            logger.exception(
                "Failed to inspect paper-route target source proof exposure "
                "strategy_id=%s symbol=%s account_label=%s",
                strategy_id,
                normalized_symbol,
                account_label,
            )
            return True

        exposure = source_collection_profit_proof_exposure(rows)
        return source_collection_has_unrepaired_exposure(
            session=session,
            account_label=account_label,
            symbol=normalized_symbol,
            exposure=exposure,
            flat_repair_snapshot_lookup=(
                SimplePipelineSourceCollectionDecisionMixin._paper_route_target_symbol_has_flat_repair_snapshot
            ),
        )

    @staticmethod
    def _paper_route_target_symbol_has_open_position(
        positions: Sequence[Mapping[str, Any]] | None,
        symbol: str,
    ) -> bool:
        if not positions:
            return False
        normalized_symbol = symbol.strip().upper()
        if not normalized_symbol:
            return False
        for position in positions:
            if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
                continue
            for qty_key in ("qty", "quantity", "qty_available"):
                qty = _optional_decimal(position.get(qty_key))
                if qty is not None and qty != 0:
                    return True
            market_value = _optional_decimal(position.get("market_value"))
            if market_value is not None and market_value != 0:
                return True
        return False

    @staticmethod
    def _paper_route_positions_without_materialized_open_order_projections(
        positions: Sequence[Mapping[str, Any]] | None,
        materialized_client_order_ids: set[str],
    ) -> list[Mapping[str, Any]]:
        if not positions:
            return []
        if not materialized_client_order_ids:
            return [position for position in positions]

        filtered_positions: list[Mapping[str, Any]] = []
        for position in positions:
            if SimplePipelineSourceCollectionDecisionMixin._paper_route_position_is_materialized_projection(
                position,
                materialized_client_order_ids,
            ):
                continue
            filtered_positions.append(position)
        return filtered_positions

    @staticmethod
    def _paper_route_position_is_materialized_projection(
        position: Mapping[str, Any],
        materialized_client_order_ids: set[str],
    ) -> bool:
        if not bool(position.get("open_order_projection")):
            return False
        if not bool(position.get("open_order_projection_only")):
            return False
        raw_ids = position.get("open_order_client_order_ids")
        client_order_ids: set[str] = set()
        if isinstance(raw_ids, list):
            client_order_ids.update(
                str(item).strip()
                for item in cast(list[Any], raw_ids)
                if str(item).strip()
            )
        raw_id = str(position.get("open_order_client_order_id") or "").strip()
        if raw_id:
            client_order_ids.add(raw_id)
        if not client_order_ids:
            return False
        return client_order_ids.issubset(materialized_client_order_ids)

    @staticmethod
    def _paper_route_target_account_has_open_exposure(
        positions: Sequence[Mapping[str, Any]] | None,
    ) -> bool:
        if not positions:
            return False
        for position in positions:
            for qty_key in ("qty", "quantity", "qty_available"):
                qty = _optional_decimal(position.get(qty_key))
                if qty is not None and qty != 0:
                    return True
            market_value = _optional_decimal(position.get("market_value"))
            if market_value is not None and market_value != 0:
                return True
        return False


__all__ = ["SimplePipelineSourceCollectionDecisionMixin"]
