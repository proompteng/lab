from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import timedelta, timezone
from decimal import Decimal, ROUND_DOWN
from typing import TYPE_CHECKING, Any, NamedTuple, cast

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    Strategy,
    TradeDecision,
)
from ...execution_metadata import (
    execution_metadata,
    mutable_execution_metadata,
    set_execution_metadata,
)
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...session_context import regular_session_open_utc_for
from ...simple_risk import (
    position_qty_for_symbol,
)
from ..pipeline.contexts import AllocationDecisionContext
from ..submission_preparation.quote_routeability import (
    SimplePipelineSubmissionQuoteRouteabilityMixin,
)
from ..target_plan_helpers import (
    PAPER_ROUTE_PROBE_QTY_STEP as _PAPER_ROUTE_PROBE_QTY_STEP,
    PAPER_ROUTE_PROBE_REASONS as _PAPER_ROUTE_PROBE_REASONS,
    PAPER_ROUTE_RETRY_KINDS as _PAPER_ROUTE_RETRY_KINDS,
    REGULAR_SESSION_MINUTES as _REGULAR_SESSION_MINUTES,
    PaperRouteRetryKind as _PaperRouteRetryKind,
    PaperRouteRetryTransition as _PaperRouteRetryTransition,
    merge_paper_route_probe_lineage as _merge_paper_route_probe_lineage,
    optional_decimal as _optional_decimal,
    paper_route_probe_entry_metadata as _paper_route_probe_entry_metadata,
    paper_route_probe_lineage_from_params as _paper_route_probe_lineage_from_params,
    safe_int as _safe_int,
    safe_text as _safe_text,
    target_bool as _target_bool,
    target_notional_sizing_audit_from_params as _target_notional_sizing_audit_from_params,
    target_plan_lineage as _target_plan_lineage,
)

from .retry_decisions import (
    paper_route_probe_exit_metadata,
    paper_route_target_price_retry_metadata,
)
from .probe_types import (
    PaperRouteProbeContextPayloadParts,
    PaperRouteProbeContextRequest,
    PaperRouteProbeExitPositionRestoreContext,
    PaperRouteProbeRunContext,
    PaperRouteProbeTargetLookup,
)

if TYPE_CHECKING:
    from .probe_types import PaperRouteProbeRuntime
else:
    PaperRouteProbeRuntime = object


logger = logging.getLogger(__name__)


class _PaperRouteProbeExitTiming(NamedTuple):
    exit_minute: int | None
    effective_exit_minute: int | None
    exit_due_at: str | None


class _PaperRouteProbeTargetPlanContext(NamedTuple):
    target_symbols: set[str]
    target_targets: list[dict[str, Any]]
    target_source_authorized: bool


class _PaperRouteProbeEligibility(NamedTuple):
    blocking_reasons: set[str]
    symbol_route_probe_reasons: set[str]
    paper_route_probe_symbols: set[str]
    repair_symbols: set[str]


class _PaperRouteProbeMode(NamedTuple):
    context_mode: str
    source_decision_mode: str
    profit_proof_eligible: bool
    bounded_execution_policy: Mapping[str, Any] | None
    bounded_submit_path: str | None


def _paper_route_probe_run_context(
    context: PaperRouteProbeRunContext | None,
    kwargs: Mapping[str, Any],
) -> PaperRouteProbeRunContext:
    if context is not None:
        return context
    return PaperRouteProbeRunContext(
        session=cast(Session, kwargs["session"]),
        strategies=cast(list[Strategy], kwargs["strategies"]),
        account=cast(dict[str, str], kwargs["account"]),
        positions=cast(list[dict[str, Any]], kwargs["positions"]),
        allowed_symbols=cast(set[str], kwargs["allowed_symbols"]),
    )


