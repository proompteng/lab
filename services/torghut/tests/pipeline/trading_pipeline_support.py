from __future__ import annotations

# ruff: noqa: F401,F811

import json
import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from typing import Any, Callable, Literal, Mapping, Sequence, cast
from uuid import uuid4

from sqlalchemy import create_engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Base,
    Execution,
    LLMDecisionReview,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
    VNextDatasetSnapshot,
)
from app import config
from app.trading.decisions import (
    DecisionEngine,
    _is_entry_action_for_strategies,
    _is_exit_action_for_strategies,
    _strategy_uses_position_isolation,
)
from app.trading.execution_adapters import SimulationExecutionAdapter
from app.trading.execution import OrderExecutor
from app.trading.firewall import OrderFirewall
from app.trading.llm.review_engine import LLMReviewOutcome
from app.trading.llm.dspy_programs.runtime import (
    DSPyReviewRuntime,
    DSPyRuntimeUnsupportedStateError,
)
from app.trading.llm.schema import (
    LLMDecisionContext,
    LLMPolicyContext,
    MarketContextBundle,
    PortfolioSnapshot,
    RecentDecisionSummary,
    LLMReviewRequest,
    LLMReviewResponse,
)
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.prices import MarketSnapshot, PriceFetcher
from app.trading.ingest import SignalBatch
from app.trading.paper_route_target_plan import (
    materialize_bounded_paper_route_target_plan,
    paper_route_target_plan_from_payload,
)
from app.trading.quote_quality import QuoteQualityStatus
from app.trading.reconcile import Reconciler
from app.trading.runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
)
from app.trading.risk import RiskEngine
from app.trading.scheduler.pipeline import TradingPipeline
from app.trading.scheduler.simple_pipeline import (
    SimpleTradingPipeline,
    _bounded_paper_route_collection_entry_metadata,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_target_with_runtime_account_audit,
    _bounded_sim_collection_metadata_from_decision,
    _executable_bid_ask_present,
    _paper_route_probe_entry_metadata,
    _paper_route_probe_lineage_from_params,
    _strategy_signal_paper_entry_metadata,
    _parse_target_datetime,
    _safe_int,
    _target_probe_action,
    _target_probe_symbol_notional_budget,
    _target_probe_window,
    _target_notional_sizing_audit_from_params,
    _target_truthy,
)
from app.trading.scheduler.pipeline_helpers import (
    _apply_projected_position_decision,
    _build_dspy_lineage,
    _committee_trace_has_veto,
    _project_open_orders_onto_positions,
)
from app.trading.scheduler.state import TradingState
from app.trading.submission_council import build_hypothesis_runtime_summary
from app.trading.tca import AdaptiveExecutionPolicyDecision
from app.trading.universe import UniverseResolver


def _target_price_snapshots(
    *symbols: str, price: str = "100"
) -> dict[str, dict[str, str]]:
    return {
        symbol: {
            "symbol": symbol,
            "price": price,
            "bid": price,
            "ask": price,
            "spread": "0",
            "source": "test_executable_quote",
            "quote_source": "test_executable_quote",
        }
        for symbol in symbols
    }


def _with_default_executable_quote(signal: SignalEnvelope) -> SignalEnvelope:
    payload = dict(signal.payload)
    if (
        payload.get("price") is None
        or payload.get("imbalance_bid_px") is not None
        or payload.get("imbalance_ask_px") is not None
    ):
        return signal

    try:
        price = Decimal(str(payload["price"]))
    except Exception:
        return signal
    if price <= 0:
        return signal

    spread = payload.get("spread")
    try:
        executable_spread = (
            Decimal(str(spread)) if spread is not None else Decimal("0.02")
        )
    except Exception:
        executable_spread = Decimal("0.02")
    if executable_spread <= 0:
        executable_spread = Decimal("0.02")
    half_spread = executable_spread / Decimal("2")
    bid = price - half_spread
    if bid <= 0:
        bid = Decimal("0.0001")
        executable_spread = Decimal("0.02")
    ask = bid + executable_spread
    payload["spread"] = ask - bid
    payload["imbalance_bid_px"] = bid
    payload["imbalance_ask_px"] = ask
    return signal.model_copy(update={"payload": payload})


