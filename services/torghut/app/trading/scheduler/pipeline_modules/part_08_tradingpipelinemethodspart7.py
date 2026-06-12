# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Trading pipeline implementation."""

from __future__ import annotations

import hashlib
import json
import inspect
import logging
import os
from collections.abc import Callable, Mapping
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Optional, Sequence, cast

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ....alpaca_client import TorghutAlpacaClient
from ....config import settings
from ....db import SessionLocal
from ....models import (
    Execution,
    LLMDecisionReview,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    TradeDecision,
    coerce_json_payload,
)
from ....observability import capture_posthog_event
from ....snapshots import snapshot_account_and_positions
from ....strategies import StrategyCatalog
from ...autonomy.phase_manifest_contract import AUTONOMY_PHASE_ORDER
from ...decisions import DecisionEngine
from ...empirical_jobs import build_empirical_jobs_status
from ...execution import OrderExecutor
from ...execution_adapters import ExecutionAdapter
from ...execution_policy import ExecutionPolicy
from ...feature_quality import (
    REASON_STALENESS,
    FeatureQualityThresholds,
    evaluate_feature_batch_quality,
)
from ...features import extract_executable_price, optional_decimal, payload_value
from ...firewall import OrderFirewall, OrderFirewallBlocked
from ...ingest import ClickHouseSignalIngestor, SignalBatch
from ...lean_lanes import LeanLaneManager
from ...llm import LLMReviewEngine, apply_policy
from ...llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from ...llm.guardrails import evaluate_llm_guardrails
from ...llm.policy import allowed_order_types
from ...llm.schema import MarketContextBundle
from ...llm.schema import MarketSnapshot as LLMMarketSnapshot
from ...market_context import (
    MarketContextClient,
    MarketContextStatus,
    evaluate_market_context,
)
from ...market_context_domains import (
    active_market_context_domain_states,
    active_market_context_reasons,
)
from ...models import SignalEnvelope, StrategyDecision
from ...order_feed import OrderFeedIngestor
from ...paper_route_evidence import (
    PAPER_ROUTE_ACCOUNT_PRE_SESSION_READINESS_SECONDS,
    PAPER_ROUTE_ACCOUNT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS,
)
from ...portfolio import (
    AllocationResult,
    PortfolioSizingResult,
    allocator_from_settings,
    sizer_from_settings,
)
from ...prices import ClickHousePriceFetcher, MarketSnapshot, PriceFetcher
from ...quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    SignalQuoteQualityTracker,
    assess_signal_quote_quality,
)
from ...quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)
from ...reconcile import Reconciler
from ...regime_hmm import (
    HMMRegimeContext,
    resolve_hmm_context,
    resolve_regime_context_authority_reason,
)
from ...risk import RiskEngine
from ...session_context import regular_session_open_utc_for
from ...tca import derive_adaptive_execution_policy
from ...time_source import trading_now
from ...universe import UniverseResolver
from ...submission_council import (
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    build_submission_gate_market_context_status,
    load_quant_evidence_status,
)
from ..pipeline_helpers import (
    _allocator_rejection_reasons,
    _apply_projected_position_decision,
    _attach_dspy_lineage,
    _autonomy_gate_report_is_saturated_fail_sentinel,
    _build_committee_veto_alignment_payload,
    _build_llm_policy_resolution,
    _build_portfolio_snapshot,
    _classify_llm_error,
    _clone_positions,
    _coerce_bool,
    _coerce_json,
    _coerce_runtime_uncertainty_gate_action,
    _coerce_strategy_symbols,
    _committee_trace_has_veto,
    _extract_json_error_payload,
    _format_order_submit_rejection,
    _hash_payload,
    _is_runtime_risk_increasing_entry,
    _llm_guardrail_controls_snapshot,
    _load_recent_decisions,
    _normalize_rollout_stage,
    _optional_decimal,
    _optional_int,
    _price_snapshot_payload,
    _project_open_orders_onto_positions,
    _resolve_decision_regime_label_with_source,
    _resolve_llm_review_error_reject_reason,
    _resolve_llm_unavailable_reject_reason,
    _resolve_signal_regime,
    _select_strictest_runtime_uncertainty_gate,
    _uncertainty_gate_staleness_reason,
)
from ..safety import (
    _FRESH_TAIL_NO_SIGNAL_REASONS,
    _is_market_session_open,
    _latch_signal_continuity_alert_state,
    _record_signal_continuity_recovery_cycle,
    _signal_bootstrap_grace_active,
    _signal_tail_is_fresh,
)
from ..state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
    TradingState,
    _normalize_reason_metric,
)