def _paper_route_probe_context_request(
    kwargs: Mapping[str, Any],
) -> PaperRouteProbeContextRequest:
    target_lookup = cast(
        PaperRouteProbeTargetLookup | None,
        kwargs.get("target_lookup"),
    )
    if target_lookup is None:
        target_lookup = PaperRouteProbeTargetLookup(
            session=cast(Session | None, kwargs.get("session")),
            strategies=cast(Sequence[Strategy] | None, kwargs.get("strategies")),
        )
    return PaperRouteProbeContextRequest(
        proof_floor=cast(Mapping[str, object], kwargs["proof_floor"]),
        decision=cast(StrategyDecision, kwargs["decision"]),
        strategy=cast(Strategy | None, kwargs.get("strategy")),
        target_lookup=target_lookup,
    )


def _paper_route_probe_exit_restore_context(
    context: PaperRouteProbeExitPositionRestoreContext | None,
    kwargs: Mapping[str, Any],
) -> PaperRouteProbeExitPositionRestoreContext:
    if context is not None:
        return context
    return PaperRouteProbeExitPositionRestoreContext(
        positions=cast(list[dict[str, Any]], kwargs["positions"]),
        decision=cast(StrategyDecision, kwargs["decision"]),
        metadata=cast(Mapping[str, Any], kwargs["metadata"]),
        price=cast(Decimal | None, kwargs.get("price")),
        execution_adapter=kwargs.get("execution_adapter"),
        trading_mode=cast(str | None, kwargs.get("trading_mode")),
    )


