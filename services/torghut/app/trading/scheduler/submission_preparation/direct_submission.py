from __future__ import annotations

from collections.abc import Mapping
from datetime import timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast


from ....config import settings
from ...firewall import OrderFirewallBlocked
from ...models import StrategyDecision
from ...simple_risk import (
    position_qty_for_symbol,
)
from ..target_plan_helpers import (
    bounded_paper_route_collection_entry_metadata,
    bounded_sim_collection_metadata_from_decision,
    optional_decimal,
    paper_route_probe_entry_metadata,
    simple_buying_power_consumption,
    simple_decision_notional,
)


from ..pipeline.shared import TradingPipelineBase
from ..pipeline.contexts import (
    DecisionBlockRequest,
    DecisionRejectionRequest,
    LiveSubmissionGateInputs,
    RiskVerdictRequest as PipelineRiskVerdictRequest,
)
from ..pipeline.support import extract_json_error_payload

from .shared import (
    OrderSubmitRequest,
    RiskVerdictRequest as SimpleRiskVerdictRequest,
    SubmissionDecisionContext,
    SubmitRejectionRequest,
    TradingSubmissionRequest,
    logger,
)

_LIVE_GATE_BOUNDED_PAPER_ROUTE_BYPASS_REASONS = frozenset(
    {
        "alpha_readiness_not_promotion_eligible",
        "bounded_paper_route_evidence_collection_only",
        "hypothesis_window_evidence_missing",
        "live_runtime_ledger_required",
        "paper_probation_evidence_collection_only",
        "paper_route_runtime_ledger_import_pending",
        "promotion_certificate_missing",
        "runtime_ledger_profit_target_source_collection_pending",
        "runtime_ledger_source_collection_only",
        "runtime_ledger_source_collection_pending",
        "runtime_ledger_source_window_evidence_pending",
    }
)

_BOUNDED_PAPER_ROUTE_CLOSE_SOURCE = "filled_bounded_paper_route_collection_executions"

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from ....models import TradeDecision