def _market_context_bundle(
    *,
    symbol: str = "AAPL",
    as_of: datetime | None = None,
    freshness_seconds: int = 20,
    quality_score: float = 0.92,
) -> MarketContextBundle:
    as_of = as_of or datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)

    def domain(name: str) -> dict[str, object]:
        return {
            "domain": name,
            "state": "ok",
            "asOf": as_of.isoformat(),
            "freshnessSeconds": freshness_seconds,
            "maxFreshnessSeconds": 300,
            "sourceCount": 1,
            "qualityScore": quality_score,
            "payload": {},
            "citations": [],
            "riskFlags": [],
        }

    return MarketContextBundle.model_validate(
        {
            "contextVersion": "torghut.market-context.v1",
            "symbol": symbol,
            "asOfUtc": as_of.isoformat(),
            "freshnessSeconds": freshness_seconds,
            "qualityScore": quality_score,
            "sourceCount": 4,
            "riskFlags": [],
            "domains": {
                "technicals": domain("technicals"),
                "fundamentals": domain("fundamentals"),
                "news": domain("news"),
                "regime": domain("regime"),
            },
        }
    )


class FakeIngestor:
    def __init__(
        self,
        signals: list[SignalEnvelope],
        *,
        cursor_at: datetime | None = None,
        cursor_seq: int | None = None,
        cursor_symbol: str | None = None,
        signal_lag_seconds: float | None = None,
    ) -> None:
        self.signals = [_with_default_executable_quote(signal) for signal in signals]
        self.cursor_at = cursor_at
        self.cursor_seq = cursor_seq
        self.cursor_symbol = cursor_symbol
        self.signal_lag_seconds = signal_lag_seconds
        self.committed_batches = 0
        self.fetch_scopes: list[tuple[set[str] | None, set[str] | None]] = []

    def fetch_signals(
        self,
        session: Session,
        *,
        symbols: set[str] | None = None,
        timeframes: set[str] | None = None,
    ) -> SignalBatch:
        self.fetch_scopes.append(
            (
                set(symbols) if symbols is not None else None,
                set(timeframes) if timeframes is not None else None,
            )
        )
        return SignalBatch(
            signals=self.signals,
            cursor_at=self.cursor_at,
            cursor_seq=self.cursor_seq,
            cursor_symbol=self.cursor_symbol,
            signal_lag_seconds=self.signal_lag_seconds,
        )

    def commit_cursor(self, session: Session, batch: SignalBatch) -> None:
        self.committed_batches += 1
        return None


class NoSignalReasonIngestor(FakeIngestor):
    def __init__(self, *, no_signal_reason: str) -> None:
        super().__init__([])
        self.no_signal_reason = no_signal_reason

    def fetch_signals(
        self,
        session: Session,
        *,
        symbols: set[str] | None = None,
        timeframes: set[str] | None = None,
    ) -> SignalBatch:
        self.fetch_scopes.append(
            (
                set(symbols) if symbols is not None else None,
                set(timeframes) if timeframes is not None else None,
            )
        )
        return SignalBatch(
            signals=[],
            cursor_at=None,
            cursor_seq=None,
            cursor_symbol=None,
            no_signal_reason=self.no_signal_reason,
            signals_authoritative=False,
        )


class CursorAdvancingFakeIngestor(FakeIngestor):
    def fetch_signals(self, session: Session) -> SignalBatch:
        if self.committed_batches > 0:
            return SignalBatch(
                signals=[],
                cursor_at=self.cursor_at,
                cursor_seq=self.cursor_seq,
                cursor_symbol=self.cursor_symbol,
            )
        return super().fetch_signals(session)