class SimplePipelinePaperRouteProbeProcessingMixin(PaperRouteProbeRuntime):
    @staticmethod
    def _paper_route_retry_transition(
        decision_row: TradeDecision,
        *,
        allowed_kinds: frozenset[_PaperRouteRetryKind] = _PAPER_ROUTE_RETRY_KINDS,
    ) -> _PaperRouteRetryTransition | None:
        if "quote_routeability" in allowed_kinds:
            quote_routeability_metadata = SimplePipelineSubmissionQuoteRouteabilityMixin.paper_route_quote_routeability_retry_metadata(
                decision_row
            )
            if quote_routeability_metadata is not None:
                return _PaperRouteRetryTransition(
                    kind="quote_routeability",
                    metadata=quote_routeability_metadata,
                )
        if "target_price" in allowed_kinds:
            target_price_metadata = paper_route_target_price_retry_metadata(
                decision_row
            )
            if target_price_metadata is not None:
                return _PaperRouteRetryTransition(
                    kind="target_price",
                    metadata=target_price_metadata,
                )
        if "bounded_probe" in allowed_kinds:
            probe_metadata = SimplePipelinePaperRouteProbeProcessingMixin._paper_route_probe_retry_metadata(
                decision_row
            )
            if probe_metadata is not None:
                return _PaperRouteRetryTransition(
                    kind="bounded_probe",
                    metadata=probe_metadata,
                )
        return None

    def _reopen_rejected_paper_route_target_price_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"target_price"}),
        )
        if retry_transition is None:
            return None
        retry_metadata = retry_transition.metadata
        if self.executor.execution_exists(session, decision_row):
            return None

        self.executor.sync_decision_state(session, decision_row, decision)
        raw_decision_json = decision_row.decision_json
        decision_json = (
            dict(cast(Mapping[str, Any], raw_decision_json))
            if isinstance(raw_decision_json, Mapping)
            else {}
        )
        retry_attempts = _safe_int(
            decision_json.get("paper_route_target_price_retry_attempts")
        )
        decision_json["submission_stage"] = "paper_route_target_price_retry_pending"
        decision_json["paper_route_target_price_retry_attempts"] = retry_attempts + 1
        decision_json["paper_route_target_price_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_target_price_retry_pending",
            "symbol": decision.symbol.strip().upper(),
            "strategy_id": decision.strategy_id,
        }
        for key in (
            "risk_reasons",
            "reject_reason_atomic",
            "reject_class",
            "reject_origin",
            "broker_precheck",
        ):
            decision_json.pop(key, None)
        decision_row.status = "planned"
        decision_row.created_at = self._trading_now()
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        logger.warning(
            "Reopening paper route target source decision after transient price precheck failure strategy_id=%s decision_id=%s symbol=%s previous_reasons=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            ",".join(
                cast(list[str], retry_metadata.get("previous_risk_reasons") or [])
            ),
        )
        return decision_row

    @staticmethod
    def _restore_simulation_paper_route_probe_exit_position(
        context: PaperRouteProbeExitPositionRestoreContext | None = None,
        **kwargs: Any,
    ) -> Decimal | None:
        context = _paper_route_probe_exit_restore_context(context, kwargs)
        seed_missing = _simulation_probe_exit_seed_missing(
            execution_adapter=context.execution_adapter,
            trading_mode=context.trading_mode,
        )
        if seed_missing is None:
            return None
        db_open_qty = _optional_decimal(context.metadata.get("db_open_qty"))
        if db_open_qty is None or db_open_qty <= 0:
            return None
        open_side = str(context.metadata.get("db_open_side") or "long").strip().lower()
        if open_side not in {"long", "short"}:
            open_side = "long"

        restored_qty = (
            min(db_open_qty, context.decision.qty)
            if context.decision.qty > 0
            else db_open_qty
        )
        position: dict[str, Any] = {
            "symbol": context.decision.symbol,
            "qty": str(restored_qty),
            "side": open_side,
        }
        if context.price is not None and context.price > 0:
            position["market_value"] = str(restored_qty * context.price)
        try:
            seeded = bool(seed_missing(position))
        except Exception as exc:
            logger.warning(
                "Failed to restore simulation paper route probe exit position symbol=%s error=%s",
                context.decision.symbol,
                exc,
            )
            return None
        if not seeded:
            return None
        context.positions.append(dict(position))
        return restored_qty

    @staticmethod
    def _execution_adapter_positions(
        execution_adapter: Any | None,
    ) -> list[dict[str, Any]] | None:
        if execution_adapter is None:
            return None
        list_positions = getattr(execution_adapter, "list_positions", None)
        if not callable(list_positions):
            return None
        try:
            raw_positions = list_positions()
        except Exception as exc:
            logger.warning(
                "Failed to refresh paper route probe exit broker positions error=%s",
                exc,
            )
            return None
        if raw_positions is None or isinstance(
            raw_positions,
            (str, bytes, bytearray),
        ):
            return None
        if not isinstance(raw_positions, Sequence):
            return None
        raw_position_items = cast(Sequence[object], raw_positions)
        return [
            dict(cast(Mapping[str, Any], position))
            for position in raw_position_items
            if isinstance(position, Mapping)
        ]

    @staticmethod
    def _prepare_paper_route_probe_exit_position(
        positions: list[dict[str, Any]],
        decision: StrategyDecision,
        *,
        execution_adapter: Any | None = None,
        trading_mode: str | None = None,
    ) -> StrategyDecision | None:
        if paper_route_probe_exit_metadata(decision) is None:
            return decision
        broker_positions = (
            SimplePipelinePaperRouteProbeProcessingMixin._execution_adapter_positions(
                execution_adapter
            )
        )
        current_qty = position_qty_for_symbol(
            broker_positions if broker_positions is not None else positions,
            decision.symbol,
        )
        params = dict(decision.params)
        metadata = dict(cast(Mapping[str, Any], params["paper_route_probe_exit"]))
        execution = mutable_execution_metadata(params)
        quantity_resolution = dict(
            cast(Mapping[str, Any], execution.get("quantity_resolution") or {})
        )
        is_short_exit = decision.action == "buy"
        effective_position_qty = abs(current_qty)
        position_missing = current_qty >= 0 if is_short_exit else current_qty <= 0
        if position_missing:
            price = _optional_decimal(params.get("price"))
            restored_qty = (
                SimplePipelinePaperRouteProbeProcessingMixin._restore_simulation_paper_route_probe_exit_position(
                    PaperRouteProbeExitPositionRestoreContext(
                        positions=positions,
                        decision=decision,
                        metadata=metadata,
                        price=price,
                        execution_adapter=execution_adapter,
                        trading_mode=trading_mode,
                    )
                )
                if current_qty == 0
                else None
            )
            if restored_qty is None:
                return None
            metadata["broker_position_qty"] = str(current_qty)
            metadata["db_position_qty_fallback"] = True
            metadata["position_source"] = "source_execution_db_open_qty"
            current_qty = -restored_qty if is_short_exit else restored_qty
            effective_position_qty = restored_qty
        else:
            effective_position_qty = abs(current_qty)
            if broker_positions is not None:
                metadata["position_source"] = "execution_adapter_positions"
        if effective_position_qty < decision.qty:
            decision = decision.model_copy(update={"qty": effective_position_qty})
            metadata["qty_capped_to_position"] = True
        metadata.setdefault("broker_position_qty", str(current_qty))
        metadata["effective_position_qty"] = str(effective_position_qty)

        quantity_resolution["position_qty"] = str(decision.qty)
        execution["final_qty"] = str(decision.qty)
        execution["quantity_resolution"] = quantity_resolution
        price = _optional_decimal(params.get("price"))
        if price is not None and price > 0:
            execution["notional"] = str(decision.qty * price)
        params["paper_route_probe_exit"] = metadata
        set_execution_metadata(params, execution)
        return decision.model_copy(update={"params": params})

    def _process_paper_route_probe_retry_decisions(
        self,
        context: PaperRouteProbeRunContext | None = None,
        **kwargs: Any,
    ) -> None:
        context = _paper_route_probe_run_context(context, kwargs)
        decisions = self._paper_route_probe_retry_decisions(session=context.session)
        for decision in decisions:
            self._handle_paper_route_probe_decision(
                context=context,
                decision=decision,
                failure_label="retry",
            )

    def _process_paper_route_probe_retry_decisions_unless_target_reserved(
        self,
        context: PaperRouteProbeRunContext | None = None,
        **kwargs: Any,
    ) -> None:
        context = _paper_route_probe_run_context(context, kwargs)
        if self._paper_route_target_plan_reserves_account(
            allowed_symbols=context.allowed_symbols
        ):
            logger.info(
                "Skipping generic paper-route probe retries while bounded target-plan "
                "evidence collection owns account=%s",
                self.account_label,
            )
            return
        self._process_paper_route_probe_retry_decisions(context)

    def _process_paper_route_probe_exit_decisions(
        self,
        context: PaperRouteProbeRunContext | None = None,
        **kwargs: Any,
    ) -> None:
        context = _paper_route_probe_run_context(context, kwargs)
        decisions = self._paper_route_probe_exit_decisions(session=context.session)
        for decision in decisions:
            self._handle_paper_route_probe_decision(
                context=context,
                decision=decision,
                failure_label="exit",
            )

    def _handle_paper_route_probe_decision(
        self,
        *,
        context: PaperRouteProbeRunContext,
        decision: StrategyDecision,
        failure_label: str,
    ) -> None:
        prepared_decision = self._prepare_paper_route_probe_exit_position(
            context.positions,
            decision,
            execution_adapter=self.execution_adapter,
            trading_mode=settings.trading_mode,
        )
        if prepared_decision is None:
            return
        self.state.metrics.decisions_total += 1
        try:
            submitted = self._handle_decision(
                AllocationDecisionContext(
                    session=context.session,
                    strategies=context.strategies,
                    account=context.account,
                    positions=context.positions,
                    allowed_symbols=context.allowed_symbols,
                ),
                prepared_decision,
            )
            if submitted is not None:
                self._apply_simple_projected_buying_power(
                    context.account,
                    context.positions,
                    submitted,
                )
                self._apply_simple_projected_position(context.positions, submitted)
        except Exception:
            logger.exception(
                "Paper route probe %s handling failed strategy_id=%s symbol=%s timeframe=%s",
                failure_label,
                prepared_decision.strategy_id,
                prepared_decision.symbol,
                prepared_decision.timeframe,
            )
            self.state.metrics.orders_rejected_total += 1
            self.state.metrics.record_decision_rejection_reasons(
                ["broker_submit_failed"]
            )

    @staticmethod
    def _paper_route_probe_reference_price(
        decision: StrategyDecision,
    ) -> Decimal | None:
        for value in (
            decision.limit_price,
            decision.params.get("price"),
            (execution_metadata(decision.params) or {}).get("price"),
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
        return SimplePipelinePaperRouteProbeProcessingMixin.paper_route_probe_short_increasing_sell(
            decision
        )

    @staticmethod
    def paper_route_probe_short_increasing_sell(decision: StrategyDecision) -> bool:
        if decision.action != "sell":
            return False
        for key in ("execution", "sizing"):
            section = decision.params.get(key)
            if not isinstance(section, Mapping):
                continue
            quantity_resolution = cast(Mapping[str, Any], section).get(
                "quantity_resolution"
            )
            if not isinstance(quantity_resolution, Mapping):
                continue
            result = _short_increasing_sell_resolution(
                cast(Mapping[str, Any], quantity_resolution)
            )
            if result is not None:
                return result
        return True

    def _paper_route_probe_context(
        self,
        **kwargs: Any,
    ) -> dict[str, object] | None:
        request = _paper_route_probe_context_request(kwargs)
        cap = _paper_route_probe_cap(
            self._paper_route_target_source_cap(request.decision.params)
        )
        if not self._paper_route_probe_context_preconditions(
            proof_floor=request.proof_floor,
            decision=request.decision,
            strategy=request.strategy,
            cap=cap,
        ):
            return None
        exit_timing = self._paper_route_probe_exit_timing(
            decision=request.decision,
            strategy=request.strategy,
        )
        symbol = request.decision.symbol.strip().upper()
        target_context = self._paper_route_probe_target_plan_context(
            decision=request.decision,
            symbol=symbol,
            target_lookup=request.target_lookup,
        )
        if target_context is None:
            return None
        eligibility = self._paper_route_probe_eligibility(
            proof_floor=request.proof_floor,
            symbol=symbol,
            target_source_authorized=target_context.target_source_authorized,
        )
        if eligibility is None:
            return None
        mode = _paper_route_probe_mode(
            request.decision,
            target_source_authorized=target_context.target_source_authorized,
        )
        return _paper_route_probe_context_payload(
            PaperRouteProbeContextPayloadParts(
                proof_floor=request.proof_floor,
                decision=request.decision,
                symbol=symbol,
                cap=cast(Decimal, cap),
                target_context=target_context,
                eligibility=eligibility,
                exit_timing=exit_timing,
                mode=mode,
            )
        )

    def _paper_route_probe_context_preconditions(
        self,
        *,
        proof_floor: Mapping[str, object],
        decision: StrategyDecision,
        strategy: Strategy | None,
        cap: Decimal | None,
    ) -> bool:
        mode_allows_probe = settings.trading_mode == "paper" or (
            settings.trading_mode == "live"
            and settings.trading_simple_paper_route_probe_allow_live_mode
        )
        return (
            mode_allows_probe
            and settings.trading_simple_paper_route_probe_enabled
            and not _paper_route_probe_blocked_by_short_policy(decision)
            and decision.action in {"buy", "sell"}
            and cap is not None
            and cap > 0
            and self._proof_floor_market_session_open(proof_floor)
            and not self._paper_route_probe_entry_after_exit_minute(
                decision=decision,
                strategy=strategy,
            )
        )

    def _paper_route_probe_exit_timing(
        self,
        *,
        decision: StrategyDecision,
        strategy: Strategy | None,
    ) -> _PaperRouteProbeExitTiming:
        exit_minute = self._paper_route_probe_exit_minute_after_open(
            decision=decision,
            strategy=strategy,
        )
        if exit_minute is None:
            return _PaperRouteProbeExitTiming(
                exit_minute=None,
                effective_exit_minute=None,
                exit_due_at=None,
            )
        effective_exit_minute = min(exit_minute, _REGULAR_SESSION_MINUTES - 1)
        now = self._trading_now().astimezone(timezone.utc)
        session_open = regular_session_open_utc_for(now)
        return _PaperRouteProbeExitTiming(
            exit_minute=exit_minute,
            effective_exit_minute=effective_exit_minute,
            exit_due_at=(
                session_open + timedelta(minutes=effective_exit_minute)
            ).isoformat(),
        )

    def _paper_route_probe_target_plan_context(
        self,
        *,
        decision: StrategyDecision,
        symbol: str,
        target_lookup: PaperRouteProbeTargetLookup,
    ) -> _PaperRouteProbeTargetPlanContext | None:
        target_symbols, target_error, target_targets = (
            self._external_paper_route_target_probe_symbols_cached(
                session=target_lookup.session,
                strategies=target_lookup.strategies,
            )
        )
        if target_error:
            return None
        if target_symbols and symbol not in target_symbols:
            return None
        target_source_authorized = (
            self._paper_route_target_source_cap(decision.params) is not None
            and bool(target_symbols)
            and symbol in target_symbols
        )
        if target_symbols and not target_source_authorized:
            return None
        return _PaperRouteProbeTargetPlanContext(
            target_symbols=target_symbols,
            target_targets=target_targets,
            target_source_authorized=target_source_authorized,
        )

    def _paper_route_probe_eligibility(
        self,
        *,
        proof_floor: Mapping[str, object],
        symbol: str,
        target_source_authorized: bool,
    ) -> _PaperRouteProbeEligibility | None:
        blocking_reasons = _paper_route_probe_blocking_reasons(proof_floor)
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
            or target_source_authorized
        ):
            return None

        repair_symbols = self._proof_floor_route_repair_symbols(proof_floor)
        if (
            repair_symbols
            and symbol not in repair_symbols
            and not symbol_paper_route_probe_eligible
        ):
            return None
        return _PaperRouteProbeEligibility(
            blocking_reasons=blocking_reasons,
            symbol_route_probe_reasons=symbol_route_probe_reasons,
            paper_route_probe_symbols=paper_route_probe_symbols,
            repair_symbols=repair_symbols,
        )

    @staticmethod
    def _paper_route_probe_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        decision_json = _paper_route_probe_retry_decision_json(decision_row)
        if decision_json is None:
            return None
        reason = str(decision_json.get("submission_block_reason") or "").strip()
        if not reason:
            return None
        retry_attempts = _safe_int(
            decision_json.get("paper_route_probe_retry_attempts")
        )
        if _paper_route_probe_retry_exhausted(retry_attempts):
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

    def _paper_route_probe_capped_decision(
        self,
        *,
        decision: StrategyDecision,
        proof_floor: Mapping[str, object],
        context: Mapping[str, object],
    ) -> StrategyDecision | None:
        cap = _optional_decimal(context.get("max_notional"))
        price = self._paper_route_probe_reference_price(decision)
        if price is None or price <= 0:
            return None
        target_source_authorized = bool(context.get("target_source_authorized"))
        target_notional_sizing = _target_notional_sizing_audit_from_params(
            decision.params
        )
        if (
            target_source_authorized
            and target_notional_sizing is not None
            and decision.qty > 0
        ):
            capped_qty = decision.qty
        else:
            if cap is None or cap <= 0:
                return None
            capped_qty = (cap / price).quantize(
                _PAPER_ROUTE_PROBE_QTY_STEP,
                rounding=ROUND_DOWN,
            )
            if capped_qty <= 0:
                return None
            if decision.qty > 0 and not target_source_authorized:
                capped_qty = min(decision.qty, capped_qty)

        capped_notional = capped_qty * price
        params = dict(decision.params)
        execution = mutable_execution_metadata(params)
        execution["final_qty"] = str(capped_qty)
        execution["notional"] = str(capped_notional)
        execution["paper_route_probe_cap_applied"] = True
        if target_source_authorized:
            execution["target_source_notional_sized"] = True
        if target_notional_sizing is not None:
            execution["paper_route_target_notional_sizing"] = dict(
                target_notional_sizing
            )
        set_execution_metadata(params, execution)
        paper_route_probe = {
            **dict(context),
            "reference_price": str(price),
            "capped_qty": str(capped_qty),
            "capped_notional": str(capped_notional),
            "capital_stage": str(proof_floor.get("capital_state") or "zero_notional"),
            "target_source_notional_sized": target_source_authorized,
        }
        if target_notional_sizing is not None:
            paper_route_probe["paper_route_target_notional_sizing"] = dict(
                target_notional_sizing
            )
        params["paper_route_probe"] = paper_route_probe
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return decision.model_copy(update={"qty": capped_qty, "params": params})

    def _align_prechecked_paper_route_probe_cap(
        self,
        decision: StrategyDecision,
    ) -> StrategyDecision:
        metadata = _paper_route_probe_entry_metadata(decision.params)
        if metadata is None:
            return decision
        price = self._paper_route_probe_reference_price(decision)
        if price is None or price <= 0:
            return decision

        notional = decision.qty * price
        params = dict(decision.params)
        execution = mutable_execution_metadata(params)
        execution["final_qty"] = str(decision.qty)
        execution["notional"] = str(notional)
        execution["paper_route_probe_cap_applied"] = True
        if bool(metadata.get("target_source_authorized")):
            execution["target_source_notional_sized"] = True

        probe_metadata = dict(metadata)
        probe_metadata["reference_price"] = str(price)
        probe_metadata["capped_qty"] = str(decision.qty)
        probe_metadata["capped_notional"] = str(notional)

        set_execution_metadata(params, execution)
        params["paper_route_probe"] = probe_metadata
        _merge_paper_route_probe_lineage(
            params,
            _paper_route_probe_lineage_from_params(params),
        )
        return decision.model_copy(update={"params": params})