# ruff: noqa: F401,F403,F405,F821,F821,F821

from .part_01_statements_158 import *
from .part_02_tradingpipelinemethodspart1 import *
from .part_03_tradingpipelinemethodspart2 import *
from .part_04_tradingpipelinemethodspart3 import *
from .part_05_tradingpipelinemethodspart4 import *
from .part_06_tradingpipelinemethodspart5 import *
from .part_07_tradingpipelinemethodspart6 import *


class _TradingPipelineMethodsPart7:
    def _maybe_handle_market_context_block(
        self,
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        guardrails: Any,
        policy_resolution: dict[str, Any],
        market_context: Optional[MarketContextBundle],
        market_context_error: Optional[str],
    ) -> tuple[StrategyDecision, Optional[str]] | None:
        market_context_status = evaluate_market_context(market_context)
        if market_context_error is not None:
            market_context_status = MarketContextStatus(
                allow_llm=False,
                reason="market_context_fetch_error",
                risk_flags=["market_context_fetch_error"],
            )
        if market_context_status.allow_llm:
            return None

        self.state.metrics.llm_market_context_block_total += 1
        market_context_shadow_mode = (
            guardrails.shadow_mode
            or settings.trading_market_context_fail_mode == "shadow_only"
        )
        self.state.metrics.record_market_context_result(
            market_context_status.reason,
            shadow_mode=market_context_shadow_mode,
        )
        return self._handle_llm_unavailable(
            session,
            decision,
            decision_row,
            account,
            positions,
            reason=market_context_status.reason or "market_context_unavailable",
            reject_reason="market_context_block",
            shadow_mode=market_context_shadow_mode,
            effective_fail_mode=guardrails.effective_fail_mode,
            risk_flags=market_context_status.risk_flags,
            market_context=market_context,
            response_payload_extra={
                "market_context": {
                    "reason": market_context_status.reason,
                    "risk_flags": list(market_context_status.risk_flags),
                }
            },
            policy_resolution=policy_resolution,
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
            allow_llm = not settings.trading_market_context_required
            reason = market_context_error or (
                "market_context_required_missing"
                if settings.trading_market_context_required
                else None
            )
            self.state.last_market_context_allow_llm = allow_llm
            self.state.last_market_context_reason = reason
            self.state.market_context_alert_active = (
                market_context_error is not None
                or (settings.trading_market_context_required and not allow_llm)
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
        self.state.market_context_alert_active = market_context_error is not None or (
            not market_context_status.allow_llm
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
        response_json["guardrail_controls"] = _llm_guardrail_controls_snapshot()
        committee_veto = _committee_trace_has_veto(response_json)
        response_json["committee_veto_alignment"] = (
            _build_committee_veto_alignment_payload(
                committee_veto=committee_veto,
                deterministic_veto=policy_outcome.verdict == "veto",
            )
        )
        _attach_dspy_lineage(
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
                latency_ms=_optional_int(role_data.get("latency_ms")),
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
        committee_veto = _committee_trace_has_veto(outcome.response_json)
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
        *,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        guardrails: Any,
        policy_resolution: dict[str, Any],
        engine: LLMReviewEngine,
        request_json: dict[str, Any],
        error: Exception,
    ) -> tuple[StrategyDecision, Optional[str]]:
        self.state.metrics.llm_error_total += 1
        unsupported_state_error = isinstance(error, DSPyRuntimeUnsupportedStateError)
        if not unsupported_state_error:
            engine.circuit_breaker.record_error()
        if unsupported_state_error:
            policy_resolution = _build_llm_policy_resolution(
                rollout_stage=guardrails.rollout_stage,
                effective_fail_mode="veto",
                guardrail_reasons=guardrails.reasons,
            )
        error_label = _classify_llm_error(error)
        if error_label == "llm_response_not_json":
            self.state.metrics.llm_parse_error_total += 1
        elif error_label == "llm_response_invalid":
            self.state.metrics.llm_validation_error_total += 1

        fallback = (
            "veto"
            if unsupported_state_error
            else self._resolve_llm_fallback(guardrails.effective_fail_mode)
        )
        effective_verdict = "veto" if fallback == "veto" else "approve"
        if not request_json:
            request_json = {"decision": decision.model_dump(mode="json")}
        response_json: dict[str, Any] = {
            "error": str(error),
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "policy_resolution": policy_resolution,
            "guardrail_controls": _llm_guardrail_controls_snapshot(),
            "advisory_only": True,
        }
        if guardrails.reasons:
            response_json["mrm_guardrails"] = list(guardrails.reasons)
        response_json["request_hash"] = _hash_payload(request_json)
        response_json["response_hash"] = _hash_payload(response_json)
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=self._llm_runtime_model_identifier(),
            prompt_version=self._llm_runtime_prompt_identifier(),
            request_json=request_json,
            response_json=response_json,
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=f"llm_error_{fallback}",
            risk_flags=[type(error).__name__] + list(guardrails.reasons),
            tokens_prompt=None,
            tokens_completion=None,
        )
        if unsupported_state_error:
            logger.warning(
                "Unsupported DSPy runtime state; vetoing decision_id=%s error=%s",
                decision_row.id,
                error,
            )
            return decision, "llm_unavailable_dspy_runtime_unsupported_state"
        if guardrails.shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            if not settings.llm_shadow_mode:
                self.state.metrics.llm_guardrail_shadow_total += 1
            return decision, None
        if fallback == "veto":
            logger.warning(
                "LLM review failed; vetoing decision_id=%s error=%s",
                decision_row.id,
                error,
            )
            return decision, _resolve_llm_review_error_reject_reason(error)
        logger.warning(
            "LLM review failed; pass-through decision_id=%s error=%s",
            decision_row.id,
            error,
        )
        return decision, None

    def _handle_llm_unavailable(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        reason: str,
        shadow_mode: bool,
        effective_fail_mode: Optional[str] = None,
        risk_flags: Optional[list[str]] = None,
        market_context: Optional[MarketContextBundle] = None,
        reject_reason: Optional[str] = None,
        response_payload_extra: Optional[dict[str, Any]] = None,
        policy_resolution: Optional[dict[str, Any]] = None,
    ) -> tuple[StrategyDecision, Optional[str]]:
        fallback = self._resolve_llm_fallback(effective_fail_mode)
        effective_verdict = "veto" if fallback == "veto" else "approve"
        reject_reason = (
            _resolve_llm_unavailable_reject_reason(reason)
            if fallback == "veto" and not shadow_mode
            else None
        )
        self.state.metrics.record_llm_unavailable(
            reason=reason, reject_reason=reject_reason
        )
        portfolio_snapshot = _build_portfolio_snapshot(account, positions)
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = _load_recent_decisions(
            session,
            decision.strategy_id,
            decision.symbol,
        )
        if self.llm_review_engine is not None:
            request_payload = self.llm_review_engine.build_request(
                decision=decision,
                account=account,
                positions=positions,
                portfolio=portfolio_snapshot,
                market=market_snapshot,
                market_context=market_context,
                recent_decisions=recent_decisions,
            ).model_dump(mode="json")
        else:
            request_payload = {
                "decision": decision.model_dump(mode="json"),
                "portfolio": portfolio_snapshot.model_dump(mode="json"),
                "market": market_snapshot.model_dump(mode="json")
                if market_snapshot is not None
                else None,
                "market_context": market_context.model_dump(mode="json")
                if market_context is not None
                else None,
                "recent_decisions": [
                    summary.model_dump(mode="json") for summary in recent_decisions
                ],
                "account": account,
                "positions": positions,
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
            "error": reason,
            "fallback": fallback,
            "effective_verdict": effective_verdict,
            "reject_reason": reject_reason,
            "policy_resolution": policy_resolution
            or _build_llm_policy_resolution(
                rollout_stage=_normalize_rollout_stage(settings.llm_rollout_stage),
                effective_fail_mode=fallback,
                guardrail_reasons=risk_flags or [],
            ),
            "advisory_only": True,
        }
        if response_payload_extra:
            response_payload.update(response_payload_extra)
        decision_metadata_update: dict[str, Any] = {}
        if response_payload_extra:
            llm_runtime_payload = response_payload_extra.get("llm_runtime")
            if isinstance(llm_runtime_payload, Mapping):
                decision_metadata_update["llm_runtime"] = dict(
                    cast(Mapping[str, Any], llm_runtime_payload)
                )
            market_context_payload = response_payload_extra.get("market_context")
            if isinstance(market_context_payload, Mapping):
                decision_metadata_update["market_context"] = dict(
                    cast(Mapping[str, Any], market_context_payload)
                )
        if decision_metadata_update:
            self.executor.update_decision_json(
                session,
                decision_row,
                decision_metadata_update,
            )
        response_payload["request_hash"] = _hash_payload(request_payload)
        response_payload["response_hash"] = _hash_payload(response_payload)
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=self._llm_runtime_model_identifier(),
            prompt_version=self._llm_runtime_prompt_identifier(),
            request_json=request_payload,
            response_json={
                **response_payload,
                "guardrail_controls": _llm_guardrail_controls_snapshot(),
            },
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=reason,
            risk_flags=[reason] + (risk_flags or []),
            tokens_prompt=None,
            tokens_completion=None,
        )
        if shadow_mode:
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
                price=_optional_decimal(price),
                spread=_optional_decimal(spread),
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
            per_symbol_cap = _optional_decimal(
                cast(Mapping[str, Any], caps).get("per_symbol")
            )
        if limiting_constraint == "symbol_capacity_exhausted" or (
            per_symbol_cap is not None and per_symbol_cap <= 0
        ):
            return "symbol_capacity_exhausted"

        fractional_allowed = output_mapping.get("fractional_allowed")
        final_qty = _optional_decimal(output_mapping.get("final_qty"))
        min_executable_qty = _optional_decimal(output_mapping.get("min_executable_qty"))
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
        updated_params["price_snapshot"] = _price_snapshot_payload(snapshot)
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
        session: Session,
        decision_row: TradeDecision,
        model: str,
        prompt_version: str,
        request_json: dict[str, Any],
        response_json: dict[str, Any],
        verdict: str,
        confidence: Optional[float],
        adjusted_qty: Optional[Decimal],
        adjusted_order_type: Optional[str],
        rationale: Optional[str],
        risk_flags: list[str],
        tokens_prompt: Optional[int],
        tokens_completion: Optional[int],
    ) -> None:
        request_payload = coerce_json_payload(request_json)
        response_payload_json = dict(response_json)
        _attach_dspy_lineage(
            response_payload_json,
            artifact_source="runtime_persisted_review",
        )
        if not isinstance(
            response_payload_json.get("committee_veto_alignment"), Mapping
        ):
            response_payload_json["committee_veto_alignment"] = (
                _build_committee_veto_alignment_payload(
                    committee_veto=_committee_trace_has_veto(response_payload_json),
                    deterministic_veto=verdict == "veto",
                )
            )
        response_payload = coerce_json_payload(response_payload_json)
        risk_payload = coerce_json_payload(risk_flags)
        review = LLMDecisionReview(
            trade_decision_id=decision_row.id,
            model=model,
            prompt_version=prompt_version,
            input_json=request_payload,
            response_json=response_payload,
            verdict=verdict,
            confidence=Decimal(str(confidence)) if confidence is not None else None,
            adjusted_qty=adjusted_qty,
            adjusted_order_type=adjusted_order_type,
            rationale=rationale,
            risk_flags=risk_payload,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
        )
        session.add(review)
        session.commit()

    @staticmethod
    def _persist_llm_adjusted_decision(
        session: Session,
        decision_row: TradeDecision,
        decision: StrategyDecision,
    ) -> None:
        decision_json = _coerce_json(decision_row.decision_json)
        decision_json["llm_adjusted_decision"] = coerce_json_payload(
            decision.model_dump(mode="json")
        )
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()


__all__ = [name for name in globals() if not name.startswith("__")]
