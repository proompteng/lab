"""Trading pipeline implementation."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy.orm import Session

from ....config import settings
from ....models import (
    LLMDecisionReview,
    TradeDecision,
    coerce_json_payload,
)
from ....snapshots import snapshot_account_and_positions
from ...llm.dspy_programs.runtime import (
    DSPyRuntimeUnsupportedStateError,
)
from ...llm.policy import allowed_order_types
from ...llm.schema import MarketContextBundle
from ...llm.schema import MarketSnapshot as LLMMarketSnapshot
from ...market_context import (
    MarketContextStatus,
    evaluate_market_context,
    market_context_enforced,
)
from ...market_context_domains import (
    active_market_context_domain_states,
    active_market_context_reasons,
)
from ...models import SignalEnvelope, StrategyDecision
from ...prices import MarketSnapshot
from ...time_source import trading_now
from ..pipeline_helpers import build_llm_policy_resolution

from .contexts import (
    LLMReviewErrorRequest,
    LLMReviewRecord,
    LLMUnavailableRequest,
    MarketContextBlockRequest,
)
from .shared import TradingPipelineBase
from .support import (
    attach_dspy_lineage,
    build_committee_veto_alignment_payload,
    build_portfolio_snapshot,
    classify_llm_error,
    coerce_json,
    committee_trace_has_veto,
    hash_payload,
    llm_guardrail_controls_snapshot,
    load_recent_decisions,
    normalize_rollout_stage,
    optional_decimal,
    optional_int,
    price_snapshot_payload,
    resolve_llm_review_error_reject_reason,
    resolve_llm_unavailable_reject_reason,
)

logger = logging.getLogger(__name__)


class TradingPipelineReviewOutcomeMixin(TradingPipelineBase):
    def _maybe_handle_market_context_block(
        self,
        request: MarketContextBlockRequest,
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        market_context = request.market_context
        market_context_status = evaluate_market_context(market_context)
        if request.market_context_error is not None:
            market_context_status = MarketContextStatus(
                allow_llm=not market_context_enforced(),
                reason="market_context_fetch_error",
                risk_flags=["market_context_fetch_error"],
            )
        if market_context_status.allow_llm:
            return None

        self.state.metrics.llm_market_context_block_total += 1
        market_context_shadow_mode = (
            request.guardrails.shadow_mode
            or settings.trading_market_context_fail_mode == "shadow_only"
        )
        self.state.metrics.record_market_context_result(
            market_context_status.reason,
            shadow_mode=market_context_shadow_mode,
        )
        return self._handle_llm_unavailable(
            LLMUnavailableRequest(
                context=request.context,
                decision=request.decision,
                reason=market_context_status.reason or "market_context_unavailable",
                reject_reason="market_context_block",
                shadow_mode=market_context_shadow_mode,
                effective_fail_mode=request.guardrails.effective_fail_mode,
                risk_flags=market_context_status.risk_flags,
                market_context=market_context,
                response_payload_extra={
                    "market_context": {
                        "reason": market_context_status.reason,
                        "risk_flags": list(market_context_status.risk_flags),
                    }
                },
                policy_resolution=request.policy_resolution,
            )
        )

    def _record_market_context_observation(
        self,
        *,
        symbol: str,
        market_context: Optional[MarketContextBundle],
        market_context_error: Optional[str],
    ) -> None:
        now = trading_now(account_label=self.account_label)
        self.state.last_market_context_symbol = symbol
        self.state.last_market_context_checked_at = now
        self.state.last_market_context_fetch_error = market_context_error
        if market_context is None:
            self.state.last_market_context_as_of = None
            self.state.last_market_context_freshness_seconds = None
            self.state.last_market_context_quality_score = None
            self.state.last_market_context_domain_states = {}
            self.state.last_market_context_risk_flags = []
            enforce_market_context = market_context_enforced()
            allow_llm = not enforce_market_context
            reason = market_context_error or (
                "market_context_required_missing" if enforce_market_context else None
            )
            self.state.last_market_context_allow_llm = allow_llm
            self.state.last_market_context_reason = reason
            self.state.market_context_alert_active = enforce_market_context and (
                market_context_error is not None or not allow_llm
            )
            self.state.market_context_alert_reason = reason
            return

        market_context_status = evaluate_market_context(market_context)
        as_of = market_context.as_of_utc
        self.state.last_market_context_as_of = as_of
        self.state.last_market_context_freshness_seconds = int(
            market_context.freshness_seconds
        )
        self.state.last_market_context_quality_score = float(
            market_context.quality_score
        )
        self.state.last_market_context_domain_states = (
            active_market_context_domain_states(market_context)
        )
        self.state.last_market_context_risk_flags = active_market_context_reasons(
            market_context.risk_flags
        )
        self.state.last_market_context_allow_llm = market_context_status.allow_llm
        self.state.last_market_context_reason = (
            market_context_error or market_context_status.reason
        )
        enforce_market_context = market_context_enforced()
        self.state.market_context_alert_active = enforce_market_context and (
            market_context_error is not None or not market_context_status.allow_llm
        )
        self.state.market_context_alert_reason = (
            market_context_error or market_context_status.reason
        )

    def _record_llm_verdict_counter(self, verdict: str) -> None:
        if verdict == "abstain":
            self.state.metrics.llm_abstain_total += 1
            return
        if verdict == "escalate":
            self.state.metrics.llm_escalate_total += 1

    def _build_llm_response_json(
        self,
        *,
        outcome: Any,
        policy_outcome: Any,
        guardrails: Any,
        policy_resolution: dict[str, Any],
    ) -> dict[str, Any]:
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
        response_json["guardrail_controls"] = llm_guardrail_controls_snapshot()
        committee_veto = committee_trace_has_veto(response_json)
        response_json["committee_veto_alignment"] = (
            build_committee_veto_alignment_payload(
                committee_veto=committee_veto,
                deterministic_veto=policy_outcome.verdict == "veto",
            )
        )
        attach_dspy_lineage(
            response_json,
            artifact_source="runtime_review",
        )
        return response_json

    def _record_llm_committee_metrics(self, response_json: Mapping[str, Any]) -> None:
        committee_payload = response_json.get("committee")
        if not isinstance(committee_payload, Mapping):
            return
        committee_roles = cast(Mapping[str, Any], committee_payload).get("roles", {})
        if not isinstance(committee_roles, Mapping):
            return
        for role, role_payload in cast(Mapping[str, Any], committee_roles).items():
            if not isinstance(role_payload, Mapping):
                continue
            role_data = cast(Mapping[str, Any], role_payload)
            self.state.metrics.record_llm_committee_member(
                role=str(role),
                verdict=str(role_data.get("verdict", "unknown")),
                latency_ms=optional_int(role_data.get("latency_ms")),
                schema_error=bool(role_data.get("schema_error", False)),
            )

    def _record_llm_token_metrics(self, outcome: Any) -> None:
        if outcome.tokens_prompt is not None:
            self.state.metrics.llm_tokens_prompt_total += outcome.tokens_prompt
        if outcome.tokens_completion is not None:
            self.state.metrics.llm_tokens_completion_total += outcome.tokens_completion

    def _apply_llm_policy_verdict(
        self,
        *,
        session: Session,
        decision_row: TradeDecision,
        policy_outcome: Any,
    ) -> tuple[Optional[Decimal], Optional[str]]:
        if policy_outcome.verdict == "adjust":
            self.state.metrics.llm_adjust_total += 1
            adjusted_qty = Decimal(str(policy_outcome.decision.qty))
            adjusted_order_type = policy_outcome.decision.order_type
            self._persist_llm_adjusted_decision(
                session, decision_row, policy_outcome.decision
            )
            return adjusted_qty, adjusted_order_type
        if policy_outcome.verdict == "approve":
            self.state.metrics.llm_approve_total += 1
            return None, None
        if policy_outcome.verdict == "veto":
            self.state.metrics.llm_veto_total += 1
            if policy_outcome.reason == "llm_policy_veto":
                self.state.metrics.llm_policy_veto_total += 1
        return None, None

    def _finalize_llm_review_outcome(
        self,
        *,
        decision: StrategyDecision,
        outcome: Any,
        policy_outcome: Any,
        guardrails: Any,
    ) -> tuple[StrategyDecision, Optional[str]]:
        committee_veto = committee_trace_has_veto(outcome.response_json)
        if committee_veto:
            self.state.metrics.record_llm_committee_veto_alignment(
                committee_veto=True,
                deterministic_veto=policy_outcome.verdict == "veto",
            )
        if guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if policy_outcome.verdict != "veto":
            return policy_outcome.decision, None
        return decision, policy_outcome.reason or "llm_policy_veto"

    def _handle_llm_review_error(
        self,
        request: LLMReviewErrorRequest,
    ) -> tuple[StrategyDecision, Optional[str]]:
        decision = request.decision
        request_json = request.request_json
        policy_resolution = request.policy_resolution
        self.state.metrics.llm_error_total += 1
        unsupported_state_error = isinstance(
            request.error, DSPyRuntimeUnsupportedStateError
        )
        if not unsupported_state_error:
            request.engine.circuit_breaker.record_error()
        if unsupported_state_error:
            policy_resolution = build_llm_policy_resolution(
                rollout_stage=request.guardrails.rollout_stage,
                effective_fail_mode="veto",
                guardrail_reasons=request.guardrails.reasons,
            )
        error_label = classify_llm_error(request.error)
        if error_label == "llm_response_not_json":
            self.state.metrics.llm_parse_error_total += 1
        elif error_label == "llm_response_invalid":
            self.state.metrics.llm_validation_error_total += 1

        fallback = (
            "veto"
            if unsupported_state_error
            else self._resolve_llm_fallback(request.guardrails.effective_fail_mode)
        )
        effective_verdict = "veto" if fallback == "veto" else "approve"
        if not request_json:
            request_json = {"decision": decision.model_dump(mode="json")}
        response_json: dict[str, Any] = {
            "error": str(request.error),
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "policy_resolution": policy_resolution,
            "guardrail_controls": llm_guardrail_controls_snapshot(),
            "advisory_only": True,
        }
        if request.guardrails.reasons:
            response_json["mrm_guardrails"] = list(request.guardrails.reasons)
        response_json["request_hash"] = hash_payload(request_json)
        response_json["response_hash"] = hash_payload(response_json)
        self._persist_llm_review(
            LLMReviewRecord(
                session=request.context.session,
                decision_row=request.context.decision_row,
                model=self._llm_runtime_model_identifier(),
                prompt_version=self._llm_runtime_prompt_identifier(),
                request_json=request_json,
                response_json=response_json,
                verdict="error",
                confidence=None,
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale=f"llm_error_{fallback}",
                risk_flags=[type(request.error).__name__]
                + list(request.guardrails.reasons),
                tokens_prompt=None,
                tokens_completion=None,
            )
        )
        if unsupported_state_error:
            logger.warning(
                "Unsupported DSPy runtime state; vetoing decision_id=%s error=%s",
                request.context.decision_row.id,
                request.error,
            )
            return decision, "llm_unavailable_dspy_runtime_unsupported_state"
        if request.guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            logger.warning(
                "LLM review failed; vetoing decision_id=%s error=%s",
                request.context.decision_row.id,
                request.error,
            )
            return decision, resolve_llm_review_error_reject_reason(request.error)
        logger.warning(
            "LLM review failed; pass-through decision_id=%s error=%s",
            request.context.decision_row.id,
            request.error,
        )
        return decision, None

    def _handle_llm_unavailable(
        self,
        request: LLMUnavailableRequest,
    ) -> tuple[StrategyDecision, Optional[str]]:
        context = request.context
        decision = request.decision
        fallback = self._resolve_llm_fallback(request.effective_fail_mode)
        effective_verdict = "veto" if fallback == "veto" else "approve"
        reject_reason = (
            resolve_llm_unavailable_reject_reason(request.reason)
            if fallback == "veto" and not request.shadow_mode
            else None
        )
        self.state.metrics.record_llm_unavailable(
            reason=request.reason, reject_reason=reject_reason
        )
        portfolio_snapshot = build_portfolio_snapshot(
            context.account, context.positions
        )
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = load_recent_decisions(
            context.session,
            decision.strategy_id,
            decision.symbol,
        )
        if self.llm_review_engine is not None:
            request_payload = self.llm_review_engine.build_request(
                decision=decision,
                account=context.account,
                positions=context.positions,
                portfolio=portfolio_snapshot,
                market=market_snapshot,
                market_context=request.market_context,
                recent_decisions=recent_decisions,
            ).model_dump(mode="json")
        else:
            request_payload = {
                "decision": decision.model_dump(mode="json"),
                "portfolio": portfolio_snapshot.model_dump(mode="json"),
                "market": market_snapshot.model_dump(mode="json")
                if market_snapshot is not None
                else None,
                "market_context": request.market_context.model_dump(mode="json")
                if request.market_context is not None
                else None,
                "recent_decisions": [
                    summary.model_dump(mode="json") for summary in recent_decisions
                ],
                "account": context.account,
                "positions": context.positions,
                "policy": {
                    "adjustment_allowed": settings.llm_adjustment_allowed,
                    "min_qty_multiplier": str(settings.llm_min_qty_multiplier),
                    "max_qty_multiplier": str(settings.llm_max_qty_multiplier),
                    "allowed_order_types": sorted(
                        allowed_order_types(decision.order_type)
                    ),
                },
                "trading_mode": settings.trading_mode,
                "prompt_version": f"dspy:{settings.llm_dspy_signature_version}",
            }
        response_payload = {
            "error": request.reason,
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "reject_reason": reject_reason,
            "policy_resolution": request.policy_resolution
            or build_llm_policy_resolution(
                rollout_stage=normalize_rollout_stage(settings.llm_rollout_stage),
                effective_fail_mode=fallback,
                guardrail_reasons=request.risk_flags or [],
            ),
            "advisory_only": True,
        }
        if request.response_payload_extra:
            response_payload.update(request.response_payload_extra)
        decision_metadata_update: dict[str, Any] = {}
        if request.response_payload_extra:
            llm_runtime_payload = request.response_payload_extra.get("llm_runtime")
            if isinstance(llm_runtime_payload, Mapping):
                decision_metadata_update["llm_runtime"] = dict(
                    cast(Mapping[str, Any], llm_runtime_payload)
                )
            market_context_payload = request.response_payload_extra.get(
                "market_context"
            )
            if isinstance(market_context_payload, Mapping):
                decision_metadata_update["market_context"] = dict(
                    cast(Mapping[str, Any], market_context_payload)
                )
        if decision_metadata_update:
            self.executor.update_decision_json(
                context.session,
                context.decision_row,
                decision_metadata_update,
            )
        response_payload["request_hash"] = hash_payload(request_payload)
        response_payload["response_hash"] = hash_payload(response_payload)
        self._persist_llm_review(
            LLMReviewRecord(
                session=context.session,
                decision_row=context.decision_row,
                model=self._llm_runtime_model_identifier(),
                prompt_version=self._llm_runtime_prompt_identifier(),
                request_json=request_payload,
                response_json={
                    **response_payload,
                    "guardrail_controls": llm_guardrail_controls_snapshot(),
                },
                verdict="error",
                confidence=None,
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale=request.reason,
                risk_flags=[request.reason] + (request.risk_flags or []),
                tokens_prompt=None,
                tokens_completion=None,
            )
        )
        if request.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            return decision, reject_reason or "llm_unavailable_unknown"
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
                price=optional_decimal(price),
                spread=optional_decimal(spread),
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

    @staticmethod
    def _resolve_pre_llm_executability_reject(
        decision: StrategyDecision,
    ) -> Optional[str]:
        portfolio_sizing = decision.params.get("portfolio_sizing")
        if not isinstance(portfolio_sizing, Mapping):
            return None
        portfolio_sizing_mapping = cast(Mapping[str, Any], portfolio_sizing)
        output = portfolio_sizing_mapping.get("output")
        if not isinstance(output, Mapping):
            return None
        output_mapping = cast(Mapping[str, Any], output)

        limiting_constraint = str(
            output_mapping.get("limiting_constraint") or ""
        ).strip()
        caps = output_mapping.get("caps")
        per_symbol_cap = None
        if isinstance(caps, Mapping):
            per_symbol_cap = optional_decimal(
                cast(Mapping[str, Any], caps).get("per_symbol")
            )
        if limiting_constraint == "symbol_capacity_exhausted" or (
            per_symbol_cap is not None and per_symbol_cap <= 0
        ):
            return "symbol_capacity_exhausted"

        fractional_allowed = output_mapping.get("fractional_allowed")
        final_qty = optional_decimal(output_mapping.get("final_qty"))
        min_executable_qty = optional_decimal(output_mapping.get("min_executable_qty"))
        if (
            fractional_allowed is False
            and final_qty is not None
            and final_qty <= 0
            and min_executable_qty == Decimal("1")
        ):
            return "qty_below_min"

        return None

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
        updated_params["price_snapshot"] = price_snapshot_payload(snapshot)
        if snapshot.spread is not None and "spread" not in updated_params:
            updated_params["spread"] = snapshot.spread
        return decision.model_copy(update={"params": updated_params}), snapshot

    @staticmethod
    def _resolve_llm_fallback(effective_fail_mode: Optional[str] = None) -> str:
        if effective_fail_mode in {"veto", "pass_through"}:
            return effective_fail_mode
        return settings.llm_effective_fail_mode()

    @staticmethod
    def _llm_runtime_model_identifier() -> str:
        return f"dspy:{settings.llm_dspy_program_name}"

    @staticmethod
    def _llm_runtime_prompt_identifier() -> str:
        return f"dspy:{settings.llm_dspy_signature_version}"

    def _fetch_market_context(
        self, symbol: str, *, as_of: datetime | None = None
    ) -> tuple[Optional[MarketContextBundle], Optional[str]]:
        try:
            return self.market_context_client.fetch(symbol, as_of=as_of), None
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
        record: LLMReviewRecord,
    ) -> None:
        request_payload = coerce_json_payload(record.request_json)
        response_payload_json = dict(record.response_json)
        attach_dspy_lineage(
            response_payload_json,
            artifact_source="runtime_persisted_review",
        )
        if not isinstance(
            response_payload_json.get("committee_veto_alignment"), Mapping
        ):
            response_payload_json["committee_veto_alignment"] = (
                build_committee_veto_alignment_payload(
                    committee_veto=committee_trace_has_veto(response_payload_json),
                    deterministic_veto=record.verdict == "veto",
                )
            )
        response_payload = coerce_json_payload(response_payload_json)
        risk_payload = coerce_json_payload(record.risk_flags)
        review = LLMDecisionReview(
            trade_decision_id=record.decision_row.id,
            model=record.model,
            prompt_version=record.prompt_version,
            input_json=request_payload,
            response_json=response_payload,
            verdict=record.verdict,
            confidence=Decimal(str(record.confidence))
            if record.confidence is not None
            else None,
            adjusted_qty=record.adjusted_qty,
            adjusted_order_type=record.adjusted_order_type,
            rationale=record.rationale,
            risk_flags=risk_payload,
            tokens_prompt=record.tokens_prompt,
            tokens_completion=record.tokens_completion,
        )
        record.session.add(review)
        record.session.commit()

    @staticmethod
    def _persist_llm_adjusted_decision(
        session: Session,
        decision_row: TradeDecision,
        decision: StrategyDecision,
    ) -> None:
        decision_json = coerce_json(decision_row.decision_json)
        decision_json["llm_adjusted_decision"] = coerce_json_payload(
            decision.model_dump(mode="json")
        )
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()