def _simulation_probe_exit_seed_missing(
    *,
    execution_adapter: Any | None,
    trading_mode: str | None,
) -> Any | None:
    if str(trading_mode or "").strip().lower() != "paper":
        return None
    if (
        str(getattr(execution_adapter, "name", "") or "").strip().lower()
        != "simulation"
    ):
        return None
    seed_missing = getattr(execution_adapter, "seed_missing_position_snapshot", None)
    return seed_missing if callable(seed_missing) else None


def _short_increasing_sell_resolution(
    resolution: Mapping[str, Any],
) -> bool | None:
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
    return None


def _paper_route_probe_retry_decision_json(
    decision_row: TradeDecision,
) -> Mapping[str, object] | None:
    if decision_row.status != "blocked":
        return None
    decision_json_raw = decision_row.decision_json
    if not isinstance(decision_json_raw, Mapping):
        return None
    decision_json = cast(Mapping[str, object], decision_json_raw)
    if decision_json.get("submission_stage") != "blocked_profitability_proof_floor":
        return None
    return decision_json


def _paper_route_probe_retry_exhausted(retry_attempts: int) -> bool:
    retry_limit = max(
        _safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
        0,
    )
    return retry_limit <= 0 or retry_attempts >= retry_limit


def _paper_route_probe_cap(target_source_cap: Decimal | None) -> Decimal | None:
    if target_source_cap is not None:
        return target_source_cap
    return _optional_decimal(settings.trading_simple_paper_route_probe_max_notional)