class WarmupIngestor(FakeIngestor):
    def __init__(
        self,
        *,
        warmup_signals: list[SignalEnvelope],
        signals: list[SignalEnvelope],
        cursor_at: datetime,
    ) -> None:
        super().__init__(signals)
        self.warmup_signals = [
            _with_default_executable_quote(signal) for signal in warmup_signals
        ]
        self.cursor_at = cursor_at
        self.warmup_ranges: list[tuple[datetime, datetime]] = []
        self.warmup_limits: list[int | None] = []

    def _get_cursor(self, session: Session) -> tuple[datetime, int | None, str | None]:
        return self.cursor_at, None, None

    def fetch_signals_with_reason(
        self, *, start: datetime, end: datetime, limit: int | None = None
    ) -> SignalBatch:
        self.warmup_ranges.append((start, end))
        self.warmup_limits.append(limit)
        signals = [
            signal for signal in self.warmup_signals if start <= signal.event_ts <= end
        ]
        if limit is not None:
            signals = signals[: max(0, int(limit))]
        return SignalBatch(
            signals=signals,
            cursor_at=end,
            cursor_seq=None,
            cursor_symbol=None,
            query_start=start,
            query_end=end,
        )


class CursorErrorWarmupIngestor(WarmupIngestor):
    def _get_cursor(self, session: Session) -> tuple[datetime, int | None, str | None]:
        del session
        raise RuntimeError("cursor failed")


class FetchErrorWarmupIngestor(WarmupIngestor):
    def fetch_signals_with_reason(
        self, *, start: datetime, end: datetime, limit: int | None = None
    ) -> SignalBatch:
        del start, end, limit
        raise RuntimeError("warmup fetch failed")


class TransactionAwareWarmupIngestor(WarmupIngestor):
    def __init__(
        self,
        *,
        warmup_signals: list[SignalEnvelope],
        signals: list[SignalEnvelope],
        cursor_at: datetime,
        transaction_probe: Callable[[], bool],
    ) -> None:
        super().__init__(
            warmup_signals=warmup_signals,
            signals=signals,
            cursor_at=cursor_at,
        )
        self.transaction_probe = transaction_probe
        self.transaction_active_during_fetch: bool | None = None

    def fetch_signals_with_reason(
        self, *, start: datetime, end: datetime, limit: int | None = None
    ) -> SignalBatch:
        self.transaction_active_during_fetch = self.transaction_probe()
        return super().fetch_signals_with_reason(start=start, end=end, limit=limit)


class RecordingDecisionEngine(DecisionEngine):
    def __init__(self) -> None:
        super().__init__()
        self.observed_symbols: list[str] = []

    def observe_signal(self, signal: SignalEnvelope) -> None:
        self.observed_symbols.append(signal.symbol)
        super().observe_signal(signal)


class RaisingObserveDecisionEngine(DecisionEngine):
    def observe_signal(self, signal: SignalEnvelope) -> None:
        del signal
        raise RuntimeError("observe failed")


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []
        self.cancel_all_calls = 0

    def get_account(self) -> dict[str, str]:
        return {"equity": "10000", "cash": "10000", "buying_power": "10000"}

    def list_positions(self) -> list[dict[str, str]]:
        return []

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, str] | None = None,
        *,
        firewall_token: object | None = None,
    ) -> dict[str, str]:
        order = {
            "id": f"order-{len(self.submitted) + 1}",
            "client_order_id": extra_params.get("client_order_id")
            if extra_params
            else None,
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
            "qty": str(qty),
            "filled_qty": "0",
            "status": "accepted",
        }
        self.submitted.append(order)
        return order

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: object | None = None
    ) -> bool:
        return True

    def cancel_all_orders(
        self, *, firewall_token: object | None = None
    ) -> list[dict[str, str]]:
        self.cancel_all_calls += 1
        return [{"id": "order-1"}]

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        return list(self.submitted)

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, str] | None:
        return next(
            (
                order
                for order in self.submitted
                if order.get("client_order_id") == client_order_id
            ),
            None,
        )

    def get_order(self, alpaca_order_id: str) -> dict[str, str]:
        return {
            "id": alpaca_order_id,
            "status": "filled",
            "filled_qty": "1",
            "filled_avg_price": "100",
        }


