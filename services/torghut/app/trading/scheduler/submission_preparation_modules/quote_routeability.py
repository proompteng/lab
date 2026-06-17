from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Literal, Optional, cast

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    TradeDecision,
)
from ...models import StrategyDecision
from ...prices import MarketSnapshot
from ...quote_quality import (
    QuoteQualityStatus,
)
from ...simple_risk import (
    prepare_simple_decision,
)
from ..target_plan_helpers import (
    mapping_value,
    min_optional_decimal,
    optional_decimal,
    paper_route_probe_entry_metadata,
    pct_cap_to_notional,
    safe_int,
    safe_text,
    target_notional_sizing_audit_from_params,
    target_plan_symbols,
)


from ..pipeline_modules.shared import TradingPipelineBase

from .quote_routeability_values import (
    assess_paper_route_quote_status,
    quote_routeability_inputs,
    quote_routeability_values,
)
from .shared import (
    QuoteRouteabilityPayloadRequest,
    SubmissionPreparationRequest,
    logger,
)


class SimplePipelineSubmissionQuoteRouteabilityMixin(TradingPipelineBase):
    def _paper_route_quote_routeability(
        self,
        decision: StrategyDecision,
        snapshot: MarketSnapshot | None,
    ) -> tuple[QuoteQualityStatus, dict[str, object]]:
        inputs = quote_routeability_inputs(decision, snapshot)
        values = quote_routeability_values(decision, inputs)
        status = assess_paper_route_quote_status(decision, values)
        status = self._apply_quote_lookup_diagnostic_reason(
            status,
            quote_lookup_diagnostics=values.quote_lookup_diagnostics,
        )
        target_mismatch = self._paper_route_target_plan_source_mismatch(decision)
        if target_mismatch is not None:
            status = QuoteQualityStatus(
                valid=False,
                reason="target_plan_source_mismatch",
                spread_bps=status.spread_bps,
                jump_bps=status.jump_bps,
                quote_age_seconds=status.quote_age_seconds,
                source=values.source,
                price=status.price,
                bid=status.bid,
                ask=status.ask,
                fillability_state="blocked",
                repair_action="skip_symbol_until_target_plan_source_matches_decision",
                operator_next_action="skip_symbol",
                evidence_requirements=(
                    "target_plan_symbol_scope",
                    "strategy_source_decision_lineage",
                ),
            )
        routeability = self._paper_route_quote_routeability_payload(
            QuoteRouteabilityPayloadRequest(
                decision=decision,
                status=status,
                source=values.source,
                quote_as_of=values.quote_as_of,
                quote_lookup_diagnostics=values.quote_lookup_diagnostics,
                target_mismatch=target_mismatch,
            )
        )
        return status, routeability

    @staticmethod
    def _apply_quote_lookup_diagnostic_reason(
        status: QuoteQualityStatus,
        *,
        quote_lookup_diagnostics: Mapping[str, object] | None,
    ) -> QuoteQualityStatus:
        if status.valid or status.reason != "missing_executable_quote":
            return status
        if not isinstance(quote_lookup_diagnostics, Mapping):
            return status
        diagnostic_reason = safe_text(
            quote_lookup_diagnostics.get("latest_quote_rejected_reason")
        )
        if diagnostic_reason not in {
            "crossed_quote",
            "non_positive_bid",
            "non_positive_ask",
            "spread_bps_exceeded",
        }:
            return status
        return QuoteQualityStatus(
            valid=False,
            reason=diagnostic_reason,
            spread_bps=optional_decimal(
                quote_lookup_diagnostics.get("latest_quote_spread_bps")
            )
            or status.spread_bps,
            jump_bps=status.jump_bps,
            quote_age_seconds=status.quote_age_seconds,
            source=status.source,
            price=status.price,
            bid=status.bid,
            ask=status.ask,
        )

    @staticmethod
    def _paper_route_target_plan_source_mismatch(
        decision: StrategyDecision,
    ) -> dict[str, object] | None:
        metadata = mapping_value(
            decision.params.get("paper_route_target_plan_source_decision")
        ) or mapping_value(decision.params.get("paper_route_target_plan"))
        if metadata is None:
            return None
        symbol = decision.symbol.strip().upper()
        metadata_symbol = safe_text(metadata.get("symbol"))
        target_symbols = target_plan_symbols(metadata)
        mismatches: list[str] = []
        if metadata_symbol is not None and metadata_symbol.upper() != symbol:
            mismatches.append("target_plan_symbol_mismatch")
        if target_symbols and symbol not in target_symbols:
            mismatches.append("target_plan_symbol_scope_mismatch")
        expected_action = SimplePipelineSubmissionQuoteRouteabilityMixin._target_plan_action_for_symbol(
            metadata,
            symbol=symbol,
        )
        decision_action = SimplePipelineSubmissionQuoteRouteabilityMixin._normalize_target_plan_action(
            decision.action
        )
        if expected_action is not None and decision_action != expected_action:
            mismatches.append("target_plan_side_mismatch")
        if not mismatches:
            return None
        return {
            "schema_version": "torghut.paper-route-target-plan-source-mismatch.v1",
            "symbol": symbol,
            "metadata_symbol": metadata_symbol,
            "target_symbols": sorted(target_symbols),
            "decision_action": decision_action,
            "target_action": expected_action,
            "mismatches": mismatches,
        }

    @staticmethod
    def _target_plan_action_for_symbol(
        metadata: Mapping[str, Any],
        *,
        symbol: str,
    ) -> Literal["buy", "sell"] | None:
        normalized_symbol = symbol.strip().upper()
        raw_actions = metadata.get("paper_route_probe_symbol_actions")
        if isinstance(raw_actions, Mapping):
            for raw_symbol, raw_action in cast(
                Mapping[object, object], raw_actions
            ).items():
                if str(raw_symbol).strip().upper() != normalized_symbol:
                    continue
                return SimplePipelineSubmissionQuoteRouteabilityMixin._normalize_target_plan_action(
                    raw_action
                )
        metadata_symbol = safe_text(metadata.get("symbol"))
        direct_symbol_matches = (
            metadata_symbol is None or metadata_symbol.upper() == normalized_symbol
        )
        if not direct_symbol_matches:
            return None
        for key in (
            "paper_route_probe_leg_action",
            "paper_route_probe_action",
            "probe_action",
            "action",
            "side",
        ):
            action = SimplePipelineSubmissionQuoteRouteabilityMixin._normalize_target_plan_action(
                metadata.get(key)
            )
            if action is not None:
                return action
        return None

    @staticmethod
    def _normalize_target_plan_action(value: object) -> Literal["buy", "sell"] | None:
        normalized = str(value or "").strip().lower()
        if normalized in {"buy", "long"}:
            return "buy"
        if normalized in {"sell", "short"}:
            return "sell"
        return None

    @staticmethod
    def _paper_route_quote_routeability_payload(
        request: QuoteRouteabilityPayloadRequest,
    ) -> dict[str, object]:
        decision = request.decision
        status = cast(QuoteQualityStatus, request.status)
        blockers = [] if status.valid else [status.reason or "missing_executable_quote"]
        return {
            "schema_version": "torghut.paper-route-quote-routeability.v1",
            "status": "accepted" if status.valid else "blocked",
            "reason": status.reason if not status.valid else "executable_quote_ready",
            "symbol": decision.symbol.strip().upper(),
            "source": request.source,
            "quote_as_of": request.quote_as_of.isoformat()
            if request.quote_as_of is not None
            else None,
            "quote_age_seconds": str(status.quote_age_seconds)
            if status.quote_age_seconds is not None
            else None,
            "spread_bps": str(status.spread_bps)
            if status.spread_bps is not None
            else None,
            "max_spread_bps": str(settings.trading_signal_max_executable_spread_bps),
            "max_quote_age_seconds": settings.trading_executable_quote_lookback_seconds,
            "bid": str(status.bid) if status.bid is not None else None,
            "ask": str(status.ask) if status.ask is not None else None,
            "price": str(status.price) if status.price is not None else None,
            "capability": "executable_bid_ask",
            "fillability_state": status.fillability_state,
            "repair_action": status.repair_action,
            "operator_next_action": status.operator_next_action,
            "bounded_evidence_collection_ready": status.valid,
            "bounded_evidence_collection_action": (
                "allow_bounded_collection"
                if status.valid
                else status.operator_next_action or "refresh_source_snapshot"
            ),
            "promotion_allowed": False,
            "final_authority_ok": False,
            "final_promotion_allowed": False,
            "readiness": {
                "schema_version": "torghut.paper-route-fillability-readiness.v1",
                "state": "ready" if status.valid else "blocked",
                "blockers": blockers,
                "next_operator_action": status.operator_next_action,
                "repair_action": status.repair_action,
                "evidence_requirements": list(status.evidence_requirements),
                "promotion_allowed": False,
                "final_authority_ok": False,
            },
            "target_plan_source_mismatch": dict(request.target_mismatch)
            if request.target_mismatch is not None
            else None,
            "quote_lookup_diagnostics": dict(request.quote_lookup_diagnostics)
            if isinstance(request.quote_lookup_diagnostics, Mapping)
            else None,
        }

    @staticmethod
    def _paper_route_quote_routeability_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        retry_state = SimplePipelineSubmissionQuoteRouteabilityMixin._quote_routeability_retry_state(
            decision_row
        )
        if retry_state is None:
            return None
        decision_json, routeability, reason = retry_state
        retry_attempts = safe_int(
            decision_json.get("paper_route_quote_routeability_retry_attempts")
        )
        if not SimplePipelineSubmissionQuoteRouteabilityMixin._quote_retry_allowed(
            retry_attempts
        ):
            return None
        return {
            "previous_decision_status": "rejected",
            "previous_submission_stage": "rejected_quote_routeability",
            "previous_quote_routeability_reason": reason,
            "previous_quote_routeability": dict(routeability),
            "previous_retry_attempts": retry_attempts,
        }

    @staticmethod
    def paper_route_quote_routeability_retry_metadata(
        decision_row: TradeDecision,
    ) -> dict[str, object] | None:
        return SimplePipelineSubmissionQuoteRouteabilityMixin._paper_route_quote_routeability_retry_metadata(
            decision_row
        )

    @staticmethod
    def _quote_routeability_retry_state(
        decision_row: TradeDecision,
    ) -> tuple[Mapping[str, Any], Mapping[str, Any], str] | None:
        retry_state: tuple[Mapping[str, Any], Mapping[str, Any], str] | None = None
        decision_json_raw = decision_row.decision_json
        if decision_row.status == "rejected" and isinstance(
            decision_json_raw,
            Mapping,
        ):
            decision_json = cast(Mapping[str, Any], decision_json_raw)
            params = mapping_value(decision_json.get("params"))
            if (
                params is not None
                and SimplePipelineSubmissionQuoteRouteabilityMixin._has_retryable_quote_scope(
                    params
                )
            ):
                retry_state = SimplePipelineSubmissionQuoteRouteabilityMixin._routeability_retry_reason(
                    decision_json,
                    params,
                )
        return retry_state

    @staticmethod
    def _has_retryable_quote_scope(params: Mapping[str, Any]) -> bool:
        return (
            isinstance(params.get("paper_route_target_plan_source_decision"), Mapping)
            or isinstance(params.get("paper_route_target_plan"), Mapping)
            or isinstance(params.get("paper_route_probe"), Mapping)
        )

    @staticmethod
    def _routeability_retry_reason(
        decision_json: Mapping[str, Any],
        params: Mapping[str, Any],
    ) -> tuple[Mapping[str, Any], Mapping[str, Any], str] | None:
        routeability = mapping_value(params.get("quote_routeability"))
        retryable_reasons = {
            "absent_snapshot_fallback",
            "missing_executable_quote",
            "missing_bid",
            "missing_ask",
            "non_positive_price",
            "non_positive_bid",
            "non_positive_ask",
            "crossed_quote",
            "stale_quote",
            "spread_bps_exceeded",
            "wide_spread_midpoint_jump",
        }
        if routeability is None or safe_text(routeability.get("status")) != "blocked":
            return None
        reason = safe_text(routeability.get("reason"))
        if reason not in retryable_reasons:
            return None
        return decision_json, routeability, reason

    @staticmethod
    def _quote_retry_allowed(retry_attempts: int) -> bool:
        retry_limit = max(
            safe_int(settings.trading_simple_paper_route_probe_retry_attempt_limit),
            0,
        )
        return retry_limit > 0 and retry_attempts < retry_limit

    def _reopen_rejected_paper_route_quote_routeability_decision(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
    ) -> TradeDecision | None:
        retry_transition = self._paper_route_retry_transition(
            decision_row,
            allowed_kinds=frozenset({"quote_routeability"}),
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
        retry_attempts = safe_int(
            decision_json.get("paper_route_quote_routeability_retry_attempts")
        )
        params_mapping = mapping_value(decision_json.get("params"))
        params = dict(params_mapping) if params_mapping is not None else {}
        params.pop("quote_routeability", None)
        decision_json["params"] = params
        decision_json["submission_stage"] = (
            "paper_route_quote_routeability_retry_pending"
        )
        decision_json["paper_route_quote_routeability_retry_attempts"] = (
            retry_attempts + 1
        )
        decision_json["paper_route_quote_routeability_retry"] = {
            **retry_metadata,
            "submission_stage": "paper_route_quote_routeability_retry_pending",
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
            "Reopening paper route target source decision after transient quote routeability failure strategy_id=%s decision_id=%s symbol=%s previous_reason=%s",
            decision.strategy_id,
            decision_row.id,
            decision.symbol,
            retry_metadata["previous_quote_routeability_reason"],
        )
        return decision_row

    def _prepare_decision_for_submission(
        self,
        request: SubmissionPreparationRequest | None = None,
        **legacy_kwargs: Any,
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        request = self._submission_preparation_request(request, legacy_kwargs)
        decision = self._exit_window_guarded_submission_decision(request)
        if decision is None:
            return None
        request = self._submission_request_with_decision(request, decision)
        priced = self._quote_routeable_submission_decision(request)
        if priced is None:
            return None
        decision, snapshot = priced
        request = self._submission_request_with_decision(request, decision)
        decision = self._target_sized_submission_decision(request)
        if decision is None:
            return None
        request = self._submission_request_with_decision(request, decision)
        decision = self._paper_route_probe_capped_submission_decision(request)
        request = self._submission_request_with_decision(request, decision)
        preparation = self._simple_lane_preparation(request)
        prepared_decision = self._prechecked_target_aligned_decision(preparation)
        return self._finalize_prepared_submission(
            request=request,
            preparation=preparation,
            prepared_decision=prepared_decision,
            snapshot=snapshot,
        )

    @staticmethod
    def _submission_preparation_request(
        request: SubmissionPreparationRequest | None,
        legacy_kwargs: Mapping[str, Any],
    ) -> SubmissionPreparationRequest:
        if request is not None:
            return request
        if "context" in legacy_kwargs:
            context = legacy_kwargs["context"]
            return SubmissionPreparationRequest(
                session=context.session,
                decision=legacy_kwargs["decision"],
                decision_row=context.decision_row,
                strategy=context.strategy,
                account=context.account,
                positions=context.positions,
            )
        return SubmissionPreparationRequest(
            session=legacy_kwargs["session"],
            decision=legacy_kwargs["decision"],
            decision_row=legacy_kwargs["decision_row"],
            strategy=legacy_kwargs["strategy"],
            account=legacy_kwargs["account"],
            positions=legacy_kwargs["positions"],
        )

    @staticmethod
    def _submission_request_with_decision(
        request: SubmissionPreparationRequest,
        decision: StrategyDecision,
    ) -> SubmissionPreparationRequest:
        return SubmissionPreparationRequest(
            session=request.session,
            decision=decision,
            decision_row=request.decision_row,
            strategy=request.strategy,
            account=request.account,
            positions=request.positions,
        )

    def _exit_window_guarded_submission_decision(
        self,
        request: SubmissionPreparationRequest,
    ) -> StrategyDecision | None:
        decision, bounded_exit_window_reject_reason = (
            self._bounded_collection_exit_window_guarded_decision(request.decision)
        )
        if bounded_exit_window_reject_reason is None:
            return decision
        self.executor.update_decision_params(
            request.session,
            request.decision_row,
            decision.params,
        )
        self.executor.sync_decision_state(
            request.session, request.decision_row, decision
        )
        self._record_decision_rejection(
            session=request.session,
            decision=decision,
            decision_row=request.decision_row,
            reasons=[bounded_exit_window_reject_reason],
            log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
        )
        return None

    def _quote_routeable_submission_decision(
        self,
        request: SubmissionPreparationRequest,
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        decision, snapshot = self._ensure_decision_price(
            request.decision,
            signal_price=request.decision.params.get("price"),
        )
        if self._paper_route_decision_requires_executable_quote(decision):
            quote_status, routeability = self._paper_route_quote_routeability(
                decision,
                snapshot,
            )
            params_update = dict(decision.params)
            params_update["quote_routeability"] = routeability
            decision = decision.model_copy(update={"params": params_update})
            self.executor.update_decision_params(
                request.session,
                request.decision_row,
                params_update,
            )
            if not quote_status.valid:
                reason = quote_status.reason or "missing_executable_quote"
                self._record_decision_rejection(
                    session=request.session,
                    decision=decision,
                    decision_row=request.decision_row,
                    reasons=[reason],
                    log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
                )
                return None
        return decision, snapshot

    def _target_sized_submission_decision(
        self,
        request: SubmissionPreparationRequest,
    ) -> StrategyDecision | None:
        decision, bounded_target_sizing_reject_reason = (
            self._bounded_collection_target_notional_sized_decision(
                decision=request.decision,
                strategy=request.strategy,
                positions=request.positions,
            )
        )
        self.executor.update_decision_params(
            request.session,
            request.decision_row,
            decision.params,
        )
        self.executor.sync_decision_state(
            request.session, request.decision_row, decision
        )
        if bounded_target_sizing_reject_reason is not None:
            self._record_decision_rejection(
                session=request.session,
                decision=decision,
                decision_row=request.decision_row,
                reasons=[bounded_target_sizing_reject_reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        return decision

    def _paper_route_probe_capped_submission_decision(
        self,
        request: SubmissionPreparationRequest,
    ) -> StrategyDecision:
        decision = request.decision
        proof_floor = self._profitability_proof_floor(session=request.session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        if (
            proof_floor_block_reason is not None
            and settings.trading_mode == "paper"
            and self._paper_route_probe_exit_metadata(decision) is None
            and paper_route_probe_entry_metadata(decision.params) is None
        ):
            probe_context = self._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
                strategy=request.strategy,
                session=request.session,
                strategies=[request.strategy],
            )
            capped_decision = self._paper_route_probe_capped_decision(
                decision=decision,
                proof_floor=proof_floor,
                context=probe_context or {},
            )
            if capped_decision is not None:
                return capped_decision
        return decision

    def _simple_lane_preparation(
        self,
        request: SubmissionPreparationRequest,
    ) -> Any:
        max_notional_per_order = min_optional_decimal(
            optional_decimal(settings.trading_simple_max_notional_per_order),
            optional_decimal(settings.trading_max_notional_per_trade),
            optional_decimal(request.strategy.max_notional_per_trade),
        )
        equity = optional_decimal(request.account.get("equity"))
        max_notional_per_symbol = min_optional_decimal(
            optional_decimal(settings.trading_simple_max_notional_per_symbol),
            optional_decimal(settings.trading_allocator_max_symbol_notional),
            pct_cap_to_notional(
                equity=equity,
                pct=optional_decimal(settings.trading_max_position_pct_equity),
            ),
            pct_cap_to_notional(
                equity=equity,
                pct=optional_decimal(request.strategy.max_position_pct_equity),
            ),
        )
        return prepare_simple_decision(
            decision=request.decision,
            account=request.account,
            positions=request.positions,
            fractional_equities_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            max_notional_per_order=max_notional_per_order,
            max_notional_per_symbol=max_notional_per_symbol,
            buying_power_reserve_bps=optional_decimal(
                settings.trading_simple_buying_power_reserve_bps
            )
            or Decimal("0"),
            max_order_pct_equity=optional_decimal(
                settings.trading_simple_max_order_pct_equity
            ),
            max_gross_exposure_pct_equity=optional_decimal(
                settings.trading_simple_max_gross_exposure_pct_equity
            ),
            require_equity_for_exposure_increase=(
                settings.trading_simple_submit_enabled
                or settings.trading_simple_paper_route_probe_enabled
            ),
        )

    def _prechecked_target_aligned_decision(self, preparation: Any) -> StrategyDecision:
        target_notional_sizing = self._precheck_adjusted_target_notional_sizing(
            preparation
        )
        prepared_for_alignment = preparation.decision
        if target_notional_sizing is not None:
            prepared_action: Literal["buy", "sell"] = (
                "sell"
                if str(preparation.decision.action).strip().lower() == "sell"
                else "buy"
            )
            prepared_for_alignment = self._apply_bounded_collection_target_sizing_audit(
                preparation.decision,
                audit=target_notional_sizing,
                qty=preparation.decision.qty,
                action=prepared_action,
            )
        return self._align_prechecked_paper_route_probe_cap(prepared_for_alignment)

    @staticmethod
    def _precheck_adjusted_target_notional_sizing(
        preparation: Any,
    ) -> dict[str, Any] | None:
        target_notional_sizing = target_notional_sizing_audit_from_params(
            preparation.decision.params
        )
        expected_target_qty = (
            optional_decimal(target_notional_sizing.get("resolved_qty"))
            if target_notional_sizing is not None
            else None
        )
        if (
            target_notional_sizing is not None
            and expected_target_qty is not None
            and expected_target_qty > 0
            and preparation.approved
            and preparation.reject_reason is None
            and preparation.decision.qty != expected_target_qty
        ):
            adjusted_audit = dict(target_notional_sizing)
            adjusted_audit.setdefault(
                "target_notional_resolved_qty",
                adjusted_audit.get("resolved_qty"),
            )
            adjusted_audit.setdefault(
                "target_notional_resolved_notional",
                adjusted_audit.get("resolved_notional"),
            )
            adjusted_audit["precheck_quantity_adjusted"] = True
            adjusted_audit["precheck_adjustment_reason"] = (
                "risk_precheck_capped_quantity"
            )
            adjusted_audit["precheck_resolved_qty"] = str(preparation.decision.qty)
            adjusted_audit["precheck_expected_target_qty"] = str(expected_target_qty)
            reference_price = optional_decimal(adjusted_audit.get("reference_price"))
            if reference_price is not None:
                adjusted_audit["precheck_resolved_notional"] = str(
                    preparation.decision.qty * reference_price
                )
                adjusted_audit["precheck_expected_target_notional"] = str(
                    expected_target_qty * reference_price
                )
                adjusted_audit["resolved_notional"] = str(
                    preparation.decision.qty * reference_price
                )
            adjusted_audit["resolved_qty"] = str(preparation.decision.qty)
            simple_lane_precheck = mapping_value(
                preparation.decision.params.get("simple_lane")
            )
            if simple_lane_precheck is not None:
                for key in (
                    "capped_by_order",
                    "capped_by_symbol",
                    "capped_by_buying_power",
                ):
                    if key in simple_lane_precheck:
                        adjusted_audit[f"precheck_{key}"] = bool(
                            simple_lane_precheck.get(key)
                        )
            return adjusted_audit
        if target_notional_sizing is None:
            return None
        return dict(target_notional_sizing)

    def _finalize_prepared_submission(
        self,
        *,
        request: SubmissionPreparationRequest,
        preparation: Any,
        prepared_decision: StrategyDecision,
        snapshot: MarketSnapshot | None,
    ) -> tuple[StrategyDecision, Optional[MarketSnapshot]] | None:
        self.executor.sync_decision_state(
            request.session,
            request.decision_row,
            prepared_decision,
        )
        if preparation.diagnostics:
            params_update = dict(prepared_decision.params)
            params_update["simple_lane_precheck"] = preparation.diagnostics
            self.executor.update_decision_params(
                request.session,
                request.decision_row,
                params_update,
            )
        if not preparation.approved or preparation.reject_reason is not None:
            reason = preparation.reject_reason or "broker_precheck_failed"
            self._record_decision_rejection(
                session=request.session,
                decision=prepared_decision,
                decision_row=request.decision_row,
                reasons=[reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
            return None
        return prepared_decision, snapshot