def _paper_route_probe_blocked_by_short_policy(decision: StrategyDecision) -> bool:
    return (
        decision.action == "sell"
        and not settings.trading_allow_shorts
        and SimplePipelinePaperRouteProbeProcessingMixin.paper_route_probe_short_increasing_sell(
            decision
        )
    )


def _paper_route_probe_blocking_reasons(
    proof_floor: Mapping[str, object],
) -> set[str]:
    return {
        str(item).strip()
        for item in cast(list[object], proof_floor.get("blocking_reasons") or [])
        if str(item).strip()
    }


def _paper_route_probe_mode(
    decision: StrategyDecision,
    *,
    target_source_authorized: bool,
) -> _PaperRouteProbeMode:
    if not target_source_authorized:
        return _PaperRouteProbeMode(
            context_mode="paper_route_acquisition",
            source_decision_mode=ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            profit_proof_eligible=False,
            bounded_execution_policy=None,
            bounded_submit_path=None,
        )
    requested_mode = normalize_source_decision_mode(
        decision.params.get("source_decision_mode")
    )
    if (
        requested_mode != BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        or _target_bool(decision.params.get("profit_proof_eligible")) is not True
    ):
        return _PaperRouteProbeMode(
            context_mode="paper_route_acquisition",
            source_decision_mode=ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            profit_proof_eligible=False,
            bounded_execution_policy=None,
            bounded_submit_path=None,
        )
    raw_bounded_policy = decision.params.get("bounded_paper_route_execution_policy")
    bounded_execution_policy = (
        cast(Mapping[str, Any], raw_bounded_policy)
        if isinstance(raw_bounded_policy, Mapping)
        else None
    )
    return _PaperRouteProbeMode(
        context_mode="bounded_paper_route_collection",
        source_decision_mode=BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
        profit_proof_eligible=True,
        bounded_execution_policy=bounded_execution_policy,
        bounded_submit_path=_safe_text(
            decision.params.get("bounded_paper_route_submit_path")
        ),
    )