class RejectingAlpacaClient(FakeAlpacaClient):
    def __init__(self) -> None:
        super().__init__()
        self.submit_calls = 0
        self.cancel_calls: list[str] = []

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, str] | None = None,
        *,
        firewall_token: object | None = None,
    ) -> dict[str, str]:
        self.submit_calls += 1
        raise Exception(
            '{"code":40310000,"existing_order_id":"order-existing","message":"potential wash trade detected","reject_reason":"opposite side market/stop order exists"}'
        )

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: object | None = None
    ) -> bool:
        self.cancel_calls.append(alpaca_order_id)
        return True


class SellInventoryConflictAlpacaClient(FakeAlpacaClient):
    def __init__(self) -> None:
        super().__init__()
        self.cancel_calls: list[str] = []

    def list_positions(self) -> list[dict[str, str]]:
        return [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
            },
        ]

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        if status != "open":
            return []
        return [
            {
                "id": "existing-sell-order",
                "client_order_id": "existing-sell-order",
                "symbol": "AAPL",
                "side": "sell",
                "type": "limit",
                "time_in_force": "day",
                "qty": "1",
                "filled_qty": "0",
                "status": "accepted",
            },
        ]

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: object | None = None
    ) -> bool:
        self.cancel_calls.append(alpaca_order_id)
        return True


class CountingAlpacaClient(FakeAlpacaClient):
    def __init__(self) -> None:
        super().__init__()
        self.account_calls = 0
        self.position_calls = 0

    def get_account(self) -> dict[str, str]:
        self.account_calls += 1
        return super().get_account()

    def list_positions(self) -> list[dict[str, str]]:
        self.position_calls += 1
        return super().list_positions()


class PositionedAlpacaClient(FakeAlpacaClient):
    def __init__(self, positions: list[dict[str, str]]) -> None:
        super().__init__()
        self._positions = positions

    def list_positions(self) -> list[dict[str, str]]:
        return list(self._positions)


class OpenOrderAlpacaClient(FakeAlpacaClient):
    def __init__(self, orders: list[dict[str, str]]) -> None:
        super().__init__()
        self._orders = orders

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        if status == "open":
            return [dict(order) for order in self._orders]
        return super().list_orders(status=status)


class SellInventoryConflictRetryClient(FakeAlpacaClient):
    def __init__(self) -> None:
        super().__init__()
        self._orders = [
            {
                "id": "open-sell-1",
                "symbol": "AAPL",
                "side": "sell",
                "qty": "1",
                "filled_qty": "0",
                "status": "accepted",
            }
        ]
        self.cancel_calls: list[str] = []

    def list_positions(self) -> list[dict[str, str]]:
        return [{"symbol": "AAPL", "qty": "1", "market_value": "100"}]

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        return [dict(order) for order in self._orders]

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: object | None = None
    ) -> bool:
        self.cancel_calls.append(alpaca_order_id)
        for order in self._orders:
            if order.get("id") == alpaca_order_id:
                order["status"] = "canceled"
        return True


