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


class _TradingPipelineMethodsPart2:
    @staticmethod
    def _attach_strategy_position_tags(
        position: dict[str, Any],
        *,
        exposures: Mapping[str, Mapping[str, Mapping[str, Any]]],
        session_open: datetime,
    ) -> list[dict[str, Any]]:
        if str(position.get("strategy_id") or "").strip():
            return [position]
        symbol = _normalized_symbol(position.get("symbol"))
        if not symbol:
            return [position]
        symbol_exposures = exposures.get(symbol)
        if not symbol_exposures:
            return [position]
        raw_qty = (
            position.get("qty")
            or position.get("quantity")
            or position.get("qty_available")
            or "0"
        )
        raw_position_qty = _optional_decimal(raw_qty)
        if raw_position_qty is None or raw_position_qty == 0:
            return [position]
        side = str(position.get("side") or "").strip().lower()
        signed_position_qty = (
            -abs(raw_position_qty)
            if side == "short" or raw_position_qty < 0
            else raw_position_qty
        )
        position_qty = abs(raw_position_qty)
        if signed_position_qty < 0:
            side = "short"
        elif side not in {"long", "short"}:
            side = "long"
        same_side_exposures = [
            (strategy_id, exposure)
            for strategy_id, exposure in symbol_exposures.items()
            if TradingPipeline._same_side_position_exposure(
                signed_position_qty,
                cast(Decimal, exposure.get("qty") or Decimal("0")),
            )
        ]
        if len(same_side_exposures) != 1:
            split_positions = TradingPipeline._split_strategy_position_tags(
                position,
                same_side_exposures=same_side_exposures,
                signed_position_qty=signed_position_qty,
                session_open=session_open,
            )
            return split_positions or [position]

        strategy_id, exposure = same_side_exposures[0]
        exposure_qty = cast(Decimal, exposure.get("qty") or Decimal("0"))
        if (
            abs(abs(exposure_qty) - abs(signed_position_qty))
            > _STRATEGY_POSITION_TAG_TOLERANCE
        ):
            return [position]

        return [
            TradingPipeline._strategy_tagged_position(
                position,
                strategy_id=strategy_id,
                exposure=exposure,
                qty=position_qty,
                side=side,
                session_open=session_open,
            )
        ]

    @staticmethod
    def _split_strategy_position_tags(
        position: dict[str, Any],
        *,
        same_side_exposures: list[tuple[str, Mapping[str, Any]]],
        signed_position_qty: Decimal,
        session_open: datetime,
    ) -> list[dict[str, Any]]:
        if len(same_side_exposures) <= 1:
            return []
        exposure_total = sum(
            (
                cast(Decimal, exposure.get("qty") or Decimal("0"))
                for _strategy_id, exposure in same_side_exposures
            ),
            Decimal("0"),
        )
        if (
            abs(abs(exposure_total) - abs(signed_position_qty))
            > _STRATEGY_POSITION_TAG_TOLERANCE
        ):
            return []
        side = "short" if signed_position_qty < 0 else "long"
        split_positions: list[dict[str, Any]] = []
        for strategy_id, exposure in same_side_exposures:
            exposure_qty = cast(Decimal, exposure.get("qty") or Decimal("0"))
            if exposure_qty == 0:
                continue
            split_positions.append(
                TradingPipeline._strategy_tagged_position(
                    position,
                    strategy_id=strategy_id,
                    exposure=exposure,
                    qty=abs(exposure_qty),
                    side=side,
                    session_open=session_open,
                    split_from_aggregate=True,
                )
            )
        return split_positions

    @staticmethod
    def _strategy_tagged_position(
        position: dict[str, Any],
        *,
        strategy_id: str,
        exposure: Mapping[str, Any],
        qty: Decimal,
        side: str,
        session_open: datetime,
        split_from_aggregate: bool = False,
    ) -> dict[str, Any]:
        tagged = dict(position)
        tagged["strategy_id"] = strategy_id
        tagged["qty"] = str(qty)
        tagged["side"] = side or "long"
        earliest_execution_at = exposure.get("earliest_execution_at")
        stale_position = (
            isinstance(earliest_execution_at, datetime)
            and earliest_execution_at < session_open
        )
        tagged["strategy_position_source"] = (
            "open_exposure_filled_executions"
            if stale_position
            else "current_session_filled_executions"
        )
        tagged["strategy_position_session_open"] = session_open.isoformat()
        if stale_position and isinstance(earliest_execution_at, datetime):
            tagged["strategy_position_stale_session_repair"] = True
            tagged["strategy_position_lookback_start"] = (
                session_open - _STRATEGY_POSITION_TAG_LOOKBACK
            ).isoformat()
            tagged["strategy_position_earliest_execution_at"] = (
                earliest_execution_at.isoformat()
            )
        if split_from_aggregate:
            tagged["strategy_position_split_from_aggregate"] = True
        latest_execution_at = exposure.get("latest_execution_at")
        if isinstance(latest_execution_at, datetime):
            tagged["strategy_position_latest_execution_at"] = (
                latest_execution_at.isoformat()
            )
        buy_qty = cast(Decimal, exposure.get("buy_qty") or Decimal("0"))
        buy_notional = cast(Decimal, exposure.get("buy_notional") or Decimal("0"))
        if (
            buy_qty > 0
            and buy_notional > 0
            and not _optional_decimal(tagged.get("avg_entry_price"))
        ):
            tagged["avg_entry_price"] = str(buy_notional / buy_qty)
        return tagged

    def _resolve_execution_context_open_orders(self) -> list[dict[str, Any]]:
        list_orders = getattr(self.execution_adapter, "list_orders", None)
        if not callable(list_orders):
            return []
        try:
            raw_orders = list_orders(status="open")
        except TypeError:
            try:
                raw_orders = list_orders()
            except Exception as exc:
                logger.warning(
                    "Failed to read execution open orders account=%s error=%s",
                    self.account_label,
                    exc,
                )
                return []
        except Exception as exc:
            logger.warning(
                "Failed to read execution open orders account=%s error=%s",
                self.account_label,
                exc,
            )
            return []
        if not isinstance(raw_orders, list):
            return []
        normalized_orders: list[dict[str, Any]] = []
        for raw_order in cast(list[Any], raw_orders):
            if not isinstance(raw_order, Mapping):
                continue
            normalized_orders.append(
                {
                    str(key): value
                    for key, value in cast(Mapping[object, Any], raw_order).items()
                }
            )
        return normalized_orders

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
        allocator = allocator_from_settings(account_snapshot.equity)
        relevant_symbols = self._relevant_signal_symbols(
            strategies=strategies,
            allowed_symbols=allowed_symbols,
        )
        for signal in batch.signals:
            if (
                relevant_symbols
                and _normalized_symbol(signal.symbol) not in relevant_symbols
            ):
                continue
            decisions = self._evaluate_signal_decisions(
                signal,
                strategies,
                equity=account_snapshot.equity,
                positions=positions,
            )
            if not decisions:
                continue
            allocation_results = allocator.allocate(
                decisions,
                account=account,
                positions=positions,
                regime_label=_resolve_signal_regime(signal),
            )
            self._apply_allocation_results(
                session=session,
                allocation_results=allocation_results,
                strategies=strategies,
                account=account,
                positions=positions,
                allowed_symbols=allowed_symbols,
            )

    def _evaluate_signal_decisions(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Decimal,
        positions: list[dict[str, Any]],
    ) -> list[StrategyDecision]:
        try:
            signal = self._ensure_signal_executable_price(signal)
            quote_status = self._signal_quote_quality.assess(signal)
            if not quote_status.valid:
                self.decision_engine.observe_signal(signal)
                self._record_rejected_signal_outcome_event(
                    signal=signal,
                    quote_status=quote_status,
                )
                logger.info(
                    "Skipping signal due to quote quality account=%s symbol=%s ts=%s reason=%s spread_bps=%s jump_bps=%s",
                    self.account_label,
                    signal.symbol,
                    signal.event_ts.isoformat(),
                    quote_status.reason or "unknown",
                    quote_status.spread_bps,
                    quote_status.jump_bps,
                )
                return []
            evaluate_kwargs: dict[str, Any] = {"equity": equity}
            evaluate_signature = inspect.signature(self.decision_engine.evaluate)
            if "positions" in evaluate_signature.parameters:
                evaluate_kwargs["positions"] = positions
            decisions = self.decision_engine.evaluate(
                signal, strategies, **evaluate_kwargs
            )
            self.state.metrics.record_strategy_runtime(
                self.decision_engine.consume_runtime_telemetry()
            )
            for telemetry in self.decision_engine.consume_forecast_telemetry():
                self.state.metrics.record_forecast_telemetry(telemetry.to_payload())
            for decision in decisions:
                self._record_quantity_resolution_metrics(
                    stage="decision",
                    decision=decision,
                    positions=positions,
                )
            return decisions
        except Exception:
            logger.exception(
                "Decision evaluation failed symbol=%s timeframe=%s",
                signal.symbol,
                signal.timeframe,
            )
            return []

    def _record_rejected_signal_outcome_event(
        self,
        *,
        signal: SignalEnvelope,
        quote_status: QuoteQualityStatus,
    ) -> None:
        reason = quote_status.reason or "unknown"
        self.state.metrics.record_rejected_signal_event(reason)
        event_payload = {
            "schema_version": "torghut.rejected-signal-outcome-event.v1",
            "source": "quote_quality_gate",
            "paper_source": "paper-arxiv-2605.12151",
            "paper_claim_id": "rejection-event-outcome-labels",
            "account_label": self.account_label,
            "symbol": signal.symbol.strip().upper(),
            "event_ts": signal.event_ts.isoformat(),
            "timeframe": signal.timeframe,
            "seq": signal.seq,
            "reject_reason": reason,
            "spread_bps": (
                str(quote_status.spread_bps)
                if quote_status.spread_bps is not None
                else None
            ),
            "jump_bps": (
                str(quote_status.jump_bps)
                if quote_status.jump_bps is not None
                else None
            ),
            "outcome_label_status": "pending",
            "counterfactual_required": True,
            "signal_payload": dict(signal.payload),
            "required_outcome_fields": [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ],
        }
        event_payload["event_id"] = self._rejected_signal_outcome_event_id(
            event_payload
        )
        self.state.last_rejected_signal_outcome_event = event_payload
        self._persist_rejected_signal_outcome_event(event_payload)

    @staticmethod
    def _rejected_signal_outcome_event_id(payload: Mapping[str, Any]) -> str:
        identity = {
            "account_label": payload.get("account_label"),
            "symbol": payload.get("symbol"),
            "event_ts": payload.get("event_ts"),
            "timeframe": payload.get("timeframe"),
            "seq": payload.get("seq"),
            "reject_reason": payload.get("reject_reason"),
            "paper_claim_id": payload.get("paper_claim_id"),
        }
        return hashlib.sha256(
            json.dumps(identity, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()

    def _persist_rejected_signal_outcome_event(
        self,
        event_payload: Mapping[str, Any],
    ) -> None:
        event_id = str(event_payload.get("event_id") or "").strip()
        if not event_id:
            return
        event_ts = event_payload.get("event_ts")
        parsed_event_ts = (
            datetime.fromisoformat(str(event_ts))
            if isinstance(event_ts, str) and event_ts
            else None
        )
        if parsed_event_ts is None:
            return
        try:
            with self.session_factory() as session:
                existing = session.execute(
                    select(RejectedSignalOutcomeEvent).where(
                        RejectedSignalOutcomeEvent.event_id == event_id
                    )
                ).scalar_one_or_none()
                if existing is None:
                    session.add(
                        RejectedSignalOutcomeEvent(
                            event_id=event_id,
                            source=str(event_payload.get("source") or "unknown"),
                            paper_source=str(
                                event_payload.get("paper_source") or "unknown"
                            ),
                            paper_claim_id=str(
                                event_payload.get("paper_claim_id") or "unknown"
                            ),
                            account_label=str(
                                event_payload.get("account_label") or self.account_label
                            ),
                            symbol=str(event_payload.get("symbol") or "").upper(),
                            event_ts=parsed_event_ts,
                            timeframe=str(event_payload.get("timeframe") or ""),
                            seq=(
                                str(event_payload.get("seq"))
                                if event_payload.get("seq") is not None
                                else None
                            ),
                            reject_reason=str(
                                event_payload.get("reject_reason") or "unknown"
                            ),
                            spread_bps=_optional_decimal(
                                event_payload.get("spread_bps")
                            ),
                            jump_bps=_optional_decimal(event_payload.get("jump_bps")),
                            outcome_label_status=str(
                                event_payload.get("outcome_label_status") or "pending"
                            ),
                            counterfactual_required=bool(
                                event_payload.get("counterfactual_required", True)
                            ),
                            required_outcome_fields_json=event_payload.get(
                                "required_outcome_fields"
                            )
                            or [],
                            event_payload_json=dict(event_payload),
                            outcome_payload_json=None,
                        )
                    )
                else:
                    existing.updated_at = datetime.now(timezone.utc)
                    existing.reject_reason = str(
                        event_payload.get("reject_reason") or existing.reject_reason
                    )
                    existing.spread_bps = _optional_decimal(
                        event_payload.get("spread_bps")
                    )
                    existing.jump_bps = _optional_decimal(event_payload.get("jump_bps"))
                    existing.event_payload_json = dict(event_payload)
                session.commit()
        except (SQLAlchemyError, ValueError):
            logger.exception(
                "Failed to persist rejected signal outcome event event_id=%s symbol=%s",
                event_id,
                event_payload.get("symbol"),
            )

    def _label_mature_rejected_signal_outcome_events(
        self,
        *,
        now: datetime | None = None,
        limit: int = _REJECTED_SIGNAL_OUTCOME_LABEL_LIMIT,
        followup_horizon: timedelta = _REJECTED_SIGNAL_OUTCOME_FOLLOWUP_HORIZON,
    ) -> None:
        resolved_now = now or datetime.now(timezone.utc)
        mature_before = resolved_now - followup_horizon
        try:
            with self.session_factory() as session:
                rows = (
                    session.execute(
                        select(RejectedSignalOutcomeEvent)
                        .where(
                            RejectedSignalOutcomeEvent.outcome_label_status == "pending"
                        )
                        .where(RejectedSignalOutcomeEvent.event_ts <= mature_before)
                        .order_by(RejectedSignalOutcomeEvent.event_ts.asc())
                        .limit(max(0, limit))
                    )
                    .scalars()
                    .all()
                )
                for row in rows:
                    try:
                        outcome = self._build_rejected_signal_outcome_payload(
                            row=row,
                            followup_horizon=followup_horizon,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to build rejected signal outcome label event_id=%s",
                            row.event_id,
                        )
                        continue
                    if outcome is None:
                        continue
                    row.outcome_label_status = "labeled"
                    row.outcome_payload_json = outcome
                    row.updated_at = resolved_now
                if rows:
                    session.commit()
        except (SQLAlchemyError, ValueError):
            logger.exception("Failed to label mature rejected signal outcome events")

    def _build_rejected_signal_outcome_payload(
        self,
        *,
        row: RejectedSignalOutcomeEvent,
        followup_horizon: timedelta,
    ) -> dict[str, Any] | None:
        event_payload: dict[str, Any] = {}
        raw_event_payload = row.event_payload_json
        if isinstance(raw_event_payload, Mapping):
            event_payload = {
                str(key): value
                for key, value in cast(Mapping[object, Any], raw_event_payload).items()
            }
        signal_payload = event_payload.get("signal_payload")
        if not isinstance(signal_payload, Mapping):
            signal_payload = {}
        signal_payload_mapping = cast(Mapping[str, Any], signal_payload)
        event_ts = row.event_ts
        if event_ts.tzinfo is None:
            event_ts = event_ts.replace(tzinfo=timezone.utc)
        try:
            seq = int(row.seq) if row.seq is not None else None
        except ValueError:
            seq = None
        entry_signal = SignalEnvelope(
            event_ts=event_ts,
            symbol=row.symbol,
            payload=dict(signal_payload_mapping),
            timeframe=row.timeframe,
            seq=seq,
        )
        followup_signal = entry_signal.model_copy(
            update={"event_ts": event_ts + followup_horizon}
        )
        entry_snapshot = self.price_fetcher.fetch_market_snapshot(entry_signal)
        followup_snapshot = self.price_fetcher.fetch_market_snapshot(followup_signal)
        if (
            entry_snapshot is None
            or followup_snapshot is None
            or entry_snapshot.price is None
            or followup_snapshot.price is None
            or entry_snapshot.price <= 0
            or entry_snapshot.bid is None
            or entry_snapshot.ask is None
        ):
            return None
        counterfactual_return = (
            followup_snapshot.price - entry_snapshot.price
        ) / entry_snapshot.price
        entry_spread = (
            entry_snapshot.spread
            if entry_snapshot.spread is not None
            else entry_snapshot.ask - entry_snapshot.bid
        )
        half_spread_cost = abs(entry_spread) / Decimal("2")
        post_cost_net_pnl = (
            followup_snapshot.price - entry_snapshot.price - half_spread_cost
        )
        route_tca = {
            "entry_price": str(entry_snapshot.price),
            "followup_price": str(followup_snapshot.price),
            "entry_bid": str(entry_snapshot.bid),
            "entry_ask": str(entry_snapshot.ask),
            "entry_spread": str(entry_spread),
            "half_spread_cost": str(half_spread_cost),
            "horizon_seconds": str(int(followup_horizon.total_seconds())),
        }
        return {
            "schema_version": "torghut.rejected-signal-outcome.v1",
            "label_status": "labeled",
            "event_id": row.event_id,
            "candidate_spec_id": event_payload.get("candidate_spec_id"),
            "family_template_id": event_payload.get("family_template_id"),
            "runtime_family": event_payload.get("runtime_family"),
            "runtime_strategy_name": event_payload.get("runtime_strategy_name"),
            "execution_signature": event_payload.get("execution_signature"),
            "feedback_shape_key": event_payload.get("feedback_shape_key"),
            "feedback_risk_profile_key": event_payload.get("feedback_risk_profile_key"),
            "counterfactual_return": str(counterfactual_return),
            "route_tca": route_tca,
            "post_cost_net_pnl": str(post_cost_net_pnl),
            "executable_quote": {
                "bid": str(entry_snapshot.bid),
                "ask": str(entry_snapshot.ask),
                "spread": str(entry_spread),
                "source": entry_snapshot.source,
                "as_of": entry_snapshot.as_of.isoformat(),
            },
            "objective_scorecard": {
                "net_pnl_per_day": str(post_cost_net_pnl),
                "counterfactual_return": str(counterfactual_return),
                "post_cost_net_pnl": str(post_cost_net_pnl),
                "active_day_ratio": "1",
                "positive_day_ratio": "1" if post_cost_net_pnl > 0 else "0",
                "negative_day_count": 0 if post_cost_net_pnl >= 0 else 1,
                "rejected_signal_event_id": row.event_id,
                "rejected_signal_symbol": row.symbol,
                "rejected_signal_reason": row.reject_reason,
            },
        }

    def _ensure_signal_executable_price(self, signal: SignalEnvelope) -> SignalEnvelope:
        price = extract_executable_price(signal.payload)
        bid = optional_decimal(
            payload_value(
                signal.payload,
                "imbalance_bid_px",
                block="imbalance",
                nested_key="bid_px",
            )
        )
        ask = optional_decimal(
            payload_value(
                signal.payload,
                "imbalance_ask_px",
                block="imbalance",
                nested_key="ask_px",
            )
        )
        embedded_quote_status: QuoteQualityStatus | None = None
        if price is not None and bid is not None and ask is not None:
            embedded_quote_status = assess_signal_quote_quality(
                signal=signal,
                previous_price=None,
                policy=self._signal_quote_quality.policy,
            )
        if embedded_quote_status is not None and embedded_quote_status.valid:
            return signal
        snapshot = self.price_fetcher.fetch_market_snapshot(signal)
        if snapshot is None:
            return signal
        payload = dict(signal.payload)
        snapshot_has_executable_quote = (
            snapshot.bid is not None and snapshot.ask is not None
        )
        replace_embedded_quote = (
            snapshot_has_executable_quote
            and embedded_quote_status is not None
            and not embedded_quote_status.valid
        )
        if snapshot.price is not None and (
            price is None or snapshot_has_executable_quote
        ):
            payload["price"] = snapshot.price
        if snapshot.spread is not None and (
            payload.get("spread") is None or snapshot_has_executable_quote
        ):
            payload["spread"] = snapshot.spread
            if snapshot.price is not None and snapshot.price > 0:
                payload["spread_bps"] = (
                    abs(snapshot.spread) / snapshot.price
                ) * Decimal("10000")
        if (bid is None or replace_embedded_quote) and snapshot.bid is not None:
            payload["imbalance_bid_px"] = snapshot.bid
        if (ask is None or replace_embedded_quote) and snapshot.ask is not None:
            payload["imbalance_ask_px"] = snapshot.ask
        if (
            snapshot_has_executable_quote
            and snapshot.spread is not None
            and (payload.get("imbalance_spread") is None or replace_embedded_quote)
        ):
            payload["imbalance_spread"] = snapshot.spread
        if payload == signal.payload:
            return signal
        return signal.model_copy(update={"payload": payload})

    def _feature_quality_failure_payload(
        self,
        *,
        batch: SignalBatch,
        quality_signals: list[SignalEnvelope],
        quality_report: Any,
    ) -> dict[str, Any]:
        sample_rows: list[dict[str, Any]] = []
        for signal in quality_signals[:3]:
            sample_rows.append(
                {
                    "event_ts": signal.event_ts.isoformat(),
                    "symbol": signal.symbol,
                    "seq": signal.seq,
                    "source": signal.source,
                }
            )
        return {
            "component": "trading.feature_quality",
            "account_label": self.account_label,
            "reason_codes": list(getattr(quality_report, "reasons", [])),
            "rows_total": int(getattr(quality_report, "rows_total", 0)),
            "cursor_at": (
                batch.cursor_at.isoformat() if batch.cursor_at is not None else None
            ),
            "cursor_symbol": batch.cursor_symbol,
            "cursor_seq": batch.cursor_seq,
            "sample_rows": sample_rows,
        }

    def _record_quantity_resolution_metrics(
        self,
        *,
        stage: str,
        decision: StrategyDecision,
        positions: list[dict[str, Any]],
    ) -> None:
        sizing = decision.params.get("sizing")
        sizing_map = (
            cast(Mapping[str, Any], sizing) if isinstance(sizing, Mapping) else None
        )
        resolution_payload = (
            dict(cast(Mapping[str, Any], sizing_map.get("quantity_resolution")))
            if sizing_map is not None
            and isinstance(sizing_map.get("quantity_resolution"), Mapping)
            else None
        )
        if resolution_payload is None:
            position_qty = self._position_qty_for_symbol(positions, decision.symbol)
            resolution = resolve_quantity_resolution(
                decision.symbol,
                action=decision.action,
                global_enabled=settings.trading_fractional_equities_enabled,
                allow_shorts=settings.trading_allow_shorts,
                position_qty=position_qty,
                requested_qty=decision.qty,
            )
            resolution_payload = resolution.to_payload()
        context = self._sell_inventory_context(
            decision=decision,
            positions=positions,
            projected=False,
        )
        if decision.action == "sell":
            self.state.metrics.record_sell_inventory_context(
                stage=stage,
                context=context,
            )
        outcome = (
            "fractional"
            if bool(resolution_payload.get("fractional_allowed"))
            else "integer"
        )
        self.state.metrics.record_qty_resolution(
            stage=stage,
            outcome=outcome,
            reason=cast(str | None, resolution_payload.get("reason")),
        )


__all__ = [name for name in globals() if not name.startswith("__")]