def _paper_route_probe_context_payload(
    parts: PaperRouteProbeContextPayloadParts,
) -> dict[str, object]:
    context: dict[str, object] = {
        "enabled": True,
        "mode": parts.mode.context_mode,
        "source_decision_mode": parts.mode.source_decision_mode,
        "profit_proof_eligible": parts.mode.profit_proof_eligible,
        "max_notional": str(parts.cap),
        "symbol": parts.symbol,
        "side": parts.decision.action,
        "blocking_reasons": sorted(
            parts.eligibility.blocking_reasons
            | parts.eligibility.symbol_route_probe_reasons
        ),
        "target_source_authorized": parts.target_context.target_source_authorized,
        "route_repair_symbols": sorted(parts.eligibility.repair_symbols),
        "paper_route_probe_symbols": sorted(
            parts.eligibility.paper_route_probe_symbols
        ),
        "paper_route_target_plan_symbols": sorted(parts.target_context.target_symbols),
        "paper_route_target_plan_source": "external_target_plan_url"
        if parts.target_context.target_symbols
        else None,
        **_target_plan_lineage(parts.target_context.target_targets, parts.symbol),
        "exit_minute_after_open": parts.exit_timing.exit_minute,
        "effective_exit_minute_after_open": parts.exit_timing.effective_exit_minute,
        "exit_due_at": parts.exit_timing.exit_due_at,
        "simple_submit_enabled": settings.trading_simple_submit_enabled,
        "simple_submit_bypass_scope": "paper_route_probe_only"
        if not settings.trading_simple_submit_enabled
        else None,
    }
    if parts.mode.bounded_execution_policy is not None:
        context["bounded_paper_route_execution_policy"] = dict(
            parts.mode.bounded_execution_policy
        )
    if parts.mode.bounded_submit_path is not None:
        context["bounded_paper_route_submit_path"] = parts.mode.bounded_submit_path
    return context


__all__ = ["SimplePipelinePaperRouteProbeProcessingMixin"]