class SimplePipelineDirectSubmissionMixin(TradingPipelineBase):
    def _passes_risk_verdict(
        self,
        request: SimpleRiskVerdictRequest | PipelineRiskVerdictRequest,
    ) -> bool:
        request = self._risk_verdict_request(request)
        _ = (
            request.context.strategy,
            request.context.account,
            request.symbol_allowlist,
            request.execution_advisor,
        )
        short_reason = self._simple_shortability_reason(
            decision=request.decision,
            positions=request.context.positions,
        )
        if short_reason is None:
            return True
        self._record_decision_rejection(
            DecisionRejectionRequest(
                session=request.context.session,
                decision=request.decision,
                decision_row=request.context.decision_row,
                reasons=[short_reason],
                log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
            )
        )
        return False

    def _is_trading_submission_allowed(
        self,
        *,
        session: Session | None = None,
        decision: StrategyDecision | None = None,
        decision_row: TradeDecision | None = None,
    ) -> bool:
        request = self._trading_submission_request(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )
        checks = (
            self._trading_enabled_submission_allowed,
            self._firewall_submission_allowed,
            self._live_mode_submission_allowed,
            self._profitability_floor_submission_allowed,
            self._profitability_floor_symbol_submission_allowed,
            self._emergency_stop_submission_allowed,
            self._paper_route_target_window_submission_allowed,
        )
        for check in checks:
            if not check(request):
                return False
        return True

    @staticmethod
    def _risk_verdict_request(
        request: SimpleRiskVerdictRequest | PipelineRiskVerdictRequest,
    ) -> SimpleRiskVerdictRequest:
        if isinstance(request, SimpleRiskVerdictRequest):
            return request
        context = request.context
        return SimpleRiskVerdictRequest(
            context=SubmissionDecisionContext(
                session=context.session,
                decision_row=context.decision_row,
                strategy=context.strategy,
                account=context.account,
                positions=context.positions,
            ),
            decision=request.decision,
            symbol_allowlist=context.symbol_allowlist,
            execution_advisor=request.execution_advisor,
        )

    @staticmethod
    def _trading_submission_request(
        *,
        session: Session | None,
        decision: StrategyDecision | None,
        decision_row: TradeDecision | None,
    ) -> TradingSubmissionRequest:
        if session is None or decision is None or decision_row is None:
            raise TypeError(
                "Trading submission checks require session, decision, and decision_row"
            )
        return TradingSubmissionRequest(
            session=session,
            decision=decision,
            decision_row=decision_row,
        )

    def _trading_enabled_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        if not settings.trading_enabled:
            self._block_decision_submission(
                DecisionBlockRequest(
                    session=request.session,
                    decision=request.decision,
                    decision_row=request.decision_row,
                    reason="trading_disabled",
                    submission_stage="blocked_trading_disabled",
                )
            )
            return False
        return True

    def _firewall_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        firewall_status = self.order_firewall.status()
        if firewall_status.kill_switch_enabled:
            self._record_decision_rejection(
                DecisionRejectionRequest(
                    session=request.session,
                    decision=request.decision,
                    decision_row=request.decision_row,
                    reasons=["kill_switch_enabled"],
                    log_template="Simple-lane decision rejected strategy_id=%s symbol=%s reason=%s",
                )
            )
            return False
        return True

    def _live_mode_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        if settings.trading_mode == "live":
            live_submission_gate = self._live_submission_gate(
                inputs=LiveSubmissionGateInputs(session=request.session)
            )
            if not bool(live_submission_gate.get("allowed", False)):
                if self._bounded_live_paper_route_probe_request_allowed(
                    request,
                    live_submission_gate,
                ):
                    return True
                self._block_decision_submission(
                    DecisionBlockRequest(
                        session=request.session,
                        decision=request.decision,
                        decision_row=request.decision_row,
                        reason=str(
                            live_submission_gate.get("reason")
                            or "live_submission_gate_blocked"
                        ),
                        submission_stage="blocked_live_submission_gate",
                        extra_metadata={"live_submission_gate": live_submission_gate},
                    )
                )
                return False
        return True

    def _bounded_live_paper_route_probe_request_allowed(
        self,
        request: TradingSubmissionRequest,
        live_submission_gate: Mapping[str, Any],
    ) -> bool:
        if self._bounded_live_paper_route_probe_submission_allowed(
            request.decision,
            live_submission_gate,
        ):
            return True
        close_metadata = self._bounded_live_paper_route_close_metadata(request)
        if close_metadata is None:
            return False
        if not self._bounded_live_paper_route_collection_gate_allows(
            live_submission_gate
        ):
            return False
        request.decision.params.update(close_metadata)
        self.executor.update_decision_params(
            request.session,
            request.decision_row,
            close_metadata,
        )
        return True

    def _bounded_live_paper_route_probe_submission_allowed(
        self,
        decision: StrategyDecision,
        live_submission_gate: Mapping[str, Any],
    ) -> bool:
        if not self._bounded_live_paper_route_probe_decision_applies(decision):
            return False
        return self._bounded_live_paper_route_collection_gate_allows(
            live_submission_gate
        )

    @staticmethod
    def _bounded_live_paper_route_collection_gate_allows(
        live_submission_gate: Mapping[str, Any],
    ) -> bool:
        collection_gate = live_submission_gate.get("bounded_live_paper_collection_gate")
        if isinstance(collection_gate, Mapping):
            collection_gate_mapping = cast(Mapping[str, Any], collection_gate)
            return collection_gate_mapping.get("allowed") is True
        blocked_reasons = {
            str(reason).strip()
            for reason in cast(
                list[object],
                live_submission_gate.get("blocked_reasons") or [],
            )
            if str(reason).strip()
        }
        if not blocked_reasons:
            return False
        return blocked_reasons.issubset(_LIVE_GATE_BOUNDED_PAPER_ROUTE_BYPASS_REASONS)

    def _bounded_live_paper_route_close_metadata(
        self,
        request: TradingSubmissionRequest,
    ) -> dict[str, Any] | None:
        if not self._bounded_live_paper_route_close_mode_enabled(request.decision):
            return None
        exposure = self._bounded_live_paper_route_close_exposure(request)
        if exposure is None:
            return None
        lineage = dict(cast(Mapping[str, Any], getattr(exposure, "lineage", {}) or {}))
        exit_metadata = {
            "mode": "paper_route_exit",
            "source": _BOUNDED_PAPER_ROUTE_CLOSE_SOURCE,
            "symbol": getattr(exposure, "symbol"),
            "strategy_id": str(getattr(getattr(exposure, "strategy"), "id")),
            "db_open_qty": str(getattr(exposure, "exit_qty")),
            "db_open_signed_qty": str(getattr(exposure, "net_qty")),
            "db_open_side": "long" if getattr(exposure, "net_qty") > 0 else "short",
            "exit_minute_after_open": getattr(exposure, "exit_minute_after_open", None),
            "session_open": getattr(exposure, "session_open").isoformat(),
            "latest_entry_at": (
                getattr(exposure, "latest_entry_at").isoformat()
                if getattr(exposure, "latest_entry_at", None) is not None
                else None
            ),
            "live_bounded_paper_route_close": True,
            **lineage,
        }
        simple_lane = request.decision.params.get("simple_lane")
        if isinstance(simple_lane, Mapping):
            simple_lane_payload = dict(cast(Mapping[str, Any], simple_lane))
        else:
            simple_lane_payload = {}
        simple_lane_payload.update(
            {
                "bounded_live_paper_route_close": True,
                "submit_path": "bounded_paper_route_collection",
            }
        )
        metadata: dict[str, Any] = {
            "paper_route_probe_exit": exit_metadata,
            "simple_lane": simple_lane_payload,
            "bounded_live_paper_route_close": True,
            "bounded_paper_route_submit_path": "bounded_paper_route_collection",
        }
        for key in ("source_decision_mode", "profit_proof_eligible"):
            if key in lineage:
                metadata[key] = lineage[key]
        return metadata

    def _bounded_live_paper_route_close_mode_enabled(
        self,
        decision: StrategyDecision,
    ) -> bool:
        return (
            settings.trading_mode == "live"
            and settings.trading_simple_submit_enabled
            and settings.trading_simple_paper_route_probe_enabled
            and settings.trading_simple_paper_route_probe_allow_live_mode
            and self._paper_route_probe_exit_metadata(decision) is None
            and bounded_paper_route_collection_entry_metadata(decision.params) is None
            and decision.action in {"buy", "sell"}
            and decision.qty > 0
        )

    def _bounded_live_paper_route_close_exposure(
        self,
        request: TradingSubmissionRequest,
    ) -> Any | None:
        exposures_fn = getattr(self, "_paper_route_probe_exit_exposures", None)
        if not callable(exposures_fn):
            return None
        try:
            exposures = exposures_fn(
                session=request.session,
                now=self._trading_now().astimezone(timezone.utc),
            )
        except Exception:
            logger.exception(
                "Failed to inspect bounded paper-route close exposure "
                "decision_id=%s symbol=%s",
                request.decision_row.id,
                request.decision.symbol,
            )
            return None
        if not isinstance(exposures, Mapping):
            return None
        exposure_mapping = cast(Mapping[Any, Any], exposures)
        for exposure in exposure_mapping.values():
            if not self._bounded_live_paper_route_close_matches_exposure(
                request.decision,
                exposure,
            ):
                continue
            return exposure
        return None

    @staticmethod
    def _bounded_live_paper_route_close_matches_exposure(
        decision: StrategyDecision,
        exposure: Any,
    ) -> bool:
        strategy = getattr(exposure, "strategy", None)
        if str(getattr(strategy, "id", "")).strip() != str(decision.strategy_id):
            return False
        if str(getattr(exposure, "symbol", "")).strip().upper() != decision.symbol:
            return False
        if str(getattr(exposure, "exit_source", "") or "").strip() != (
            _BOUNDED_PAPER_ROUTE_CLOSE_SOURCE
        ):
            return False
        if getattr(exposure, "exit_action", None) != decision.action:
            return False
        exit_qty = getattr(exposure, "exit_qty", Decimal("0"))
        if not isinstance(exit_qty, Decimal):
            exit_qty = Decimal(str(exit_qty))
        return decision.qty <= exit_qty

    def _bounded_live_paper_route_probe_profit_floor_allowed(
        self,
        decision: StrategyDecision,
        proof_floor_block_reason: str,
    ) -> bool:
        return (
            self._bounded_live_paper_route_probe_decision_applies(decision)
            and proof_floor_block_reason
            in _LIVE_GATE_BOUNDED_PAPER_ROUTE_BYPASS_REASONS
        )

    def _profitability_floor_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        decision = request.decision
        session = request.session
        decision_row = request.decision_row
        proof_floor = self._profitability_proof_floor(session=session)
        proof_floor_block_reason = self._proof_floor_submission_block_reason(
            proof_floor
        )
        if proof_floor_block_reason is None:
            return True
        collection_metadata = self._bounded_sim_collection_metadata(decision)
        if not settings.trading_simple_submit_enabled and collection_metadata is None:
            self._block_simple_submit_disabled(request, proof_floor_block_reason)
            return False
        if self._paper_route_probe_applies(
            decision, collection_metadata
        ) or self._bounded_live_paper_route_probe_profit_floor_allowed(
            decision, proof_floor_block_reason
        ):
            return True
        self._block_decision_submission(
            DecisionBlockRequest(
                session=session,
                decision=decision,
                decision_row=decision_row,
                reason=proof_floor_block_reason,
                submission_stage="blocked_profitability_proof_floor",
                capital_stage=str(proof_floor.get("capital_state") or "zero_notional"),
                extra_metadata={"profitability_proof_floor": dict(proof_floor)},
            )
        )
        return False

    def _profitability_floor_symbol_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        decision = request.decision
        collection_metadata = self._bounded_sim_collection_metadata(decision)
        if self._paper_route_probe_applies(decision, collection_metadata):
            return True
        proof_floor = self._profitability_proof_floor(session=request.session)
        proof_floor_symbol_block_reason = self._proof_floor_symbol_block_reason(
            proof_floor,
            decision.symbol,
        )
        if proof_floor_symbol_block_reason is not None:
            if self._bounded_live_paper_route_probe_profit_floor_allowed(
                decision,
                proof_floor_symbol_block_reason,
            ):
                return True
            self._block_decision_submission(
                DecisionBlockRequest(
                    session=request.session,
                    decision=decision,
                    decision_row=request.decision_row,
                    reason=proof_floor_symbol_block_reason,
                    submission_stage="blocked_profitability_route_symbol",
                    capital_stage=str(
                        proof_floor.get("capital_state") or "zero_notional"
                    ),
                    extra_metadata={"profitability_proof_floor": dict(proof_floor)},
                )
            )
            return False
        return True

    def _emergency_stop_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        if settings.trading_emergency_stop_enabled and self.state.emergency_stop_active:
            self._block_decision_submission(
                DecisionBlockRequest(
                    session=request.session,
                    decision=request.decision,
                    decision_row=request.decision_row,
                    reason=self.state.emergency_stop_reason or "emergency_stop_active",
                    submission_stage="blocked_emergency_stop",
                )
            )
            return False
        return True

    def _paper_route_target_window_submission_allowed(
        self,
        request: TradingSubmissionRequest,
    ) -> bool:
        decision = request.decision
        active_target_window = self._active_bounded_paper_route_target_window(
            request.decision
        )
        if active_target_window is not None:
            collection_metadata = self._bounded_sim_collection_metadata(decision)
            exit_metadata = self._paper_route_probe_exit_metadata(decision)
            if collection_metadata is None and exit_metadata is None:
                self._block_decision_submission(
                    DecisionBlockRequest(
                        session=request.session,
                        decision=decision,
                        decision_row=request.decision_row,
                        reason="paper_route_target_window_requires_scoped_source_decision",
                        submission_stage="blocked_paper_route_target_window_unscoped",
                        capital_stage="shadow",
                        extra_metadata={
                            "paper_route_target_window": active_target_window,
                            "simple_lane": {
                                "submit_enabled": settings.trading_simple_submit_enabled,
                                "bounded_sim_collection_required": True,
                                "bounded_sim_collection_bypass": False,
                            },
                        },
                    )
                )
                return False
        return True

    def _block_simple_submit_disabled(
        self,
        request: TradingSubmissionRequest,
        proof_floor_block_reason: str,
    ) -> None:
        self._block_decision_submission(
            DecisionBlockRequest(
                session=request.session,
                decision=request.decision,
                decision_row=request.decision_row,
                reason="simple_submit_disabled",
                submission_stage="blocked_simple_submit_disabled",
                capital_stage="shadow",
                extra_metadata={
                    "simple_lane": {
                        "submit_enabled": False,
                        "bounded_sim_collection_bypass": False,
                        "bounded_sim_collection_required": True,
                        "proof_floor_block_reason": proof_floor_block_reason,
                    }
                },
            )
        )

    def _bounded_sim_collection_metadata(
        self,
        decision: StrategyDecision,
    ) -> Mapping[str, Any] | None:
        return bounded_sim_collection_metadata_from_decision(
            decision,
            account_label=self.account_label,
            trading_mode=settings.trading_mode,
        )

    def _paper_route_probe_applies(
        self,
        decision: StrategyDecision,
        collection_metadata: Mapping[str, Any] | None,
    ) -> bool:
        return settings.trading_mode == "paper" and (
            self._paper_route_probe_exit_metadata(decision) is not None
            or paper_route_probe_entry_metadata(decision.params) is not None
            or collection_metadata is not None
        )

    def _bounded_live_paper_route_probe_decision_applies(
        self,
        decision: StrategyDecision,
    ) -> bool:
        return (
            settings.trading_mode == "live"
            and settings.trading_simple_submit_enabled
            and settings.trading_simple_paper_route_probe_enabled
            and settings.trading_simple_paper_route_probe_allow_live_mode
            and (
                self._paper_route_probe_exit_metadata(decision) is not None
                or paper_route_probe_entry_metadata(decision.params) is not None
                or bounded_paper_route_collection_entry_metadata(decision.params)
                is not None
            )
        )

    def _execution_client_for_symbol(
        self, symbol: str, *, symbol_allowlist: set[str] | None = None
    ) -> Any:
        _ = (symbol, symbol_allowlist)
        return self.execution_adapter

    def _submit_order_with_handling(
        self,
        request: OrderSubmitRequest,
    ) -> tuple[Any | None, bool]:
        try:
            retry_delays_seconds = [float(delay) for delay in request.retry_delays]
            execution = self.executor.submit_order(
                request.session,
                request.execution_client,
                request.decision,
                request.decision_row,
                self.account_label,
                execution_expected_adapter=request.selected_adapter_name,
                retry_delays=retry_delays_seconds,
            )
            return execution, False
        except OrderFirewallBlocked:
            return self._reject_submit(
                SubmitRejectionRequest(
                    session=request.session,
                    decision=request.decision,
                    decision_row=request.decision_row,
                    selected_adapter_name=request.selected_adapter_name,
                    reason="kill_switch_enabled",
                    rejection_type="firewall_blocked",
                )
            )
        except Exception as exc:
            payload = extract_json_error_payload(exc) or {}
            reason = self._map_submit_exception(payload)
            metadata = {"broker_precheck": payload} if payload else None
            return self._reject_submit(
                SubmitRejectionRequest(
                    session=request.session,
                    decision=request.decision,
                    decision_row=request.decision_row,
                    selected_adapter_name=request.selected_adapter_name,
                    reason=reason,
                    rejection_type="submit_failed",
                    metadata=metadata,
                )
            )

    def _reject_submit(
        self,
        request: SubmitRejectionRequest,
    ) -> tuple[None, bool]:
        self.state.metrics.orders_rejected_total += 1
        self.state.metrics.record_decision_state("rejected")
        self.state.metrics.record_decision_rejection_reasons([request.reason])
        self.state.metrics.record_execution_submit_result(
            status="rejected",
            adapter=request.selected_adapter_name,
        )
        self.executor.mark_rejected(
            request.session,
            request.decision_row,
            request.reason,
            metadata_update=self._decision_lifecycle_metadata(
                submission_stage="rejected_submit",
                extra=request.metadata,
            ),
        )
        self._emit_domain_telemetry(
            event_name="torghut.execution.rejected",
            severity="warning",
            decision=request.decision,
            decision_row=request.decision_row,
            reason_codes=[request.reason],
            extra_properties={"rejection_type": request.rejection_type},
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
        if not self._sell_order_needs_shortability(decision, positions):
            return None
        if not settings.trading_allow_shorts:
            return "shorting_not_allowed_for_asset"
        return self._account_or_asset_shortability_reason(decision.symbol)

    @staticmethod
    def _sell_order_needs_shortability(
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
    ) -> bool:
        if decision.action != "sell":
            return False
        current_qty = position_qty_for_symbol(positions, decision.symbol)
        return not (current_qty > 0 and decision.qty <= current_qty)

    def _account_or_asset_shortability_reason(self, symbol: str) -> str | None:
        account = self.order_firewall.get_account()
        if account is not None:
            shorting_enabled = account.get("shorting_enabled")
            if isinstance(shorting_enabled, bool) and not shorting_enabled:
                return "shorting_not_allowed_for_asset"
        elif settings.trading_mode == "live":
            return "shorting_not_allowed_for_asset"

        asset = self.order_firewall.get_asset(symbol)
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
        buying_power = optional_decimal(account.get("buying_power"))
        if buying_power is None:
            return
        notional = simple_decision_notional(decision)
        if notional is None or notional <= 0:
            return
        consumed = simple_buying_power_consumption(
            positions=positions,
            decision=decision,
            notional=notional,
        )
        if consumed <= 0:
            return
        account["buying_power"] = str(max(buying_power - consumed, Decimal("0")))