class FakeLLMReviewEngine:
    def __init__(
        self,
        verdict: str = "approve",
        adjusted_qty: Decimal | None = None,
        adjusted_order_type: str | None = None,
        limit_price: Decimal | None = None,
        confidence: float = 0.9,
        confidence_band: str | None = None,
        uncertainty_score: float | None = None,
        uncertainty_band: str | None = None,
        calibrated_probabilities: dict[str, float] | None = None,
        calibration_quality_score: float | None = None,
        error: Exception | None = None,
        circuit_open: bool = False,
    ) -> None:
        self.verdict = verdict
        self.adjusted_qty = adjusted_qty
        self.adjusted_order_type = adjusted_order_type
        self.limit_price = limit_price
        self.confidence = confidence
        self.confidence_band = confidence_band
        self.uncertainty_score = uncertainty_score
        self.uncertainty_band = uncertainty_band
        self.calibrated_probabilities = calibrated_probabilities
        self.calibration_quality_score = calibration_quality_score
        self.error = error
        self.circuit_breaker = FakeCircuitBreaker(circuit_open)

    def build_request(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        portfolio: PortfolioSnapshot | None = None,
        market: MarketSnapshot | None = None,
        market_context: MarketContextBundle | None = None,
        recent_decisions: list[RecentDecisionSummary] | None = None,
        adjustment_allowed: bool | None = None,
    ) -> LLMReviewRequest:
        portfolio_snapshot = portfolio or PortfolioSnapshot(
            equity=Decimal("10000"),
            cash=Decimal("10000"),
            buying_power=Decimal("10000"),
            total_exposure=Decimal("0"),
            exposure_by_symbol={},
            positions=positions,
        )
        return LLMReviewRequest(
            decision=LLMDecisionContext(
                strategy_id=decision.strategy_id,
                symbol=decision.symbol,
                action=decision.action,
                qty=decision.qty,
                order_type=decision.order_type,
                time_in_force=decision.time_in_force,
                event_ts=decision.event_ts,
                timeframe=decision.timeframe,
                rationale=decision.rationale,
                params=decision.params,
            ),
            portfolio=portfolio_snapshot,
            market=market,
            market_context=market_context,
            recent_decisions=recent_decisions or [],
            account=account,
            positions=positions,
            policy=LLMPolicyContext(
                adjustment_allowed=True
                if adjustment_allowed is None
                else adjustment_allowed,
                min_qty_multiplier=Decimal("0.5"),
                max_qty_multiplier=Decimal("1.25"),
                allowed_order_types=["limit", "market"],
            ),
            trading_mode="paper",
            prompt_version="test",
        )

    def review(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        request: LLMReviewRequest | None = None,
        portfolio: PortfolioSnapshot | None = None,
        market: MarketSnapshot | None = None,
        market_context: MarketContextBundle | None = None,
        recent_decisions: list[RecentDecisionSummary] | None = None,
    ) -> LLMReviewOutcome:
        if self.error:
            raise self.error
        request = request or self.build_request(
            decision,
            account,
            positions,
            portfolio=portfolio,
            market=market,
            market_context=market_context,
            recent_decisions=recent_decisions,
        )
        response = LLMReviewResponse(
            verdict=self.verdict,
            confidence=self.confidence,
            confidence_band=self.confidence_band
            or (
                "high"
                if self.confidence >= 0.75
                else "medium"
                if self.confidence >= 0.5
                else "low"
            ),
            calibrated_probabilities=self.calibrated_probabilities
            or _default_probabilities(self.verdict, self.confidence),
            uncertainty={
                "score": self.uncertainty_score
                if self.uncertainty_score is not None
                else (1.0 - self.confidence),
                "band": self.uncertainty_band
                or (
                    "low"
                    if self.confidence >= 0.75
                    else "medium"
                    if self.confidence >= 0.5
                    else "high"
                ),
            },
            calibration_metadata=(
                {"quality_score": self.calibration_quality_score}
                if self.calibration_quality_score is not None
                else {}
            ),
            adjusted_qty=self.adjusted_qty,
            adjusted_order_type=self.adjusted_order_type,
            limit_price=self.limit_price,
            rationale="ok",
            risk_flags=[],
        )
        return LLMReviewOutcome(
            request_json=request.model_dump(mode="json"),
            response_json=response.model_dump(mode="json"),
            response=response,
            model="test-model",
            prompt_version="test",
            tokens_prompt=12,
            tokens_completion=7,
            request_hash="test-request-hash",
            response_hash="test-response-hash",
        )


class CountingLLMReviewEngine(FakeLLMReviewEngine):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.review_calls = 0
        super().__init__(*args, **kwargs)

    def review(
        self,
        decision: StrategyDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        request: LLMReviewRequest | None = None,
        portfolio: PortfolioSnapshot | None = None,
        market: MarketSnapshot | None = None,
        market_context: MarketContextBundle | None = None,
        recent_decisions: list[RecentDecisionSummary] | None = None,
    ) -> LLMReviewOutcome:
        self.review_calls += 1
        return super().review(
            decision,
            account=account,
            positions=positions,
            request=request,
            portfolio=portfolio,
            market=market,
            market_context=market_context,
            recent_decisions=recent_decisions,
        )


def _default_probabilities(verdict: str, confidence: float) -> dict[str, float]:
    labels = ["approve", "veto", "adjust", "abstain", "escalate"]
    selected = verdict if verdict in labels else "approve"
    remainder = max(0.0, 1.0 - confidence)
    background = remainder / 4.0
    probabilities = {label: background for label in labels}
    probabilities[selected] = confidence
    return probabilities


class FakePriceFetcher(PriceFetcher):
    def __init__(
        self,
        price: Decimal,
        *,
        spread: Decimal | None = None,
        bid: Decimal | None = None,
        ask: Decimal | None = None,
        quote_lookup_diagnostics: dict[str, object] | None = None,
    ) -> None:
        self.price = price
        self.spread = spread
        self.bid = bid
        self.ask = ask
        self.quote_lookup_diagnostics = quote_lookup_diagnostics
        self.snapshot_requests = 0

    def fetch_price(self, signal: SignalEnvelope) -> Decimal:
        return self.price

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> MarketSnapshot:
        self.snapshot_requests += 1
        return MarketSnapshot(
            symbol=signal.symbol,
            as_of=signal.event_ts,
            price=self.price,
            spread=self.spread,
            source="price_fetcher",
            bid=self.bid,
            ask=self.ask,
            quote_lookup_diagnostics=self.quote_lookup_diagnostics,
        )


class TimelinePriceFetcher(PriceFetcher):
    def __init__(self, snapshots: dict[datetime, MarketSnapshot]) -> None:
        self.snapshots = snapshots

    def fetch_price(self, signal: SignalEnvelope) -> Decimal | None:
        snapshot = self.fetch_market_snapshot(signal)
        return snapshot.price if snapshot is not None else None

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> MarketSnapshot | None:
        return self.snapshots.get(signal.event_ts)


class FakeCircuitBreaker:
    def __init__(self, open_state: bool = False) -> None:
        self.open_state = open_state

    def is_open(self) -> bool:
        return self.open_state

    def record_error(self) -> None:
        return None

    def record_success(self) -> None:
        return None


def _set_llm_guardrails(config, *, adjustment_approved: bool = False) -> None:
    config.settings.llm_allowed_models_raw = config.settings.llm_model
    config.settings.llm_evaluation_report = "eval-2026-02-08"
    config.settings.llm_effective_challenge_id = "mrm-review-2026-02-08"
    config.settings.llm_shadow_completed_at = "2026-02-08T00:00:00Z"
    config.settings.llm_model_version_lock = config.settings.llm_model
    config.settings.llm_adjustment_approved = adjustment_approved


__all__ = (
    "FakeIngestor",
    "NoSignalReasonIngestor",
    "CursorAdvancingFakeIngestor",
    "WarmupIngestor",
    "CursorErrorWarmupIngestor",
    "FetchErrorWarmupIngestor",
    "TransactionAwareWarmupIngestor",
    "RecordingDecisionEngine",
    "RaisingObserveDecisionEngine",
    "FakeAlpacaClient",
    "RejectingAlpacaClient",
    "SellInventoryConflictAlpacaClient",
    "CountingAlpacaClient",
    "PositionedAlpacaClient",
    "OpenOrderAlpacaClient",
    "SellInventoryConflictRetryClient",
    "FakeLLMReviewEngine",
    "CountingLLMReviewEngine",
    "FakePriceFetcher",
    "TimelinePriceFetcher",
    "FakeCircuitBreaker",
)
