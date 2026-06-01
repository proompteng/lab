from __future__ import annotations

import json
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
from app.trading.paper_route_target_plan import paper_route_target_plan_from_payload
from app.trading.reconcile import Reconciler
from app.trading.runtime_decision_authority import (
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
)
from app.trading.risk import RiskEngine
from app.trading.scheduler.pipeline import TradingPipeline
from app.trading.scheduler.simple_pipeline import (
    SimpleTradingPipeline,
    _bounded_sim_collection_metadata_from_decision,
    _paper_route_probe_entry_metadata,
    _paper_route_probe_lineage_from_params,
    _parse_target_datetime,
    _safe_int,
    _target_probe_action,
    _target_probe_window,
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
    ) -> None:
        self.price = price
        self.spread = spread
        self.bid = bid
        self.ask = ask

    def fetch_price(self, signal: SignalEnvelope) -> Decimal:
        return self.price

    def fetch_market_snapshot(self, signal: SignalEnvelope) -> MarketSnapshot:
        return MarketSnapshot(
            symbol=signal.symbol,
            as_of=signal.event_ts,
            price=self.price,
            spread=self.spread,
            source="price_fetcher",
            bid=self.bid,
            ask=self.ask,
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


class TestTradingPipeline(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        from app import config

        self._settings_snapshot = {
            name: getattr(config.settings, name)
            for name in (
                "trading_enabled",
                "trading_mode",
                "trading_live_enabled",
                "trading_autonomy_allow_live_promotion",
                "trading_kill_switch_enabled",
                "trading_universe_source",
                "trading_static_symbols_raw",
                "trading_session_context_warmup_signal_limit",
                "trading_session_context_warmup_max_seconds",
                "trading_session_context_warmup_max_signals",
                "trading_feature_quality_enabled",
                "trading_feature_max_staleness_ms",
                "trading_allow_shorts",
                "trading_fractional_equities_enabled",
                "trading_pipeline_mode",
                "trading_simple_submit_enabled",
                "trading_simple_max_notional_per_order",
                "trading_simple_max_notional_per_symbol",
                "trading_simple_order_feed_telemetry_enabled",
                "trading_order_feed_enabled",
                "trading_order_feed_bootstrap_servers",
                "trading_order_feed_topic",
                "trading_order_feed_topic_v2",
                "trading_order_feed_assignment_mode",
                "trading_order_feed_auto_offset_reset",
                "trading_simple_paper_route_probe_enabled",
                "trading_simple_paper_route_probe_max_notional",
                "trading_simple_paper_route_probe_retry_attempt_limit",
                "trading_simple_paper_route_probe_retry_batch_limit",
                "trading_simple_paper_route_probe_retry_scan_limit",
                "trading_simple_paper_route_probe_exit_lookback_hours",
                "trading_paper_route_target_plan_url",
                "trading_paper_route_target_plan_timeout_seconds",
                "trading_universe_static_fallback_enabled",
                "trading_universe_static_fallback_symbols_raw",
                "trading_market_context_url",
                "trading_market_context_timeout_seconds",
                "trading_market_context_required",
                "trading_market_context_fail_mode",
                "trading_market_context_min_quality",
                "trading_market_context_max_staleness_seconds",
                "llm_enabled",
                "llm_min_confidence",
                "llm_adjustment_allowed",
                "llm_fail_mode",
                "llm_fail_mode_enforcement",
                "llm_abstain_fail_mode",
                "llm_escalate_fail_mode",
                "llm_quality_fail_mode",
                "llm_fail_open_live_approved",
                "llm_shadow_mode",
                "llm_allowed_models_raw",
                "llm_evaluation_report",
                "llm_effective_challenge_id",
                "llm_shadow_completed_at",
                "llm_model_version_lock",
                "llm_adjustment_approved",
                "llm_dspy_runtime_mode",
                "llm_dspy_artifact_hash",
                "llm_dspy_program_name",
                "llm_dspy_signature_version",
                "llm_rollout_stage",
                "llm_dspy_live_runtime_block_fail_mode",
                "llm_dspy_live_runtime_block_qty_multiplier",
                "jangar_base_url",
            )
        }
        config.settings.llm_enabled = False
        config.settings.trading_kill_switch_enabled = False

    def tearDown(self) -> None:
        from app import config

        for name, value in self._settings_snapshot.items():
            setattr(config.settings, name, value)

    def _seed_filled_paper_route_probe_entry(
        self,
        *,
        symbol: str = "AAPL",
        side: Literal["buy", "sell"] = "buy",
        qty: Decimal = Decimal("2"),
        avg_fill_price: Decimal = Decimal("100"),
        entry_ts: datetime = datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        exit_minute_after_open: str = "120",
        include_decision_exit_minute: bool = True,
        source_candidate_ids: Sequence[str] | None = None,
        source_hypothesis_ids: Sequence[str] | None = None,
        source_strategy_names: Sequence[str] | None = None,
        source_decision_mode: str | None = None,
        profit_proof_eligible: bool | None = None,
    ) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name=f"paper-route-exit-{symbol.lower()}",
                description=(
                    "paper route exit fixture\n[catalog_metadata]\n"
                    + json.dumps(
                        {
                            "params": {
                                "entry_minute_after_open": "30",
                                "exit_minute_after_open": exit_minute_after_open,
                            }
                        }
                    )
                ),
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=[symbol],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            params: dict[str, Any] = {
                "price": avg_fill_price,
                "paper_route_probe": {
                    "mode": "paper_route_acquisition",
                    "source": "test",
                    "symbol": symbol,
                },
            }
            paper_route_probe = cast(dict[str, Any], params["paper_route_probe"])
            if source_candidate_ids:
                paper_route_probe["source_candidate_ids"] = list(source_candidate_ids)
            if source_hypothesis_ids:
                paper_route_probe["source_hypothesis_ids"] = list(source_hypothesis_ids)
            if source_strategy_names:
                paper_route_probe["source_strategy_names"] = list(source_strategy_names)
            if source_candidate_ids or source_hypothesis_ids or source_strategy_names:
                paper_route_probe["paper_route_probe_lineage_targets"] = [
                    {
                        key: value
                        for key, value in {
                            "candidate_id": (
                                list(source_candidate_ids or []) or [None]
                            )[0],
                            "hypothesis_id": (
                                list(source_hypothesis_ids or []) or [None]
                            )[0],
                            "strategy_name": (
                                list(source_strategy_names or []) or [None]
                            )[0],
                        }.items()
                        if value is not None
                    }
                ]
            if include_decision_exit_minute:
                params["exit_minute_after_open"] = exit_minute_after_open
            if source_decision_mode is not None:
                params["source_decision_mode"] = source_decision_mode
                paper_route_probe["source_decision_mode"] = source_decision_mode
            if profit_proof_eligible is not None:
                params["profit_proof_eligible"] = profit_proof_eligible
                paper_route_probe["profit_proof_eligible"] = profit_proof_eligible
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol=symbol,
                event_ts=entry_ts,
                timeframe="1Min",
                action=side,
                qty=qty,
                rationale="paper-route-entry",
                params=params,
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            decision_row.status = "submitted"
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)
            session.add(
                Execution(
                    trade_decision_id=decision_row.id,
                    alpaca_account_label="paper",
                    alpaca_order_id=f"filled-entry-{symbol.lower()}",
                    client_order_id=decision_row.decision_hash,
                    symbol=symbol,
                    side=side,
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=qty,
                    filled_qty=qty,
                    avg_fill_price=avg_fill_price,
                    status="filled",
                    raw_order={},
                    created_at=entry_ts + timedelta(seconds=1),
                )
            )
            session.commit()

    def _run_simple_paper_pipeline(
        self,
        *,
        alpaca_client: FakeAlpacaClient,
        now: datetime,
        execution_adapter: Any | None = None,
        proof_floor: Mapping[str, object] | None = None,
        signals: list[SignalEnvelope] | None = None,
    ) -> FakeIngestor:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        floor = proof_floor or {
            "route_state": "repair_only",
            "capital_state": "paper",
            "max_notional": "25",
            "market_window": {"session_open": True},
            "blocking_reasons": ["execution_tca_route_universe_empty"],
            "route_reacquisition_book": {
                "summary": {"paper_route_probe_eligible_symbols": ["AAPL"]}
            },
        }
        ingestor = FakeIngestor(signals or [])
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=ingestor,
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=execution_adapter or alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
        with (
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=floor,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
        ):
            pipeline.run_once()
        return ingestor

    def test_ensure_signal_executable_price_backfills_missing_quote_from_snapshot(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("101.50"),
                spread=Decimal("0.02"),
                bid=Decimal("101.49"),
                ask=Decimal("101.51"),
            ),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("101.50"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Min",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("101.50"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("101.49"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("101.51"))
        self.assertEqual(enriched.payload.get("spread"), Decimal("0.02"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_replaces_feature_price_when_quote_is_backfilled(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("117.36"),
                spread=Decimal("0.40"),
                bid=Decimal("117.10"),
                ask=Decimal("117.50"),
            ),
        )
        pipeline._signal_quote_quality.assess(
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 14, 30, tzinfo=timezone.utc),
                symbol="INTC",
                payload={
                    "price": Decimal("117.20"),
                    "spread": Decimal("0.10"),
                    "imbalance_bid_px": Decimal("117.15"),
                    "imbalance_ask_px": Decimal("117.25"),
                },
                timeframe="1Sec",
            )
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="INTC",
            payload={
                "price": Decimal("83.00"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Sec",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("117.36"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("117.10"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("117.50"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_replaces_stale_spread_when_quote_is_backfilled(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("100.00"),
                spread=Decimal("0.02"),
                bid=Decimal("99.99"),
                ask=Decimal("100.01"),
            ),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={
                "price": Decimal("100.00"),
                "spread": Decimal("1.00"),
                "spread_bps": Decimal("100"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Sec",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("spread"), Decimal("0.02"))
        self.assertEqual(enriched.payload.get("spread_bps"), Decimal("2.00"))
        self.assertEqual(enriched.payload.get("imbalance_spread"), Decimal("0.02"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("99.99"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("100.01"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_replaces_wide_embedded_quote_with_snapshot(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("308.20"),
                spread=Decimal("0.02"),
                bid=Decimal("308.19"),
                ask=Decimal("308.21"),
            ),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("308.21"),
                "spread": Decimal("5.98"),
                "spread_bps": Decimal("194.02355537"),
                "imbalance_bid_px": Decimal("305.22"),
                "imbalance_ask_px": Decimal("311.20"),
                "imbalance_spread": Decimal("5.98"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Sec",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("308.20"))
        self.assertEqual(enriched.payload.get("spread"), Decimal("0.02"))
        self.assertEqual(
            enriched.payload.get("spread_bps"),
            Decimal("0.6489292667099286177806619079"),
        )
        self.assertEqual(enriched.payload.get("imbalance_spread"), Decimal("0.02"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("308.19"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("308.21"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_backfills_missing_price_from_snapshot(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("101.50")),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Min",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("101.50"))

    def test_ensure_signal_executable_price_returns_original_when_snapshot_adds_nothing(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("101.50")),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("101.50"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Min",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertIs(enriched, signal)

    def _build_rejected_outcome_pipeline(
        self,
        *,
        state: TradingState | None = None,
        session_factory: Callable[[], Session] | None = None,
        price_fetcher: PriceFetcher | None = None,
    ) -> TradingPipeline:
        alpaca_client = FakeAlpacaClient()
        return TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=state or TradingState(),
            account_label="paper",
            session_factory=session_factory or self.session_local,
            price_fetcher=price_fetcher or FakePriceFetcher(Decimal("101.50")),
        )

    def test_quote_quality_rejection_records_outcome_learning_event(self) -> None:
        state = TradingState()
        pipeline = self._build_rejected_outcome_pipeline(state=state)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("101.50"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            seq=42,
            timeframe="1Min",
        )

        decisions = pipeline._evaluate_signal_decisions(
            signal,
            [],
            equity=Decimal("100000"),
            positions=[],
        )

        self.assertEqual(decisions, [])
        self.assertEqual(state.metrics.rejected_signal_events_total, 1)
        self.assertEqual(state.metrics.rejected_signal_outcome_label_pending_total, 1)
        self.assertEqual(
            state.metrics.rejected_signal_reason_total,
            {"missing_executable_quote": 1},
        )
        assert state.last_rejected_signal_outcome_event is not None
        self.assertEqual(
            state.last_rejected_signal_outcome_event["schema_version"],
            "torghut.rejected-signal-outcome-event.v1",
        )
        self.assertEqual(
            state.last_rejected_signal_outcome_event["paper_claim_id"],
            "rejection-event-outcome-labels",
        )
        self.assertEqual(
            state.last_rejected_signal_outcome_event["reject_reason"],
            "missing_executable_quote",
        )
        self.assertEqual(
            state.last_rejected_signal_outcome_event["required_outcome_fields"],
            [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ],
        )
        with self.session_local() as session:
            rows = list(session.execute(select(RejectedSignalOutcomeEvent)).scalars())

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].paper_claim_id, "rejection-event-outcome-labels")
        self.assertEqual(rows[0].reject_reason, "missing_executable_quote")
        self.assertEqual(rows[0].outcome_label_status, "pending")
        self.assertEqual(
            rows[0].required_outcome_fields_json,
            [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ],
        )

    def test_rejected_signal_outcome_persistence_skips_unusable_payloads(self) -> None:
        pipeline = self._build_rejected_outcome_pipeline()

        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_ts": "2026-01-01T14:31:00+00:00",
                "symbol": "AAPL",
            }
        )
        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_id": "reject-event-invalid-ts",
                "event_ts": None,
                "symbol": "AAPL",
            }
        )

        with self.session_local() as session:
            rows = list(session.execute(select(RejectedSignalOutcomeEvent)).scalars())

        self.assertEqual(rows, [])

    def test_rejected_signal_outcome_persistence_updates_existing_event(self) -> None:
        pipeline = self._build_rejected_outcome_pipeline()
        event_ts = "2026-01-01T14:31:00+00:00"

        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_id": "reject-event-1",
                "source": "quote_quality_gate",
                "paper_source": "paper-arxiv-2605.12151",
                "paper_claim_id": "rejection-event-outcome-labels",
                "account_label": "paper",
                "symbol": "aapl",
                "event_ts": event_ts,
                "timeframe": "1Min",
                "seq": 42,
                "reject_reason": "missing_executable_quote",
                "spread_bps": "55.5",
                "jump_bps": None,
                "outcome_label_status": "pending",
                "counterfactual_required": True,
                "required_outcome_fields": ["counterfactual_return"],
            }
        )
        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_id": "reject-event-1",
                "source": "quote_quality_gate",
                "paper_source": "paper-arxiv-2605.12151",
                "paper_claim_id": "rejection-event-outcome-labels",
                "account_label": "paper",
                "symbol": "AAPL",
                "event_ts": event_ts,
                "timeframe": "1Min",
                "seq": 42,
                "reject_reason": "wide_spread",
                "spread_bps": "60.25",
                "jump_bps": "4.5",
                "outcome_label_status": "pending",
                "counterfactual_required": True,
                "required_outcome_fields": ["counterfactual_return"],
            }
        )

        with self.session_local() as session:
            rows = list(session.execute(select(RejectedSignalOutcomeEvent)).scalars())

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].reject_reason, "wide_spread")
        self.assertEqual(rows[0].spread_bps, Decimal("60.25"))
        self.assertEqual(rows[0].jump_bps, Decimal("4.5"))
        self.assertEqual(rows[0].event_payload_json["reject_reason"], "wide_spread")

    def test_rejected_signal_outcome_labeler_labels_mature_complete_event(
        self,
    ) -> None:
        event_ts = datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc)
        followup_ts = event_ts + timedelta(minutes=5)
        pipeline = self._build_rejected_outcome_pipeline(
            price_fetcher=TimelinePriceFetcher(
                {
                    event_ts: MarketSnapshot(
                        symbol="AAPL",
                        as_of=event_ts,
                        price=Decimal("100.00"),
                        spread=Decimal("0.02"),
                        source="test-entry",
                        bid=Decimal("99.99"),
                        ask=Decimal("100.01"),
                    ),
                    followup_ts: MarketSnapshot(
                        symbol="AAPL",
                        as_of=followup_ts,
                        price=Decimal("101.00"),
                        spread=Decimal("0.02"),
                        source="test-followup",
                        bid=Decimal("100.99"),
                        ask=Decimal("101.01"),
                    ),
                }
            )
        )
        with self.session_local() as session:
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="reject-event-mature",
                    source="quote_quality_gate",
                    paper_source="ssrn-6607301",
                    paper_claim_id="post-rejection-follow-up-sampling",
                    account_label="paper",
                    symbol="AAPL",
                    event_ts=event_ts,
                    timeframe="1Min",
                    seq="42",
                    reject_reason="missing_executable_quote",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=[
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                        "executable_quote",
                    ],
                    event_payload_json={
                        "event_id": "reject-event-mature",
                        "candidate_spec_id": "spec-feedback",
                        "family_template_id": "breakout_continuation_v1",
                        "runtime_strategy_name": "breakout-continuation-long-v1",
                        "signal_payload": {"price": "100.00"},
                    },
                    outcome_payload_json=None,
                )
            )
            session.commit()

        pipeline._label_mature_rejected_signal_outcome_events(
            now=followup_ts + timedelta(seconds=1)
        )

        with self.session_local() as session:
            row = session.execute(select(RejectedSignalOutcomeEvent)).scalar_one()

        self.assertEqual(row.outcome_label_status, "labeled")
        outcome = row.outcome_payload_json
        self.assertEqual(outcome["counterfactual_return"], "0.01")
        self.assertEqual(outcome["post_cost_net_pnl"], "0.99")
        self.assertEqual(outcome["executable_quote"]["bid"], "99.99")
        self.assertEqual(outcome["route_tca"]["horizon_seconds"], "300")
        self.assertNotIn("promotion_readiness", outcome)
        self.assertEqual(outcome["candidate_spec_id"], "spec-feedback")

    def test_rejected_signal_outcome_labeler_keeps_missing_quote_pending(
        self,
    ) -> None:
        event_ts = datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc)
        pipeline = self._build_rejected_outcome_pipeline(
            price_fetcher=FakePriceFetcher(Decimal("100.00"))
        )
        with self.session_local() as session:
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="reject-event-incomplete",
                    source="quote_quality_gate",
                    paper_source="ssrn-6607301",
                    paper_claim_id="post-rejection-follow-up-sampling",
                    account_label="paper",
                    symbol="AAPL",
                    event_ts=event_ts,
                    timeframe="1Min",
                    seq="42",
                    reject_reason="missing_executable_quote",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=[
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                        "executable_quote",
                    ],
                    event_payload_json={"event_id": "reject-event-incomplete"},
                    outcome_payload_json=None,
                )
            )
            session.commit()

        pipeline._label_mature_rejected_signal_outcome_events(
            now=event_ts + timedelta(minutes=6)
        )

        with self.session_local() as session:
            row = session.execute(select(RejectedSignalOutcomeEvent)).scalar_one()

        self.assertEqual(row.outcome_label_status, "pending")
        self.assertIsNone(row.outcome_payload_json)

    def test_rejected_signal_outcome_persistence_logs_and_continues_on_db_error(
        self,
    ) -> None:
        def failing_session_factory() -> Session:
            raise SQLAlchemyError("db unavailable")

        pipeline = self._build_rejected_outcome_pipeline(
            session_factory=failing_session_factory
        )

        with self.assertLogs("app.trading.scheduler.pipeline", level="ERROR"):
            pipeline._persist_rejected_signal_outcome_event(
                {
                    "event_id": "reject-event-1",
                    "event_ts": "2026-01-01T14:31:00+00:00",
                    "symbol": "AAPL",
                }
            )

    @staticmethod
    def _runtime_ledger_weighted_window_payload(
        *, sample_count: int = 1
    ) -> dict[str, object]:
        return {
            "post_cost_promotion_sample_count": sample_count,
            "post_cost_basis_counts": {
                "realized_strategy_pnl_after_explicit_costs": sample_count
            },
            "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
            "runtime_ledger_notional_weighted_sample_count": sample_count,
        }

    def _runtime_ledger_bucket(
        self,
        *,
        run_id: str = "run-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
        observed_stage: str = "live",
        strategy_family: str = "demo",
        post_cost_expectancy_bps: Decimal = Decimal("2.5"),
        bucket_at: datetime | None = None,
    ) -> StrategyRuntimeLedgerBucket:
        observed_at = bucket_at or datetime.now(timezone.utc)
        return StrategyRuntimeLedgerBucket(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            bucket_started_at=observed_at - timedelta(minutes=15),
            bucket_ended_at=observed_at,
            account_label="live",
            runtime_strategy_name=f"runtime-{candidate_id}",
            strategy_family=strategy_family,
            fill_count=1,
            decision_count=1,
            submitted_order_count=1,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("10000"),
            gross_strategy_pnl=Decimal("3.0"),
            cost_amount=Decimal("0.5"),
            net_strategy_pnl_after_costs=Decimal("2.5"),
            post_cost_expectancy_bps=post_cost_expectancy_bps,
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy": 1},
            cost_model_hash_counts={"cost": 1},
            lineage_hash_counts={"lineage": 1},
            blockers_json=[],
            payload_json={
                "run_id": run_id,
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "observed_stage": observed_stage,
                "strategy_family": strategy_family,
                "submitted_order_count": 1,
                "closed_trade_count": 1,
                "open_position_count": 0,
                "filled_notional": "10000",
                "net_strategy_pnl_after_costs": "2.5",
                "post_cost_expectancy_bps": str(post_cost_expectancy_bps),
                "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                "execution_policy_hash_counts": {"policy": 1},
                "cost_model_hash_counts": {"cost": 1},
                "lineage_hash_counts": {"lineage": 1},
                "blockers": [],
            },
        )

    def _seed_promotion_certificate_evidence(
        self,
        *,
        hypothesis_id: str = "H-CONT-01",
        candidate_id: str = "cand-1",
        capital_stage: str = "0.10x canary",
        strategy_family: str = "demo",
        post_cost_expectancy_bps: Decimal = Decimal("2.5"),
        avg_abs_slippage_bps: Decimal = Decimal("1.0"),
        slippage_budget_bps: Decimal = Decimal("5.0"),
    ) -> None:
        evidence_at = datetime.now(timezone.utc)
        with self.session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    observed_stage="live",
                    window_started_at=evidence_at - timedelta(minutes=15),
                    window_ended_at=evidence_at,
                    market_session_count=1,
                    decision_count=1,
                    trade_count=1,
                    order_count=1,
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    post_cost_expectancy_bps=str(post_cost_expectancy_bps),
                    avg_abs_slippage_bps=str(avg_abs_slippage_bps),
                    slippage_budget_bps=str(slippage_budget_bps),
                    capital_stage=capital_stage,
                    payload_json=self._runtime_ledger_weighted_window_payload(),
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    promotion_target="live",
                    state=capital_stage,
                    allowed=True,
                    reason_summary="ready",
                )
            )
            session.add(
                self._runtime_ledger_bucket(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                    strategy_family=strategy_family,
                    post_cost_expectancy_bps=post_cost_expectancy_bps,
                    bucket_at=evidence_at,
                )
            )
            session.add(
                StrategyHypothesis(
                    hypothesis_id=hypothesis_id,
                    lane_id=f"lane-{candidate_id}",
                    strategy_family=strategy_family,
                    active=True,
                )
            )
            session.add(
                VNextDatasetSnapshot(
                    run_id="run-1",
                    candidate_id=candidate_id,
                    dataset_id=f"dataset-{candidate_id}",
                    source="historical_market_replay",
                    dataset_version="run-1",
                    artifact_ref=f"s3://torghut/empirical/{candidate_id}",
                )
            )
            session.commit()

    def test_hypothesis_runtime_summary_counts_valid_live_runtime_window_certificate(
        self,
    ) -> None:
        self._seed_promotion_certificate_evidence(
            strategy_family="intraday_continuation",
        )

        with self.session_local() as session:
            summary = build_hypothesis_runtime_summary(
                session,
                state=TradingState(),
                market_context_status={},
                tca_summary={"ready": True},
            )

        self.assertEqual(summary.get("promotion_eligible_total"), 1)
        self.assertEqual(
            summary.get("capital_stage_totals"), {"0.10x canary": 1, "shadow": 5}
        )
        items = [
            cast(Mapping[str, object], item)
            for item in cast(list[object], summary.get("items") or [])
            if isinstance(item, Mapping)
        ]
        continuation = next(
            item for item in items if item.get("hypothesis_id") == "H-CONT-01"
        )
        self.assertEqual(continuation.get("state"), "canary_live")
        self.assertEqual(continuation.get("capital_stage"), "0.10x canary")
        self.assertEqual(continuation.get("capital_multiplier"), "0.10")
        self.assertTrue(continuation.get("promotion_eligible"))
        self.assertEqual(continuation.get("reasons"), [])
        observed = continuation.get("observed")
        self.assertIsInstance(observed, Mapping)
        self.assertTrue(
            cast(Mapping[str, object], observed).get(
                "runtime_window_certificate_applied"
            )
        )

    def test_hypothesis_runtime_summary_rejects_mismatched_runtime_ledger_family(
        self,
    ) -> None:
        self._seed_promotion_certificate_evidence(strategy_family="unregistered_demo")

        with self.session_local() as session:
            summary = build_hypothesis_runtime_summary(
                session,
                state=TradingState(),
                market_context_status={},
                tca_summary={"ready": True},
            )

        self.assertEqual(summary.get("promotion_eligible_total"), 0)
        items = [
            cast(Mapping[str, object], item)
            for item in cast(list[object], summary.get("items") or [])
            if isinstance(item, Mapping)
        ]
        continuation = next(
            item for item in items if item.get("hypothesis_id") == "H-CONT-01"
        )
        self.assertFalse(continuation.get("promotion_eligible"))
        self.assertIn(
            "runtime_ledger_strategy_family_mismatch",
            continuation.get("reasons") or [],
        )
        observed = continuation.get("observed")
        self.assertIsInstance(observed, Mapping)
        observed_map = cast(Mapping[str, object], observed)
        self.assertTrue(observed_map.get("runtime_window_certificate_rejected"))
        self.assertEqual(
            observed_map.get("runtime_window_rejection_reasons"),
            ["runtime_ledger_strategy_family_mismatch"],
        )

    def _build_warmup_pipeline(
        self,
        *,
        ingestor: WarmupIngestor,
        decision_engine: DecisionEngine | None = None,
    ) -> TradingPipeline:
        return TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=ingestor,
            decision_engine=decision_engine or DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

    def _healthy_quant_status(
        self, *, account_label: str = "live"
    ) -> dict[str, object]:
        return {
            "required": True,
            "ok": True,
            "status": "healthy",
            "reason": "ready",
            "blocking_reasons": [],
            "account": account_label,
            "window": "15m",
            "source_url": (
                "http://jangar.test/api/torghut/trading/control-plane/quant/health"
                f"?account={account_label}&window=15m"
            ),
            "latest_metrics_count": 12,
            "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
        }

    def _healthy_live_quant_status(self) -> dict[str, object]:
        return self._healthy_quant_status(account_label="live")

    def test_pipeline_empty_signal_batch_commits_cursor(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="empty-signal regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            ingestor = FakeIngestor([])
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            self.assertEqual(ingestor.committed_batches, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]

    def test_simple_pipeline_snapshots_account_for_paper_route_window_without_signals(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            session.add(
                Strategy(
                    name="paper-route-window-snapshot",
                    description="pre-open account snapshot regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
            )
            session.commit()

        alpaca_client = CountingAlpacaClient()
        ingestor = FakeIngestor([])
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=ingestor,
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: False  # type: ignore[method-assign]

        with patch(
            "app.trading.scheduler.pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
        ):
            pipeline.run_once()
            pipeline.run_once()

        with self.session_local() as session:
            snapshots = session.scalars(select(PositionSnapshot)).all()

        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].alpaca_account_label, "TORGHUT_SIM")
        self.assertEqual(alpaca_client.account_calls, 1)
        self.assertEqual(alpaca_client.position_calls, 1)
        self.assertEqual(ingestor.committed_batches, 2)

    def test_runtime_window_account_snapshot_skips_existing_snapshot(self) -> None:
        from app import config

        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = ""

        alpaca_client = CountingAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            session.add(
                PositionSnapshot(
                    alpaca_account_label="TORGHUT_SIM",
                    as_of=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
                    equity=Decimal("100000"),
                    cash=Decimal("100000"),
                    buying_power=Decimal("200000"),
                    positions=[],
                )
            )
            session.commit()

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
            ):
                pipeline._capture_runtime_window_account_snapshot_if_due(session)

        self.assertEqual(
            pipeline._runtime_window_account_snapshot_day, date(2026, 3, 26)
        )
        self.assertEqual(alpaca_client.account_calls, 0)
        self.assertEqual(alpaca_client.position_calls, 0)

    def test_runtime_window_account_snapshot_rolls_back_capture_failure(self) -> None:
        from app import config

        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = ""

        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._get_account_snapshot = Mock(  # type: ignore[method-assign]
            side_effect=RuntimeError("broker unavailable")
        )

        with self.session_local() as session:
            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 13, 20, tzinfo=timezone.utc),
            ):
                with self.assertLogs(
                    "app.trading.scheduler.pipeline",
                    level="ERROR",
                ) as logs:
                    pipeline._capture_runtime_window_account_snapshot_if_due(session)

            snapshot_count = session.query(PositionSnapshot).count()

        self.assertEqual(snapshot_count, 0)
        self.assertIsNone(pipeline._runtime_window_account_snapshot_day)
        self.assertTrue(
            any(
                "Failed to capture runtime-window account snapshot" in message
                for message in logs.output
            )
        )

    def test_pipeline_warms_session_context_with_bounded_replay_window(self) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_session_context_warmup_signal_limit = 3

        with self.session_local() as session:
            strategy = Strategy(
                name="warmup-demo",
                description="session warmup regression",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        warmup_signals = [
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 0, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=2,
                payload={"feature_schema_version": "3.0.0", "price": 101},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 26, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 26, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=3,
                payload={"feature_schema_version": "3.0.0", "price": 102},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 27, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 27, 1, tzinfo=timezone.utc),
                symbol="MSFT",
                timeframe="1Min",
                seq=4,
                payload={"feature_schema_version": "3.0.0", "price": 250},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 14, 28, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 14, 28, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=5,
                payload={"feature_schema_version": "3.0.0", "price": 103},
            ),
        ]
        cursor_at = datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc)
        ingestor = WarmupIngestor(
            warmup_signals=warmup_signals,
            signals=[],
            cursor_at=cursor_at,
        )
        decision_engine = RecordingDecisionEngine()
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=ingestor,
            decision_engine=decision_engine,
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = (  # type: ignore[method-assign]
            lambda _now=None: True
        )

        with patch(
            "app.trading.scheduler.pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
        ):
            pipeline.run_once()
            pipeline.run_once()

        self.assertEqual(
            ingestor.warmup_ranges,
            [
                (
                    datetime(2026, 3, 26, 14, 25, tzinfo=timezone.utc),
                    cursor_at,
                )
            ],
        )
        self.assertEqual(ingestor.warmup_limits, [3])
        self.assertEqual(decision_engine.observed_symbols, ["AAPL", "AAPL"])
        self.assertEqual(ingestor.committed_batches, 2)

    def test_session_context_warmup_closes_transaction_before_replay_fetch(
        self,
    ) -> None:
        warmup_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 45, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 45, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={"feature_schema_version": "3.0.0", "price": 100},
        )
        with self.session_local() as session:
            session.execute(select(Strategy).limit(1)).all()
            self.assertTrue(session.in_transaction())
            ingestor = TransactionAwareWarmupIngestor(
                warmup_signals=[warmup_signal],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
                transaction_probe=session.in_transaction,
            )
            pipeline = self._build_warmup_pipeline(ingestor=ingestor)

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

        self.assertFalse(ingestor.transaction_active_during_fetch)

    def test_session_context_warmup_rolls_back_when_transaction_close_fails(
        self,
    ) -> None:
        ingestor = WarmupIngestor(
            warmup_signals=[],
            signals=[],
            cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        )
        pipeline = self._build_warmup_pipeline(ingestor=ingestor)
        session = Mock(spec=Session)
        session.commit.side_effect = RuntimeError("commit failed")

        with patch(
            "app.trading.scheduler.pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
        ):
            pipeline._warm_session_context_from_open(cast(Session, session))

        session.rollback.assert_called_once()
        self.assertEqual(ingestor.warmup_ranges, [])
        self.assertIsNone(pipeline._session_context_warmup_day)

    def test_session_context_warmup_ignores_preopen_and_empty_cursor_windows(
        self,
    ) -> None:
        ingestor = WarmupIngestor(
            warmup_signals=[],
            signals=[],
            cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        )
        pipeline = self._build_warmup_pipeline(ingestor=ingestor)

        with self.session_local() as session:
            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 12, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

            ingestor.cursor_at = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

        self.assertEqual(ingestor.warmup_ranges, [])

    def test_session_context_warmup_handles_cursor_and_fetch_errors(self) -> None:
        for ingestor in (
            CursorErrorWarmupIngestor(
                warmup_signals=[],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
            FetchErrorWarmupIngestor(
                warmup_signals=[],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
        ):
            pipeline = self._build_warmup_pipeline(ingestor=ingestor)
            with self.session_local() as session:
                with patch(
                    "app.trading.scheduler.pipeline.trading_now",
                    return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
                ):
                    pipeline._warm_session_context_from_open(session)

            self.assertIsNone(pipeline._session_context_warmup_day)

    def test_session_context_warmup_normalizes_naive_cursor_and_skips_bad_signals(
        self,
    ) -> None:
        warmup_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 45, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 45, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={"feature_schema_version": "3.0.0", "price": 100},
        )
        ingestor = WarmupIngestor(
            warmup_signals=[warmup_signal],
            signals=[],
            cursor_at=datetime(2026, 3, 26, 14, 0),
        )
        pipeline = self._build_warmup_pipeline(
            ingestor=ingestor,
            decision_engine=RaisingObserveDecisionEngine(),
        )

        with self.session_local() as session:
            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 15, 0, tzinfo=timezone.utc),
            ):
                pipeline._warm_session_context_from_open(session)

        self.assertEqual(
            ingestor.warmup_ranges,
            [
                (
                    datetime(2026, 3, 26, 13, 55, tzinfo=timezone.utc),
                    datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
                )
            ],
        )
        self.assertEqual(
            pipeline._session_context_warmup_day,
            datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
        )

    def test_simple_pipeline_submits_live_order_when_shared_gate_allows_and_persists_lane_metadata(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live",
                description="simple live lane",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_live_submission_gate",
                return_value={
                    "allowed": True,
                    "reason": "promotion_certificate_valid",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                    "profit_window_contract": {
                        "summary": {"windows_total": 1},
                    },
                },
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value={
                    "route_state": "paper_ready",
                    "capital_state": "paper",
                    "max_notional": "1000",
                    "blocking_reasons": [],
                },
            ),
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["type"], "limit")
        self.assertEqual(pipeline.state.metrics.feature_batch_rows_total, 1)
        self.assertEqual(pipeline.state.metrics.feature_quality_rejections_total, 0)
        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 1)
        self.assertIsNotNone(pipeline.state.drift_last_detection_at)
        self.assertFalse(pipeline.state.drift_live_promotion_eligible)
        self.assertEqual(pipeline.state.drift_status, "unknown")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            execution_audit = cast(dict[str, Any], execution.execution_audit_json)
            self.assertEqual(decision.status, "submitted")
            self.assertEqual(execution.order_type, "limit")
            self.assertEqual(params.get("execution_lane"), "simple")
            self.assertEqual(params.get("submit_path"), "direct_alpaca")
            execution_policy = cast(dict[str, Any], params.get("execution_policy"))
            self.assertEqual(execution_policy.get("selected_order_type"), "limit")
            self.assertEqual(control_plane.get("execution_lane"), "simple")
            self.assertEqual(control_plane.get("pipeline_mode"), "simple")
            self.assertEqual(execution_audit.get("execution_lane"), "simple")
            self.assertEqual(execution_audit.get("submit_path"), "direct_alpaca")

    def test_simple_pipeline_paper_order_updates_proof_counters_without_live_promotion(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_drift_governance_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-counters",
                description="simple paper lane proof counter regression",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "paper_ready",
                "capital_state": "paper",
                "max_notional": "1000",
                "blocking_reasons": [],
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["type"], "limit")
        self.assertEqual(pipeline.state.metrics.feature_batch_rows_total, 1)
        self.assertEqual(pipeline.state.metrics.feature_quality_rejections_total, 0)
        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 1)
        self.assertIsNotNone(pipeline.state.drift_last_detection_at)
        self.assertFalse(pipeline.state.drift_live_promotion_eligible)
        self.assertEqual(pipeline.state.drift_status, "unknown")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            self.assertEqual(decision.status, "submitted")
            self.assertEqual(execution.order_type, "limit")
            self.assertEqual(params.get("execution_lane"), "simple")
            self.assertEqual(params.get("submit_path"), "direct_alpaca")
            execution_policy = cast(dict[str, Any], params.get("execution_policy"))
            self.assertEqual(execution_policy.get("selected_order_type"), "limit")
            self.assertEqual(
                control_plane.get("live_submission_gate", {}).get("reason"),
                "non_live_mode",
            )

    def test_simple_pipeline_refreshes_market_context_before_profitability_floor(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_order_feed_telemetry_enabled = True
        config.settings.trading_order_feed_enabled = True
        config.settings.trading_order_feed_bootstrap_servers = "kafka:9092"
        config.settings.trading_order_feed_topic = "torghut.trade-updates.v1"
        config.settings.trading_order_feed_topic_v2 = None
        config.settings.trading_order_feed_assignment_mode = "manual"
        config.settings.trading_order_feed_auto_offset_reset = "latest"
        config.settings.trading_market_context_url = "http://market-context.test/api"
        config.settings.trading_market_context_timeout_seconds = 1
        config.settings.trading_market_context_max_staleness_seconds = 300
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        class _MarketContextClient:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def fetch(
                self, symbol: str, *, as_of: datetime | None = None
            ) -> MarketContextBundle:
                del as_of
                self.calls.append(symbol)
                return _market_context_bundle(symbol=symbol)

        class _UniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols={"AAPL"})

        captured_market_context: dict[str, object] = {}
        fake_market_context = _MarketContextClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline.market_context_client = cast(Any, fake_market_context)
        pipeline.universe_resolver = cast(Any, _UniverseResolver())
        pipeline.state.market_session_open = True
        now = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)

        def _healthy_hypotheses(
            session: Session,
            *,
            state: object,
            market_context_status: dict[str, object],
        ) -> dict[str, object]:
            del session, state
            captured_market_context.update(market_context_status)
            return {
                "summary": {
                    "promotion_eligible_total": 1,
                    "rollback_required_total": 0,
                    "state_totals": {"canary_live": 1},
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "promotion_contract": {
                            "max_avg_abs_slippage_bps": "12",
                            "observed_post_cost_expectancy_bps": "8",
                            "capacity_daily_notional": "1000000",
                            "drawdown_budget": "500",
                            "allocated_sleeve_equity": "100000",
                        },
                    }
                ],
            }

        with (
            self.session_local() as session,
            patch(
                "app.trading.scheduler.simple_pipeline.build_hypothesis_runtime_summary",
                side_effect=_healthy_hypotheses,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_empirical_jobs_status",
                return_value={"ready": True, "status": "healthy"},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.load_quant_evidence_status",
                return_value=self._healthy_quant_status(account_label="paper"),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_live_submission_gate",
                return_value={
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "capital_stage": "paper",
                },
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_tca_gate_inputs",
                return_value={
                    "order_count": 40,
                    "filled_execution_count": 40,
                    "unsettled_execution_count": 0,
                    "latest_execution_created_at": now.isoformat(),
                    "last_computed_at": now.isoformat(),
                    "avg_abs_slippage_bps": "5.0",
                    "scope_symbols": ["AAPL"],
                    "scope_symbol_count": 1,
                    "symbol_breakdown": [
                        {
                            "symbol": "AAPL",
                            "order_count": 40,
                            "avg_abs_slippage_bps": "5.0",
                            "max_abs_slippage_bps": "7.0",
                            "last_computed_at": now.isoformat(),
                        }
                    ],
                },
            ),
        ):
            receipt = pipeline._profitability_proof_floor(session=session)

        self.assertEqual(fake_market_context.calls, ["AAPL"])
        self.assertEqual(pipeline.state.last_market_context_symbol, "AAPL")
        self.assertEqual(captured_market_context["last_freshness_seconds"], 20)
        last_domain_states = cast(
            dict[str, str], captured_market_context["last_domain_states"]
        )
        self.assertEqual(last_domain_states, {"technicals": "ok", "regime": "ok"})
        self.assertEqual(receipt["floor_state"], "paper_ready")
        proof_dimensions = cast(list[dict[str, object]], receipt["proof_dimensions"])
        dimensions = {cast(str, item["dimension"]): item for item in proof_dimensions}
        self.assertEqual(dimensions["market_context"]["state"], "pass")
        self.assertEqual(dimensions["target_notional_sizing"]["state"], "pass")

    def test_simple_pipeline_refreshes_market_context_during_prepare_run_once(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_market_context_url = "http://market-context.test/api"
        config.settings.trading_market_context_timeout_seconds = 1
        config.settings.trading_market_context_max_staleness_seconds = 300
        config.settings.trading_market_context_min_quality = 0.4
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        class _MarketContextClient:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def fetch(
                self, symbol: str, *, as_of: datetime | None = None
            ) -> MarketContextBundle:
                del as_of
                self.calls.append(symbol)
                return _market_context_bundle(symbol=symbol)

        class _UniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols={"AAPL"})

        fake_market_context = _MarketContextClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline.market_context_client = cast(Any, fake_market_context)
        pipeline.universe_resolver = cast(Any, _UniverseResolver())

        with self.session_local() as session:
            strategies = pipeline._prepare_run_once(session)

        self.assertEqual(strategies, [])
        self.assertEqual(fake_market_context.calls, ["AAPL"])
        self.assertEqual(pipeline.state.last_market_context_symbol, "AAPL")
        self.assertIsNotNone(pipeline.state.last_market_context_checked_at)
        self.assertEqual(pipeline.state.last_market_context_freshness_seconds, 20)

    def test_simple_pipeline_market_context_refresh_skips_recent_or_fresh_state(
        self,
    ) -> None:
        from app import config

        config.settings.trading_market_context_url = "http://market-context.test/api"
        config.settings.trading_market_context_max_staleness_seconds = 300
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

        fetch_calls: list[str] = []

        def _fetch(symbol: str) -> tuple[MarketContextBundle | None, str | None]:
            fetch_calls.append(symbol)
            return _market_context_bundle(symbol=symbol), None

        pipeline._fetch_market_context = _fetch  # type: ignore[method-assign]
        now = datetime.now(timezone.utc)
        pipeline.state.last_market_context_checked_at = now - timedelta(seconds=15)

        self.assertTrue(pipeline._market_context_refresh_recent(now))
        pipeline._refresh_market_context_for_proof_floor()
        self.assertEqual(fetch_calls, [])

        now = datetime.now(timezone.utc)
        pipeline.state.last_market_context_checked_at = now - timedelta(seconds=60)
        pipeline.state.last_market_context_as_of = now - timedelta(seconds=30)
        pipeline.state.last_market_context_freshness_seconds = 30
        pipeline.state.market_context_alert_active = False
        pipeline._refresh_market_context_for_proof_floor()

        self.assertEqual(fetch_calls, [])
        self.assertGreaterEqual(
            cast(int, pipeline.state.last_market_context_freshness_seconds),
            0,
        )

    def test_simple_pipeline_market_context_probe_symbol_fallbacks(self) -> None:
        class _EmptyUniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols={"", "   "})

        class _FailingUniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                raise RuntimeError("universe unavailable")

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

        pipeline.state.last_market_context_symbol = " nvda "
        self.assertEqual(pipeline._market_context_probe_symbol(), "NVDA")

        pipeline.state.last_market_context_symbol = None
        pipeline.universe_resolver = cast(Any, _EmptyUniverseResolver())
        self.assertIsNone(pipeline._market_context_probe_symbol())

        pipeline.universe_resolver = cast(Any, _FailingUniverseResolver())
        self.assertIsNone(pipeline._market_context_probe_symbol())

    def test_simple_pipeline_market_context_refresh_handles_empty_probe_symbol(
        self,
    ) -> None:
        from app import config

        class _EmptyUniverseResolver:
            @staticmethod
            def get_resolution() -> SimpleNamespace:
                return SimpleNamespace(symbols=set())

        config.settings.trading_market_context_url = "http://market-context.test/api"
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline.universe_resolver = cast(Any, _EmptyUniverseResolver())
        pipeline._refresh_market_context_for_proof_floor()

        self.assertIsNone(pipeline.state.last_market_context_symbol)

    def test_simple_pipeline_drift_check_skip_does_not_mutate_promotion_state(
        self,
    ) -> None:
        from app import config

        original_enabled = config.settings.trading_drift_governance_enabled
        config.settings.trading_drift_governance_enabled = False
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline.state.drift_live_promotion_eligible = True
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        try:
            pipeline._run_simple_drift_check([signal])
        finally:
            config.settings.trading_drift_governance_enabled = original_enabled

        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 0)
        self.assertIsNone(pipeline.state.drift_last_detection_at)
        self.assertTrue(pipeline.state.drift_live_promotion_eligible)

    def test_simple_pipeline_detected_drift_blocks_promotion_state(self) -> None:
        from app import config

        config.settings.trading_drift_governance_enabled = True
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline.state.drift_live_promotion_eligible = True
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "price": 100,
            },
        )

        pipeline._run_simple_drift_check([signal])

        self.assertEqual(pipeline.state.metrics.drift_detection_checks_total, 1)
        self.assertEqual(pipeline.state.metrics.drift_incidents_total, 1)
        self.assertIsNotNone(pipeline.state.drift_active_incident_id)
        self.assertIn(
            "data_required_null_rate_exceeded",
            pipeline.state.drift_active_reason_codes,
        )
        self.assertEqual(pipeline.state.drift_status, "drift_detected")
        self.assertFalse(pipeline.state.drift_live_promotion_eligible)
        self.assertIn(
            "data_required_null_rate_exceeded",
            pipeline.state.drift_live_promotion_reasons,
        )
        self.assertEqual(
            pipeline.state.metrics.drift_incident_reason_total[
                "data_required_null_rate_exceeded"
            ],
            1,
        )

    def test_simple_pipeline_blocks_live_order_when_shared_gate_blocks(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live-blocked",
                description="simple live lane blocked by shared gate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch.object(
            SimpleTradingPipeline,
            "_live_submission_gate",
            return_value={
                "allowed": False,
                "reason": "profit_window_underfunded",
                "blocked_reasons": ["profit_window_underfunded"],
                "capital_stage": "shadow",
                "capital_state": "observe",
                "profit_window_contract": {
                    "summary": {"windows_total": 1},
                },
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            gate = cast(dict[str, Any], control_plane.get("live_submission_gate"))
            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "profit_window_underfunded",
            )
            self.assertEqual(gate.get("reason"), "profit_window_underfunded")

    def test_simple_pipeline_blocks_live_order_when_simple_submit_disabled_with_shared_gate_metadata(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = False
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live-submit-disabled",
                description="simple live lane keeps shared gate metadata",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch.object(
            TradingPipeline,
            "_live_submission_gate",
            return_value={
                "allowed": True,
                "reason": "promotion_certificate_valid",
                "blocked_reasons": [],
                "capital_stage": "live",
                "capital_state": "live",
                "profit_window_contract": {
                    "summary": {"windows_total": 1},
                },
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            gate = cast(dict[str, Any], control_plane.get("live_submission_gate"))
            simple_lane = cast(dict[str, Any], gate.get("simple_lane"))
            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "simple_submit_disabled",
            )
            self.assertEqual(gate.get("reason"), "simple_submit_disabled")
            self.assertEqual(
                gate.get("profit_window_contract", {}).get("summary"),
                {"windows_total": 1},
            )
            self.assertEqual(simple_lane.get("shared_gate_enforced"), True)
            self.assertEqual(
                simple_lane.get("blocked_reasons"), ["simple_submit_disabled"]
            )

    def test_simple_pipeline_blocks_paper_order_when_profitability_floor_zero_notional(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-floor-blocked",
                description="simple paper lane blocked by proof floor",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            },
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            control_plane = cast(
                dict[str, Any], decision_json.get("control_plane_snapshot")
            )
            proof_floor = cast(
                dict[str, Any], decision_json.get("profitability_proof_floor")
            )
            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_stage"),
                "blocked_profitability_proof_floor",
            )
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertEqual(proof_floor.get("capital_state"), "zero_notional")
            self.assertEqual(control_plane.get("execution_lane"), "simple")

    def test_simple_pipeline_blocks_unscoped_order_during_bounded_target_window(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"

        strategy_id = uuid4()
        strategy = Strategy(
            id=strategy_id,
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        target: dict[str, Any] = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": strategy.name,
            "runtime_strategy_name": strategy.name,
            "strategy_lookup_names": [str(strategy_id), strategy.name],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_SIM",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "250",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "evidence_collection_ok": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "source_decision_readiness": {"ready": True, "blockers": []},
        }
        proof_floor = {
            "route_state": "collecting",
            "capital_state": "paper",
            "max_notional": "250",
            "market_window": {"session_open": True},
            "blocking_reasons": [],
        }
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        unscoped_decision = StrategyDecision(
            strategy_id=str(strategy_id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="unscoped target-window order",
            params={"price": "100"},
        )
        scoped_metadata = (
            SimpleTradingPipeline._paper_route_target_source_decision_metadata(
                target=target,
                strategy=strategy,
                symbol="AAPL",
                window_start=window_start,
                window_end=window_end,
                max_notional=Decimal("250"),
            )
        )
        scoped_decision = unscoped_decision.model_copy(
            update={
                "params": {
                    "price": "100",
                    "paper_route_target_plan_source_decision": scoped_metadata,
                }
            }
        )

        with self.session_local() as session:
            unscoped_row = TradeDecision(
                strategy_id=strategy_id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=unscoped_decision.model_dump(mode="json"),
                status="planned",
            )
            scoped_row = TradeDecision(
                strategy_id=strategy_id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=scoped_decision.model_dump(mode="json"),
                status="planned",
            )
            session.add_all([unscoped_row, scoped_row])
            session.commit()

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL"}, None, [target]),
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value=proof_floor,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                self.assertFalse(
                    pipeline._is_trading_submission_allowed(
                        session=session,
                        decision=unscoped_decision,
                        decision_row=unscoped_row,
                    )
                )
                self.assertTrue(
                    pipeline._is_trading_submission_allowed(
                        session=session,
                        decision=scoped_decision,
                        decision_row=scoped_row,
                    )
                )

            session.refresh(unscoped_row)
            session.refresh(scoped_row)
            unscoped_json = cast(dict[str, Any], unscoped_row.decision_json)
            scoped_json = cast(dict[str, Any], scoped_row.decision_json)

        self.assertEqual(unscoped_row.status, "blocked")
        self.assertEqual(
            unscoped_json.get("submission_stage"),
            "blocked_paper_route_target_window_unscoped",
        )
        self.assertEqual(
            unscoped_json.get("submission_block_reason"),
            "paper_route_target_window_requires_scoped_source_decision",
        )
        target_window = cast(
            dict[str, Any], unscoped_json.get("paper_route_target_window")
        )
        self.assertEqual(target_window.get("symbol"), "AAPL")
        self.assertEqual(target_window.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(scoped_row.status, "planned")
        self.assertNotIn("submission_block_reason", scoped_json)

    def test_strategy_signal_paper_collection_bypasses_repair_only_floor(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"

        strategy_id = uuid4()
        strategy = Strategy(
            id=strategy_id,
            name="microbar-cross-sectional-pairs-v1",
            description="bounded strategy-signal collection",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("75000"),
        )
        target: dict[str, Any] = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": strategy.name,
            "runtime_strategy_name": strategy.name,
            "strategy_lookup_names": [str(strategy_id), strategy.name],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_pair_balance_state": "balanced",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "evidence_collection_ok": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        base_decision = StrategyDecision(
            strategy_id=str(strategy_id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded strategy-signal paper collection",
            params={"price": "100"},
        )
        metadata = SimpleTradingPipeline._strategy_signal_paper_metadata(
            decision=base_decision,
            target=target,
            strategy=strategy,
        )
        blocked_metadata = SimpleTradingPipeline._strategy_signal_paper_metadata(
            decision=base_decision,
            target={
                **target,
                "paper_route_account_pre_session_blockers": [
                    "unlinked_order_events_present",
                ],
            },
            strategy=strategy,
        )
        self.assertEqual(
            blocked_metadata.get("paper_route_account_pre_session_blockers"),
            ["unlinked_order_events_present"],
        )
        decision = base_decision.model_copy(
            update={
                "params": {
                    "price": "100",
                    "paper_route_target_plan": metadata,
                    "strategy_signal_paper": metadata,
                    "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                    "profit_proof_eligible": True,
                }
            }
        )
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
        }
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            row = TradeDecision(
                strategy_id=strategy_id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json=decision.model_dump(mode="json"),
                status="planned",
            )
            session.add(row)
            session.commit()

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value=proof_floor,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                self.assertTrue(
                    pipeline._is_trading_submission_allowed(
                        session=session,
                        decision=decision,
                        decision_row=row,
                    )
                )

            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)

        self.assertEqual(row.status, "planned")
        self.assertNotIn("submission_block_reason", row_json)

    def test_strategy_signal_paper_collection_reopens_prior_profit_floor_block(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"

        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded strategy-signal collection",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("75000"),
        )
        target: dict[str, Any] = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": strategy.name,
            "runtime_strategy_name": strategy.name,
            "strategy_lookup_names": [str(strategy.id), strategy.name],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_pair_balance_state": "balanced",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "evidence_collection_ok": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded strategy-signal paper collection",
            params={"price": "100"},
        )
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
        }
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            row = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                "TORGHUT_SIM",
            )
            blocked_json = dict(cast(Mapping[str, Any], row.decision_json))
            blocked_json["params"] = {
                "price": "100",
                "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                "profit_proof_eligible": True,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
            }
            blocked_json["submission_stage"] = "blocked_profitability_proof_floor"
            blocked_json["submission_block_reason"] = (
                "alpha_readiness_not_promotion_eligible"
            )
            blocked_json["profitability_proof_floor"] = proof_floor
            row.status = "blocked"
            row.decision_json = blocked_json
            session.add(row)
            session.commit()

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value=proof_floor,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                reopened = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(reopened)
            assert reopened is not None
            session.refresh(reopened)
            row_json = cast(dict[str, Any], reopened.decision_json)
            params = cast(dict[str, Any], row_json.get("params"))
            retry = cast(dict[str, Any], row_json.get("bounded_sim_collection_retry"))

        self.assertEqual(reopened.status, "planned")
        self.assertEqual(
            row_json.get("submission_stage"),
            "bounded_sim_collection_retry_pending",
        )
        self.assertNotIn("submission_block_reason", row_json)
        self.assertEqual(row_json.get("paper_route_probe_retry_attempts"), 1)
        self.assertEqual(
            retry.get("previous_submission_block_reason"),
            "alpha_readiness_not_promotion_eligible",
        )
        self.assertEqual(params.get("source_decision_mode"), "strategy_signal_paper")
        self.assertFalse(params.get("promotion_allowed"))
        self.assertFalse(params.get("final_promotion_allowed"))
        self.assertFalse(params.get("final_promotion_authorized"))
        self.assertIsNotNone(
            _bounded_sim_collection_metadata_from_decision(
                StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=now,
                    timeframe="1Sec",
                    action="sell",
                    qty=Decimal("1"),
                    params=params,
                ),
                account_label="TORGHUT_SIM",
                trading_mode="paper",
            )
        )

    def test_simple_pipeline_retry_metadata_requires_prior_profit_floor_block(
        self,
    ) -> None:
        def decision_row(
            *,
            status: str = "blocked",
            decision_json: object,
        ) -> TradeDecision:
            return TradeDecision(
                strategy_id=uuid4(),
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=decision_json,
                status=status,
            )

        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    status="planned",
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                        "profitability_proof_floor": {},
                    },
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(decision_json=["not", "a", "mapping"])
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_other",
                        "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                        "profitability_proof_floor": {},
                    }
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "",
                        "profitability_proof_floor": {},
                    }
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                        "profitability_proof_floor": "not-a-mapping",
                    }
                )
            )
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                        "profitability_proof_floor": {"route_state": "repair_only"},
                    }
                )
            ),
            {
                "previous_submission_stage": "blocked_profitability_proof_floor",
                "previous_submission_block_reason": "alpha_readiness_not_promotion_eligible",
                "previous_decision_status": "blocked",
                "previous_paper_route_probe_retry_attempts": 0,
            },
        )

        from app import config

        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 1
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                        "paper_route_probe_retry_attempts": 1,
                        "profitability_proof_floor": {"route_state": "repair_only"},
                    }
                )
            )
        )

    def test_simple_pipeline_target_price_retry_metadata_requires_price_null_precheck(
        self,
    ) -> None:
        def decision_row(
            *,
            status: str = "rejected",
            decision_json: object,
        ) -> TradeDecision:
            return TradeDecision(
                strategy_id=uuid4(),
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=decision_json,
                status=status,
            )

        base_params: dict[str, Any] = {
            "paper_route_target_plan": {
                "candidate_id": "candidate-1",
                "hypothesis_id": "H-PAIRS-01",
            },
            "simple_lane_precheck": {
                "price": None,
                "requested_qty": "1",
            },
        }
        base_json: dict[str, Any] = {
            "submission_stage": "rejected_pre_submit",
            "risk_reasons": ["broker_precheck_failed"],
            "params": base_params,
        }
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(status="planned", decision_json=base_json)
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(
                    decision_json={
                        **base_json,
                        "params": {
                            **base_params,
                            "simple_lane_precheck": {"price": "100"},
                        },
                    }
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(
                    decision_json={
                        **base_json,
                        "risk_reasons": ["max_notional_exceeded"],
                    }
                )
            )
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(decision_json=base_json)
            ),
            {
                "previous_decision_status": "rejected",
                "previous_submission_stage": "rejected_pre_submit",
                "previous_risk_reasons": ["broker_precheck_failed"],
                "previous_retry_attempts": 0,
            },
        )

        from app import config

        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 1
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(
                    decision_json={
                        **base_json,
                        "paper_route_target_price_retry_attempts": 1,
                    }
                )
            )
        )

    def test_simple_pipeline_reopens_price_null_target_source_decision(self) -> None:
        from app import config

        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-target-price-retry",
                description="simple paper target source price retry",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="paper-route-target-source",
                params={
                    "paper_route_target_plan": {
                        "candidate_id": "candidate-1",
                        "hypothesis_id": "H-PAIRS-01",
                    },
                    "source_decision_mode": "route_acquisition_probe",
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
            params = dict(cast(Mapping[str, Any], decision_json.get("params") or {}))
            params["simple_lane_precheck"] = {
                "price": None,
                "requested_qty": "1",
            }
            decision_json.update(
                {
                    "params": params,
                    "submission_stage": "rejected_pre_submit",
                    "risk_reasons": ["broker_precheck_failed"],
                    "reject_reason_atomic": ["broker_precheck_failed"],
                    "reject_class": "runtime",
                    "reject_origin": "scheduler",
                }
            )
            decision_row.status = "rejected"
            decision_row.decision_json = decision_json
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            pipeline = SimpleTradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pending = pipeline._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )

            self.assertIsNotNone(pending)
            assert pending is not None
            self.assertEqual(pending.id, decision_row.id)
            refreshed = session.get(TradeDecision, decision_row.id)
            assert refreshed is not None
            self.assertEqual(refreshed.status, "planned")
            refreshed_json = cast(dict[str, Any], refreshed.decision_json)
            self.assertEqual(
                refreshed_json.get("submission_stage"),
                "paper_route_target_price_retry_pending",
            )
            self.assertNotIn("risk_reasons", refreshed_json)
            self.assertNotIn("reject_reason_atomic", refreshed_json)
            self.assertEqual(
                refreshed_json.get("paper_route_target_price_retry_attempts"),
                1,
            )
            retry = cast(
                dict[str, Any],
                refreshed_json.get("paper_route_target_price_retry"),
            )
            self.assertEqual(
                retry.get("previous_risk_reasons"), ["broker_precheck_failed"]
            )
            self.assertEqual(retry.get("previous_retry_attempts"), 0)
            self.assertEqual(
                retry.get("submission_stage"),
                "paper_route_target_price_retry_pending",
            )

    def test_simple_pipeline_retry_helpers_filter_invalid_rows_and_limits(
        self,
    ) -> None:
        from app import config

        self.assertEqual(_safe_int(True), 1)
        self.assertEqual(_safe_int("7"), 7)
        self.assertEqual(_safe_int("bad"), 0)

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        strategy_id = uuid4()
        invalid_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json=["not", "a", "mapping"],
            status="blocked",
        )
        self.assertIsNone(
            SimpleTradingPipeline._trade_decision_from_retry_row(invalid_row)
        )
        flatten_close_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="BITO",
            timeframe="event",
            decision_json={
                "schema_version": "torghut.paper-account-flatten-close-decision.v1",
                "flatten_lineage_role": "close",
                "action": "sell",
                "qty": "1000",
            },
            status="submitted",
        )
        self.assertIsNone(
            SimpleTradingPipeline._trade_decision_from_retry_row(flatten_close_row)
        )
        flatten_role_only_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="BITO",
            timeframe="event",
            decision_json={
                "flatten_lineage_role": "close",
                "action": "sell",
                "qty": "1000",
            },
            status="submitted",
        )
        self.assertIsNone(
            SimpleTradingPipeline._trade_decision_from_retry_row(flatten_role_only_row)
        )

        event_ts = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        decision = StrategyDecision(
            strategy_id=str(strategy_id),
            symbol="AAPL",
            event_ts=event_ts,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-retry-filter",
            params={"price": Decimal("100")},
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value(None)
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value("")
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value("close"),
            390,
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value("bad")
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value(Decimal("42.8")),
            42,
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value(object())
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {
                            "price": Decimal("100"),
                            "exit_minute_after_open": "45",
                        }
                    }
                )
            ),
            45,
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {
                            "price": Decimal("100"),
                            "paper_route_probe": {
                                "exit_minute_after_open": "120",
                            },
                        }
                    }
                )
            ),
            120,
        )
        window_end = datetime(2026, 3, 26, 20, 0, tzinfo=timezone.utc)
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate without explicit exit",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "source_kind": "paper_route_probe_runtime_observed",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_window_start": event_ts.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_probation_authorized": True,
            "bounded_evidence_collection_authorized": True,
        }
        source_decision_metadata = (
            SimpleTradingPipeline._paper_route_target_source_decision_metadata(
                target=target,
                strategy=strategy,
                symbol="AAPL",
                window_start=event_ts,
                window_end=window_end,
                max_notional=Decimal("250"),
            )
        )
        self.assertEqual(source_decision_metadata["exit_minute_after_open"], 390)
        self.assertEqual(
            source_decision_metadata["effective_exit_minute_after_open"], 389
        )
        self.assertEqual(
            source_decision_metadata["exit_due_at"],
            "2026-03-26T19:59:00+00:00",
        )
        self.assertTrue(source_decision_metadata["paper_route_probe_exit_defaulted"])
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {
                            "paper_route_target_plan_source_decision": (
                                source_decision_metadata
                            )
                        }
                    }
                )
            ),
            390,
        )
        strategy_signal_metadata = (
            SimpleTradingPipeline._strategy_signal_paper_metadata(
                decision=decision,
                target=target,
                strategy=strategy,
            )
        )
        self.assertEqual(strategy_signal_metadata["exit_minute_after_open"], 390)
        self.assertTrue(strategy_signal_metadata["paper_route_probe_exit_defaulted"])
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {"strategy_signal_paper": strategy_signal_metadata}
                    }
                )
            ),
            390,
        )
        old_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json=decision.model_dump(mode="json"),
            status="blocked",
            created_at=datetime(2026, 3, 25, 19, 0, tzinfo=timezone.utc),
        )
        self.assertFalse(
            pipeline._created_in_current_regular_session(
                old_row,
                decision.model_copy(
                    update={
                        "event_ts": datetime(
                            2026,
                            3,
                            25,
                            19,
                            0,
                            tzinfo=timezone.utc,
                        )
                    }
                ),
                session_open=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

        config.settings.trading_simple_paper_route_probe_enabled = False
        with self.session_local() as session:
            self.assertEqual(
                pipeline._paper_route_probe_retry_decisions(session=session), []
            )

        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 0
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16
        with self.session_local() as session:
            self.assertEqual(
                pipeline._paper_route_probe_retry_decisions(session=session), []
            )

        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        with self.session_local() as session:
            self.assertIsNone(
                pipeline._paper_route_probe_strategy(
                    session=session,
                    decision=decision.model_copy(
                        update={"strategy_id": "not-a-valid-uuid"}
                    ),
                )
            )
            strategy = Strategy(
                name="simple-paper-proof-floor-retry-filter",
                description=(
                    "simple paper retry filter fixtures\n[catalog_metadata]\n"
                    + json.dumps(
                        {
                            "params": {
                                "entry_minute_after_open": "60",
                                "exit_minute_after_open": "120",
                            }
                        }
                    )
                ),
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            stale_payload = decision.model_copy(
                update={
                    "strategy_id": str(strategy.id),
                    "event_ts": datetime(2026, 3, 25, 19, 0, tzinfo=timezone.utc),
                }
            ).model_dump(mode="json")
            stale_payload.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                }
            )
            stale_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=stale_payload,
                status="blocked",
                created_at=datetime(2026, 3, 25, 19, 0, tzinfo=timezone.utc),
            )
            invalid_payload_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                },
                status="blocked",
                created_at=event_ts,
            )
            metadata_miss_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "submission_stage": "blocked_other",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                },
                status="blocked",
                created_at=event_ts,
            )
            executed_payload = decision.model_copy(
                update={"strategy_id": str(strategy.id)}
            ).model_dump(mode="json")
            executed_payload.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                }
            )
            executed_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=executed_payload,
                status="blocked",
                created_at=event_ts,
            )
            session.add_all(
                [
                    stale_row,
                    invalid_payload_row,
                    metadata_miss_row,
                    executed_row,
                ]
            )
            session.commit()
            session.refresh(executed_row)
            session.add(
                Execution(
                    trade_decision_id=executed_row.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="order-existing",
                    client_order_id="client-existing",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    status="accepted",
                    raw_order={},
                )
            )
            session.commit()

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ):
                self.assertEqual(
                    pipeline._paper_route_probe_retry_decisions(session=session),
                    [],
                )

            stale_after_exit_payload = decision.model_copy(
                update={
                    "strategy_id": str(strategy.id),
                    "event_ts": datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
                }
            ).model_dump(mode="json")
            stale_after_exit_payload.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                }
            )
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json=stale_after_exit_payload,
                    status="blocked",
                    created_at=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
                )
            )
            session.commit()

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
            ):
                self.assertEqual(
                    pipeline._paper_route_probe_retry_decisions(session=session),
                    [],
                )

    def test_simple_pipeline_reopens_profit_floor_block_for_bounded_paper_route_retry(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = ""

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "paper",
            "max_notional": "25",
            "market_window": {"session_open": True},
            "blocking_reasons": ["execution_tca_route_universe_empty"],
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["AAPL"]}
            },
        }

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-floor-retry",
                description="simple paper retry after proof floor block",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="paper-route-retry",
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
            decision_json.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "submission_block_atomic": [
                        "alpha_readiness_not_promotion_eligible"
                    ],
                    "profitability_proof_floor": proof_floor,
                }
            )
            decision_row.status = "blocked"
            decision_row.decision_json = decision_json
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            pipeline = SimpleTradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            with patch.object(
                pipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ):
                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(pending)
            assert pending is not None
            self.assertEqual(pending.id, decision_row.id)
            refreshed = session.get(TradeDecision, decision_row.id)
            assert refreshed is not None
            self.assertEqual(refreshed.status, "planned")
            refreshed_json = cast(dict[str, Any], refreshed.decision_json)
            self.assertEqual(
                refreshed_json.get("submission_stage"),
                "paper_route_probe_retry_pending",
            )
            self.assertNotIn("submission_block_reason", refreshed_json)
            self.assertNotIn("submission_block_atomic", refreshed_json)
            self.assertEqual(refreshed_json.get("paper_route_probe_retry_attempts"), 1)
            retry = cast(dict[str, Any], refreshed_json.get("paper_route_probe_retry"))
            self.assertEqual(
                retry.get("previous_submission_block_reason"),
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertEqual(retry.get("previous_paper_route_probe_retry_attempts"), 0)
            self.assertEqual(retry.get("symbol"), "AAPL")
            self.assertEqual(
                retry.get("submission_stage"),
                "paper_route_probe_retry_pending",
            )
            context = cast(dict[str, Any], retry.get("context"))
            self.assertEqual(context.get("mode"), "paper_route_acquisition")
            self.assertEqual(context.get("max_notional"), "25.0")

    def test_simple_pipeline_retries_blocked_paper_route_decision_without_new_signal(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 4
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "paper",
            "max_notional": "25",
            "market_window": {"session_open": True},
            "blocking_reasons": ["execution_tca_route_universe_empty"],
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["AAPL"]}
            },
        }
        event_ts = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-floor-no-signal-retry",
                description="simple paper retry after proof floor block without new signal",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=event_ts,
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="paper-route-retry",
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
            decision_json.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "submission_block_atomic": [
                        "alpha_readiness_not_promotion_eligible"
                    ],
                    "profitability_proof_floor": proof_floor,
                }
            )
            decision_row.status = "blocked"
            decision_row.decision_json = decision_json
            session.add(decision_row)
            session.commit()

        alpaca_client = FakeAlpacaClient()
        ingestor = FakeIngestor([])
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=ingestor,
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
        ):
            pipeline.run_once()

        self.assertEqual(ingestor.committed_batches, 1)
        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["qty"], "0.25")
        with self.session_local() as session:
            refreshed = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            refreshed_json = cast(dict[str, Any], refreshed.decision_json)
            params = cast(dict[str, Any], refreshed_json.get("params"))
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("simple_lane"))
            retry = cast(dict[str, Any], refreshed_json.get("paper_route_probe_retry"))

            self.assertEqual(refreshed.status, "submitted")
            self.assertEqual(execution.trade_decision_id, refreshed.id)
            self.assertEqual(paper_route_probe.get("mode"), "paper_route_acquisition")
            self.assertEqual(
                Decimal(str(paper_route_probe.get("capped_notional"))),
                Decimal("25.000000"),
            )
            self.assertEqual(simple_lane.get("paper_route_probe_cap_applied"), True)
            self.assertEqual(
                retry.get("previous_submission_block_reason"),
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertEqual(refreshed_json.get("paper_route_probe_retry_attempts"), 1)

    def test_simple_pipeline_closes_filled_paper_route_probe_after_exit_minute(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.0")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_row = decisions[-1]
            exit_payload = cast(dict[str, Any], exit_row.decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

            self.assertEqual(exit_row.status, "submitted")
            self.assertEqual(exit_payload.get("action"), "sell")
            self.assertEqual(exit_metadata.get("mode"), "paper_route_exit")
            self.assertEqual(exit_metadata.get("db_open_qty"), "2.00000000")
            self.assertEqual(exit_metadata.get("broker_position_qty"), "2")
            self.assertEqual(
                exit_metadata.get("exit_due_at"),
                "2026-03-26T15:30:00+00:00",
            )

    def test_simple_pipeline_carries_paper_route_lineage_to_exit_decision(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            source_candidate_ids=("candidate-pairs-a",),
            source_hypothesis_ids=("H-PAIRS-01",),
            source_strategy_names=("microbar-cross-sectional-pairs-v1",),
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

        self.assertEqual(
            exit_metadata.get("source_candidate_ids"),
            ["candidate-pairs-a"],
        )
        self.assertEqual(
            exit_metadata.get("source_hypothesis_ids"),
            ["H-PAIRS-01"],
        )
        self.assertEqual(
            exit_metadata.get("source_strategy_names"),
            ["microbar-cross-sectional-pairs-v1"],
        )
        self.assertEqual(
            exit_metadata.get("paper_route_probe_lineage_targets"),
            [
                {
                    "candidate_id": "candidate-pairs-a",
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                }
            ],
        )

    def test_simple_pipeline_closes_short_paper_route_probe_with_buy_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            symbol="AMZN",
            side="sell",
            source_candidate_ids=("candidate-pairs-a",),
            source_hypothesis_ids=("H-PAIRS-01",),
            source_strategy_names=("microbar-cross-sectional-pairs-v1",),
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AMZN", "qty": "2", "side": "short"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.0")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

        self.assertEqual(exit_payload.get("action"), "buy")
        self.assertEqual(exit_metadata.get("db_open_side"), "short")
        self.assertEqual(exit_metadata.get("db_open_qty"), "2.00000000")
        self.assertEqual(
            exit_metadata.get("source_candidate_ids"), ["candidate-pairs-a"]
        )
        self.assertEqual(exit_metadata.get("source_hypothesis_ids"), ["H-PAIRS-01"])

    def test_simple_pipeline_closes_late_filled_probe_from_strategy_exit_metadata(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            entry_ts=datetime(2026, 3, 26, 15, 45, tzinfo=timezone.utc),
            include_decision_exit_minute=False,
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 46, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )
            self.assertEqual(
                exit_metadata.get("exit_due_at"),
                "2026-03-26T15:30:00+00:00",
            )

    def test_simple_pipeline_closes_probe_even_when_signal_preparation_blocks(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 15, 31, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        with patch.object(
            SimpleTradingPipeline,
            "_prepare_batch_for_decisions",
            return_value=False,
        ):
            self._run_simple_paper_pipeline(
                alpaca_client=alpaca_client,
                now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
                signals=[signal],
            )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")

    def test_simple_pipeline_repairs_stale_paper_route_probe_exit_next_session(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            entry_ts=datetime(2026, 3, 26, 18, 40, tzinfo=timezone.utc),
            exit_minute_after_open="120",
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 27, 14, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        with self.session_local() as session:
            exit_row = (
                session.execute(
                    select(TradeDecision)
                    .where(TradeDecision.symbol == "AAPL")
                    .order_by(TradeDecision.created_at.desc())
                )
                .scalars()
                .first()
            )
            assert exit_row is not None
            exit_payload = cast(dict[str, Any], exit_row.decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

            self.assertEqual(exit_payload.get("action"), "sell")
            self.assertEqual(
                exit_metadata.get("session_open"),
                "2026-03-26T13:30:00+00:00",
            )
            self.assertEqual(
                exit_metadata.get("exit_due_at"),
                "2026-03-26T15:30:00+00:00",
            )
            self.assertEqual(exit_metadata.get("stale_exit_repair"), True)

    def test_paper_route_probe_exit_session_open_prefers_exit_metadata(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 18, 40, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="paper-route-exit",
            params={
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "session_open": datetime(
                        2026,
                        3,
                        25,
                        16,
                        tzinfo=timezone.utc,
                    ),
                }
            },
        )
        fallback = datetime(2026, 3, 27, 14, 31, tzinfo=timezone.utc)

        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_session_open(
                decision=decision,
                fallback=fallback,
            ),
            datetime(2026, 3, 25, 13, 30, tzinfo=timezone.utc),
        )

        parsed_text_decision = decision.model_copy(
            update={
                "params": {
                    "paper_route_probe_exit": {
                        "mode": "paper_route_exit",
                        "session_open": "2026-03-24T17:55:00Z",
                    }
                }
            }
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_session_open(
                decision=parsed_text_decision,
                fallback=fallback,
            ),
            datetime(2026, 3, 24, 13, 30, tzinfo=timezone.utc),
        )

        invalid_text_decision = decision.model_copy(
            update={
                "params": {
                    "paper_route_probe_exit": {
                        "mode": "paper_route_exit",
                        "session_open": "not-a-timestamp",
                    }
                }
            }
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_session_open(
                decision=invalid_text_decision,
                fallback=fallback,
            ),
            datetime(2026, 3, 27, 13, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_session_open(
                datetime(2026, 1, 5, 15, 31, tzinfo=timezone.utc)
            ),
            datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc),
        )

    def test_simple_pipeline_does_not_close_paper_route_probe_before_exit_minute(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 29, tzinfo=timezone.utc),
        )

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            self.assertEqual(session.query(TradeDecision).count(), 1)

    def test_simple_pipeline_does_not_duplicate_paper_route_probe_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )
        now = datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc)

        self._run_simple_paper_pipeline(alpaca_client=alpaca_client, now=now)
        self._run_simple_paper_pipeline(alpaca_client=alpaca_client, now=now)

        self.assertEqual(len(alpaca_client.submitted), 1)
        with self.session_local() as session:
            sell_count = (
                session.execute(
                    select(TradeDecision).where(TradeDecision.symbol == "AAPL")
                )
                .scalars()
                .all()
            )
            self.assertEqual(
                sum(
                    1
                    for decision_row in sell_count
                    if cast(dict[str, Any], decision_row.decision_json).get("action")
                    == "sell"
                ),
                1,
            )

    def test_simple_pipeline_allows_large_position_reducing_probe_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(qty=Decimal("20"))
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "20", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "20.0")
        with self.session_local() as session:
            exit_row = (
                session.execute(
                    select(TradeDecision)
                    .where(TradeDecision.symbol == "AAPL")
                    .order_by(TradeDecision.created_at.desc())
                )
                .scalars()
                .first()
            )
            assert exit_row is not None
            self.assertEqual(exit_row.status, "submitted")
            payload = cast(dict[str, Any], exit_row.decision_json)
            self.assertNotIn("max_notional_exceeded", payload.get("risk_reasons", []))

    def test_simple_pipeline_does_not_close_strategy_signal_paper_as_probe_inventory(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            source_candidate_ids=["cand-h-pairs"],
            source_hypothesis_ids=["H-PAIRS-01"],
            source_strategy_names=["microbar-cross-sectional-pairs-v1"],
            source_decision_mode="strategy_signal_paper",
            profit_proof_eligible=True,
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at)
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 1)
            payload = cast(dict[str, Any], decisions[0].decision_json)
            params = cast(dict[str, Any], payload["params"])
            self.assertEqual(params["source_decision_mode"], "strategy_signal_paper")
            self.assertTrue(params["profit_proof_eligible"])
            self.assertNotIn("paper_route_probe_exit", params)

    def test_paper_route_probe_entry_metadata_rejects_proof_and_non_probe_rows(
        self,
    ) -> None:
        self.assertIsNone(_paper_route_probe_entry_metadata({}))
        self.assertIsNone(
            _paper_route_probe_entry_metadata(
                {
                    "profit_proof_eligible": True,
                    "paper_route_probe": {"mode": "paper_route_acquisition"},
                }
            )
        )
        self.assertIsNone(
            _paper_route_probe_entry_metadata(
                {
                    "paper_route_probe": {
                        "mode": "paper_route_acquisition",
                        "source_decision_mode": "strategy_signal_paper",
                    }
                }
            )
        )
        self.assertIsNone(
            _paper_route_probe_entry_metadata(
                {
                    "paper_route_probe": {
                        "mode": "paper_route_acquisition",
                        "profit_proof_eligible": True,
                    }
                }
            )
        )
        self.assertEqual(
            _paper_route_probe_entry_metadata(
                {
                    "paper_route_probe": {
                        "mode": "paper_route_acquisition",
                        "source_decision_mode": "route_acquisition_probe",
                    }
                }
            ),
            {
                "mode": "paper_route_acquisition",
                "source_decision_mode": "route_acquisition_probe",
            },
        )

    def test_paper_route_probe_lineage_parses_profit_proof_eligibility(self) -> None:
        self.assertTrue(
            _paper_route_probe_lineage_from_params({"profit_proof_eligible": 1})[
                "profit_proof_eligible"
            ]
        )
        self.assertTrue(
            _paper_route_probe_lineage_from_params({"profit_proof_eligible": "true"})[
                "profit_proof_eligible"
            ]
        )
        self.assertFalse(
            _paper_route_probe_lineage_from_params({"profit_proof_eligible": "false"})[
                "profit_proof_eligible"
            ]
        )

    def test_paper_route_probe_lineage_falls_back_to_nested_source_mode(
        self,
    ) -> None:
        lineage = _paper_route_probe_lineage_from_params(
            {
                "paper_route_probe": {
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                }
            }
        )

        self.assertEqual(lineage["source_decision_mode"], "strategy_signal_paper")
        self.assertTrue(lineage["profit_proof_eligible"])

    def test_simple_pipeline_reopens_rejected_paper_route_probe_exit(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        self._seed_filled_paper_route_probe_entry()
        now = datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc)
        executor = OrderExecutor()
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=executor,
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
        with (
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
            self.session_local() as session,
        ):
            exit_decisions = pipeline._paper_route_probe_exit_decisions(session=session)
            self.assertEqual(len(exit_decisions), 1)
            exit_decision = exit_decisions[0]
            strategy = (
                session.execute(
                    select(Strategy).where(Strategy.id == exit_decision.strategy_id)
                )
                .scalars()
                .one()
            )
            exit_row = executor.ensure_decision(
                session,
                exit_decision,
                strategy,
                "paper",
            )
            exit_payload = dict(cast(Mapping[str, Any], exit_row.decision_json))
            exit_payload["submission_stage"] = "rejected_pre_submit"
            exit_payload["risk_reasons"] = ["max_notional_exceeded"]
            exit_payload["reject_reason_atomic"] = ["max_notional_exceeded"]
            exit_row.status = "rejected"
            exit_row.decision_json = exit_payload
            session.add(exit_row)
            session.commit()

        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=now,
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_row = decisions[-1]
            self.assertEqual(exit_row.status, "submitted")
            exit_payload = cast(dict[str, Any], exit_row.decision_json)
            self.assertEqual(
                exit_payload.get("submission_stage"),
                "submitted",
            )
            retry = cast(
                dict[str, Any],
                exit_payload.get("paper_route_probe_exit_retry"),
            )
            self.assertEqual(retry.get("previous_decision_status"), "rejected")
            self.assertEqual(
                retry.get("previous_submission_stage"), "rejected_pre_submit"
            )
            self.assertEqual(
                exit_payload.get("paper_route_probe_exit_retry_attempts"), 1
            )
            self.assertNotIn("risk_reasons", exit_payload)
            self.assertNotIn("reject_reason_atomic", exit_payload)

    def test_simple_pipeline_does_not_exit_without_broker_inventory(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient([])

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            self.assertEqual(len(decisions), 1)
            payload = cast(dict[str, Any], decisions[0].decision_json)
            self.assertEqual(payload.get("action"), "buy")

    def test_simple_pipeline_restores_simulation_exit_position_from_db_open_qty(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient([])
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="paper-route-exit-test",
            dataset_id="paper-route-exit-test",
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            execution_adapter=execution_adapter,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            executions = (
                session.execute(select(Execution).order_by(Execution.created_at.asc()))
                .scalars()
                .all()
            )

        self.assertEqual(
            [
                cast(dict[str, Any], row.decision_json).get("action")
                for row in decisions
            ],
            ["buy", "sell"],
        )
        self.assertEqual([execution.side for execution in executions], ["buy", "sell"])
        self.assertEqual(execution_adapter.list_positions(), [])

        exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
        params = cast(dict[str, Any], exit_payload.get("params"))
        exit_metadata = cast(dict[str, Any], params.get("paper_route_probe_exit"))
        self.assertEqual(exit_metadata.get("broker_position_qty"), "0")
        self.assertEqual(exit_metadata.get("db_position_qty_fallback"), True)
        self.assertEqual(
            exit_metadata.get("position_source"),
            "source_execution_db_open_qty",
        )
        self.assertEqual(exit_metadata.get("effective_position_qty"), "2.00000000")

    def test_simulation_seed_missing_position_snapshot_fail_closed_edges(
        self,
    ) -> None:
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="paper-route-exit-test",
            dataset_id="paper-route-exit-test",
        )

        self.assertFalse(execution_adapter.seed_missing_position_snapshot({}))
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot({"symbol": "AAPL"})
        )
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "bad"}
            )
        )
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "0"}
            )
        )
        self.assertTrue(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "2", "side": "long"}
            )
        )
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "1", "side": "long"}
            )
        )

    def test_restore_simulation_exit_position_fail_closed_edges(self) -> None:
        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("2"),
            rationale="paper-route-exit-edge",
            params={},
        )

        class NonCallableSeedAdapter:
            name = "simulation"

        class FalseSeedAdapter:
            name = "simulation"

            def seed_missing_position_snapshot(self, _position: object) -> bool:
                return False

        class RaisingSeedAdapter:
            name = "simulation"

            def seed_missing_position_snapshot(self, _position: object) -> bool:
                raise RuntimeError("seed failed")

        class RecordingSeedAdapter:
            name = "simulation"

            def __init__(self) -> None:
                self.positions: list[dict[str, Any]] = []

            def seed_missing_position_snapshot(self, position: object) -> bool:
                self.positions.append(dict(cast(Mapping[str, Any], position)))
                return True

        base_kwargs = {
            "positions": [],
            "decision": decision,
            "metadata": {"db_open_qty": "2"},
            "price": Decimal("100"),
            "execution_adapter": FalseSeedAdapter(),
        }

        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{**base_kwargs, "trading_mode": "live"}
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "trading_mode": "paper",
                    "execution_adapter": FakeAlpacaClient(),
                }
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{**base_kwargs, "trading_mode": "paper", "metadata": {}}
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "trading_mode": "paper",
                    "execution_adapter": NonCallableSeedAdapter(),
                }
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{**base_kwargs, "trading_mode": "paper"}
            )
        )
        restored_positions: list[dict[str, Any]] = []
        recording_adapter = RecordingSeedAdapter()
        self.assertEqual(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "positions": restored_positions,
                    "trading_mode": "paper",
                    "metadata": {"db_open_qty": "3", "db_open_side": "sideways"},
                    "execution_adapter": recording_adapter,
                }
            ),
            Decimal("2"),
        )
        self.assertEqual(
            recording_adapter.positions,
            [{"symbol": "AAPL", "qty": "2", "side": "long", "market_value": "200"}],
        )
        self.assertEqual(restored_positions, recording_adapter.positions)
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "trading_mode": "paper",
                    "execution_adapter": RaisingSeedAdapter(),
                }
            )
        )

    def test_simple_pipeline_paper_route_exit_helpers_cover_filter_edges(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True

        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("2"),
            rationale="paper-route-exit-edge",
            params={
                "price": Decimal("100"),
                "paper_route_probe_exit": {"mode": "not-paper-route-exit"},
            },
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_metadata(decision)
        )

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: False  # type: ignore[method-assign]
        with (
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
            self.session_local() as session,
        ):
            self.assertEqual(
                pipeline._paper_route_probe_exit_decisions(session=session), []
            )

        non_exit_decision = decision.model_copy(
            update={"params": {"price": Decimal("100")}}
        )
        self.assertIs(
            SimpleTradingPipeline._prepare_paper_route_probe_exit_position(
                [{"symbol": "AAPL", "qty": "1", "side": "long"}],
                non_exit_decision,
            ),
            non_exit_decision,
        )

        exit_decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "paper_route_probe_exit": {"mode": "paper_route_exit"},
                    "simple_lane": {"quantity_resolution": {}},
                }
            }
        )
        prepared = SimpleTradingPipeline._prepare_paper_route_probe_exit_position(
            [{"symbol": "AAPL", "qty": "1", "side": "long"}],
            exit_decision,
        )
        assert prepared is not None
        self.assertEqual(prepared.qty, Decimal("1"))
        metadata = cast(dict[str, Any], prepared.params["paper_route_probe_exit"])
        self.assertEqual(metadata["qty_capped_to_position"], True)
        self.assertEqual(metadata["broker_position_qty"], "1")

    def test_simple_pipeline_proof_floor_includes_paper_route_probe_settings(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_order_feed_telemetry_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        captured: dict[str, Any] = {}

        def fake_proof_floor(**kwargs: Any) -> dict[str, object]:
            captured.update(kwargs)
            return {"schema_version": "test-proof-floor"}

        with (
            patch.object(pipeline, "_refresh_market_context_for_proof_floor"),
            patch.object(pipeline, "_live_submission_gate", return_value={}),
            patch(
                "app.trading.scheduler.simple_pipeline.build_submission_gate_market_context_status",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_hypothesis_runtime_summary",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_empirical_jobs_status",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.load_quant_evidence_status",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_tca_gate_inputs",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_profitability_proof_floor_receipt",
                side_effect=fake_proof_floor,
            ),
            self.session_local() as session,
        ):
            proof_floor = pipeline._profitability_proof_floor(session=session)

        self.assertEqual(proof_floor["schema_version"], "test-proof-floor")
        simple_lane_status = cast(
            Mapping[str, Any],
            captured["simple_lane_status"],
        )
        self.assertTrue(simple_lane_status["paper_route_probe_enabled"])
        self.assertEqual(simple_lane_status["paper_route_probe_max_notional"], 25.0)
        self.assertTrue(simple_lane_status["order_feed_telemetry_enabled"])
        self.assertTrue(simple_lane_status["order_feed_lifecycle_required"])
        self.assertEqual(simple_lane_status["order_feed_lifecycle_status"], "enabled")

    def test_simple_pipeline_allows_bounded_paper_route_probe_for_tca_repair(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-route-probe",
                description="simple paper lane route probe",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "execution_tca_route_universe_empty",
            ],
            "route_reacquisition_book": {
                "summary": {
                    "candidate_symbols": [],
                    "repair_candidate_symbols": ["NVDA"],
                }
            },
        }
        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value=proof_floor,
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["qty"], "0.25")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("simple_lane"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(execution.submitted_qty, Decimal("0.25000000"))
            self.assertEqual(paper_route_probe.get("mode"), "paper_route_acquisition")
            self.assertEqual(paper_route_probe.get("max_notional"), "25.0")
            self.assertEqual(paper_route_probe.get("capped_qty"), "0.2500")
            self.assertEqual(simple_lane.get("paper_route_probe_cap_applied"), True)

    def test_simple_pipeline_no_signal_cycle_generates_target_plan_source_decision(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 1000.0
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "observed_stage": "paper",
            "strategy_family": "microbar_pairs",
            "strategy_name": "paper-route-candidate-v1",
            "runtime_strategy_name": "paper-route-runtime-name",
            "strategy_lookup_names": [
                "paper-route-runtime-name",
                "paper-route-candidate-v1",
            ],
            "account_label": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "250",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "exit_minute_after_open": "120",
            "paper_probation_authorized": True,
            "source_collection_authorized": True,
            "source_collection_authorization_scope": (
                "source_window_evidence_collection_only"
            ),
            "source_collection_reason_codes": [
                "source_window_evidence_collection_pending"
            ],
            "bounded_evidence_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_max_notional": "250",
            "max_notional": "0",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
        }
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
            patch("app.trading.scheduler.pipeline.trading_now", return_value=now),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.5")
        with self.session_local() as session:
            decisions = list(session.execute(select(TradeDecision)).scalars())
            executions = list(session.execute(select(Execution)).scalars())
            self.assertEqual(len(decisions), 1)
            self.assertEqual(len(executions), 1)
            decision = decisions[0]
            execution = executions[0]
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))
            source_decision = cast(
                dict[str, Any],
                params.get("paper_route_target_plan_source_decision"),
            )
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("simple_lane"))
            simple_lane_precheck = cast(
                dict[str, Any], params.get("simple_lane_precheck")
            )
            execution_policy = cast(dict[str, Any], params.get("execution_policy"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(Decimal(str(decision_json["qty"])), Decimal("2.5"))
            self.assertEqual(execution.submitted_qty, Decimal("2.50000000"))
            created_at = decision.created_at
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            self.assertEqual(created_at, now)
            self.assertEqual(
                target_plan["mode"], "paper_route_target_plan_source_decision"
            )
            self.assertEqual(source_decision["candidate_id"], "cand-paper-route")
            self.assertEqual(source_decision["hypothesis_id"], "H-PAPER-ROUTE")
            self.assertEqual(
                source_decision["source_decision_mode"], "route_acquisition_probe"
            )
            self.assertFalse(source_decision["profit_proof_eligible"])
            self.assertEqual(source_decision["exit_minute_after_open"], 120)
            self.assertTrue(source_decision["source_collection_authorized"])
            self.assertEqual(
                source_decision["source_collection_authorization_scope"],
                "source_window_evidence_collection_only",
            )
            self.assertEqual(
                source_decision["source_collection_reason_codes"],
                ["source_window_evidence_collection_pending"],
            )
            self.assertTrue(source_decision["bounded_evidence_collection_authorized"])
            self.assertEqual(
                source_decision["bounded_evidence_collection_scope"],
                "paper_route_probe_next_session_only",
            )
            self.assertEqual(
                source_decision["bounded_evidence_collection_max_notional"], "250"
            )
            self.assertEqual(
                source_decision["paper_route_probe_effective_max_notional"], "250"
            )
            self.assertEqual(params["exit_minute_after_open"], 120)
            self.assertEqual(params["source_candidate_ids"], ["cand-paper-route"])
            self.assertEqual(params["source_hypothesis_ids"], ["H-PAPER-ROUTE"])
            self.assertEqual(params["source_decision_mode"], "route_acquisition_probe")
            self.assertFalse(params["profit_proof_eligible"])
            self.assertFalse(params["promotion_allowed"])
            self.assertFalse(params["final_promotion_authorized"])
            self.assertEqual(paper_route_probe["max_notional"], "250")
            self.assertTrue(paper_route_probe["target_source_authorized"])
            self.assertEqual(
                paper_route_probe["source_decision_mode"], "route_acquisition_probe"
            )
            self.assertFalse(paper_route_probe["profit_proof_eligible"])
            self.assertEqual(paper_route_probe["exit_minute_after_open"], 120)
            self.assertEqual(
                paper_route_probe["exit_due_at"],
                "2026-05-26T15:30:00+00:00",
            )
            self.assertEqual(paper_route_probe["capped_qty"], "2.5000")
            self.assertEqual(
                Decimal(str(paper_route_probe["capped_notional"])), Decimal("250")
            )
            self.assertTrue(paper_route_probe["target_source_notional_sized"])
            self.assertEqual(Decimal(str(simple_lane["final_qty"])), Decimal("2.5"))
            self.assertEqual(Decimal(str(simple_lane["notional"])), Decimal("250"))
            self.assertTrue(simple_lane["paper_route_probe_cap_applied"])
            self.assertEqual(simple_lane_precheck["requested_qty"], "2.5000")
            self.assertEqual(simple_lane_precheck["final_qty"], "2.5000")
            self.assertEqual(
                Decimal(str(execution_policy["notional"])), Decimal("250.0")
            )

    def test_simple_pipeline_signal_cycle_still_generates_target_plan_source_decision(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 100.0
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "observed_stage": "paper",
            "strategy_family": "microbar_pairs",
            "strategy_name": "paper-route-candidate-v1",
            "runtime_strategy_name": "paper-route-runtime-name",
            "strategy_lookup_names": [
                "paper-route-runtime-name",
                "paper-route-candidate-v1",
            ],
            "account_label": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "exit_minute_after_open": "120",
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
        }
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor(
                [
                    SignalEnvelope(
                        event_ts=now,
                        symbol="AAPL",
                        payload={
                            "price": Decimal("100"),
                            "imbalance_bid_px": Decimal("99.99"),
                            "imbalance_ask_px": Decimal("100.01"),
                            "spread": Decimal("0.02"),
                        },
                        timeframe="1Min",
                    )
                ]
            ),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                pipeline,
                "_evaluate_signal_decisions",
                return_value=[],
            ) as evaluate_signals,
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
            patch("app.trading.scheduler.pipeline.trading_now", return_value=now),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()

        evaluate_signals.assert_called_once()
        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "0.25")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            source_decision = cast(
                dict[str, Any],
                params.get("paper_route_target_plan_source_decision"),
            )
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(source_decision["candidate_id"], "cand-paper-route")
            self.assertEqual(
                source_decision["source_decision_mode"], "route_acquisition_probe"
            )
            self.assertFalse(source_decision["profit_proof_eligible"])
            self.assertEqual(source_decision["exit_minute_after_open"], 120)
            self.assertEqual(params["source_hypothesis_ids"], ["H-PAPER-ROUTE"])
            self.assertEqual(params["source_decision_mode"], "route_acquisition_probe")
            self.assertFalse(params["profit_proof_eligible"])
            self.assertTrue(paper_route_probe["target_source_authorized"])
            self.assertEqual(
                paper_route_probe["source_decision_mode"], "route_acquisition_probe"
            )
            self.assertFalse(paper_route_probe["profit_proof_eligible"])
            self.assertEqual(paper_route_probe["exit_minute_after_open"], 120)

    def test_simple_pipeline_target_plan_source_decision_requires_open_window(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 12, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "strategy_name": "paper-route-candidate-v1",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
        }
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
        ):
            pipeline.run_once()

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            self.assertEqual(list(session.execute(select(TradeDecision)).scalars()), [])

    def test_paper_route_target_source_decision_helpers_cover_rejection_edges(
        self,
    ) -> None:
        aware = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)

        self.assertEqual(_parse_target_datetime(aware), aware)
        self.assertEqual(
            _parse_target_datetime("2026-05-26T14:00:00"),
            aware,
        )
        self.assertIsNone(_parse_target_datetime(None))
        self.assertIsNone(_parse_target_datetime("not-a-date"))
        self.assertIsNone(
            _target_probe_window(
                {
                    "paper_route_probe_window_start": aware.isoformat(),
                    "paper_route_probe_window_end": aware.isoformat(),
                }
            )
        )
        self.assertEqual(
            _target_probe_action({"paper_route_probe_action": "long"}), "buy"
        )
        self.assertEqual(
            _target_probe_action({"paper_route_probe_side": "short"}), "sell"
        )

        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_strategy({}, [strategy])
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_strategy(
                {"strategy_name": "missing-strategy"},
                [strategy],
            )
        )
        self.assertIs(
            SimpleTradingPipeline._paper_route_target_strategy(
                {"strategy_name": "paper-route-candidate-v1"},
                [strategy],
            ),
            strategy,
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_target_strategy_symbols(
                Strategy(
                    name="string-universe",
                    description="string universe",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=cast(Any, "AAPL, MSFT"),
                )
            ),
            {"AAPL", "MSFT"},
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_target_strategy_symbols(
                Strategy(
                    name="invalid-universe",
                    description="invalid universe",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=cast(Any, object()),
                )
            ),
            set(),
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_position(
                [{"symbol": "AAPL", "qty": "10"}],
                " ",
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_position(
                [{"symbol": "AAPL", "qty": "0", "market_value": "25.50"}],
                "AAPL",
            )
        )

    def test_paper_route_target_source_decisions_guard_paths_and_dedupes(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = False

        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        target = {
            "strategy_name": "paper-route-candidate-v1",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
        }
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=now,
        ):
            config.settings.trading_mode = "live"
            self.assertEqual(
                pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                ),
                [],
            )

            config.settings.trading_mode = "paper"
            config.settings.trading_simple_paper_route_probe_enabled = False
            self.assertEqual(
                pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                ),
                [],
            )

            config.settings.trading_simple_paper_route_probe_enabled = True
            pipeline._is_market_session_open = lambda _now=None: False  # type: ignore[method-assign]
            self.assertEqual(
                pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                ),
                [],
            )

            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
            for skipped_target in (
                {
                    **target,
                    "paper_route_probe_window_start": window_start.isoformat(),
                    "paper_route_probe_window_end": window_start.isoformat(),
                },
                {**target, "paper_route_probe_next_session_max_notional": "0"},
                {**target, "strategy_name": "missing-strategy"},
                {**target, "paper_route_probe_action": "sell"},
            ):
                with patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL"}, None, [skipped_target]),
                ):
                    self.assertEqual(
                        pipeline._paper_route_target_source_decisions(
                            strategies=[strategy],
                            allowed_symbols={"AAPL"},
                        ),
                        [],
                    )

            with patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target, dict(target)]),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].symbol, "AAPL")
        self.assertEqual(decisions[0].action, "buy")

    def test_paper_route_target_source_decisions_skip_symbols_with_open_exposure(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True

        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("1000"),
        )
        target = {
            "strategy_name": "paper-route-candidate-v1",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
        }
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, [target]),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
        ):
            decisions = pipeline._paper_route_target_source_decisions(
                strategies=[strategy],
                allowed_symbols={"AAPL", "AMZN"},
                positions=[{"symbol": "AMZN", "qty": "41", "side": "short"}],
            )

        self.assertEqual([decision.symbol for decision in decisions], ["AAPL"])

    def test_paper_route_target_source_decisions_skip_db_strategy_exposure(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            for symbol, source_decision_mode, profit_proof_eligible in (
                ("AAPL", STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE, True),
                ("AMZN", ROUTE_ACQUISITION_SOURCE_DECISION_MODE, False),
            ):
                decision_hash = f"source-mode-{symbol.lower()}-{uuid4()}"
                decision_row = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol=symbol,
                    timeframe="1Min",
                    decision_json=StrategyDecision(
                        strategy_id=str(strategy.id),
                        symbol=symbol,
                        event_ts=window_start + timedelta(minutes=5),
                        timeframe="1Min",
                        action="buy",
                        qty=Decimal("10"),
                        rationale="source-mode-fixture",
                        params={
                            "source_decision_mode": source_decision_mode,
                            "profit_proof_eligible": profit_proof_eligible,
                        },
                    ).model_dump(mode="json"),
                    rationale="source-mode-fixture",
                    status="submitted",
                    decision_hash=decision_hash,
                    created_at=window_start + timedelta(minutes=5),
                )
                session.add(decision_row)
                session.commit()
                session.refresh(decision_row)
                session.add(
                    Execution(
                        trade_decision_id=decision_row.id,
                        alpaca_account_label="paper",
                        alpaca_order_id=f"{symbol.lower()}-{uuid4()}",
                        client_order_id=decision_hash,
                        symbol=symbol,
                        side="buy",
                        order_type="market",
                        time_in_force="day",
                        submitted_qty=Decimal("10"),
                        filled_qty=Decimal("10"),
                        avg_fill_price=Decimal("100"),
                        status="filled",
                        created_at=window_start + timedelta(minutes=6),
                    )
                )
            session.commit()

            target = {
                "strategy_name": "paper-route-candidate-v1",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_next_session_max_notional": "25",
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
            }
            pipeline = SimpleTradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            with (
                patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    session=session,
                    strategies=[strategy],
                    allowed_symbols={"AAPL", "AMZN"},
                    positions=[],
                )

        self.assertEqual(decisions, [])

    def test_paper_route_target_strategy_exposure_helper_fails_closed(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)
        mock_session.execute.side_effect = RuntimeError("database offline")

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_strategy_exposure_helper_returns_false_without_key(
        self,
    ) -> None:
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol=" ",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
        mock_session.execute.assert_not_called()

    def test_paper_route_target_strategy_exposure_helper_ignores_noise(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        result = Mock()
        result.all.return_value = [("buy", Decimal("0")), ("sell", None)]
        mock_session = Mock(spec=Session)
        mock_session.execute.return_value = result

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_strategy_exposure_helper_detects_buy_exposure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        result = Mock()
        result.all.return_value = [("buy", Decimal("3"))]
        mock_session = Mock(spec=Session)
        mock_session.execute.return_value = result

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_helper_fails_closed(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)
        mock_session.execute.side_effect = RuntimeError("database offline")

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_helper_ignores_noise(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        result = Mock()
        result.all.return_value = [
            ("buy", Decimal("1"), ["not-a-decision-mapping"]),
            ("buy", Decimal("1"), {"params": "not-a-param-mapping"}),
            (
                "buy",
                Decimal("1"),
                {
                    "params": {
                        "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE
                    }
                },
            ),
            ("buy", None, {"params": {"profit_proof_eligible": True}}),
            (
                "sell",
                Decimal("2"),
                {
                    "params": {
                        "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                    }
                },
            ),
        ]
        mock_session = Mock(spec=Session)
        mock_session.execute.return_value = result

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_helper_returns_false_without_key(
        self,
    ) -> None:
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol=" ",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_process_paper_route_target_source_decisions_records_submit_failure(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        state = TradingState()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=state,
            account_label="paper",
            session_factory=self.session_local,
        )
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="target-plan-source-decision",
            params={"price": "100"},
        )
        positions: list[dict[str, Any]] = []

        with (
            patch.object(
                pipeline,
                "_paper_route_target_source_decisions",
                return_value=[decision],
            ) as source_decisions,
            patch.object(
                pipeline,
                "_handle_decision",
                side_effect=RuntimeError("submit failed"),
            ),
            self.session_local() as session,
        ):
            pipeline._process_paper_route_target_source_decisions(
                session=session,
                strategies=[strategy],
                account={"equity": "10000", "cash": "10000", "buying_power": "10000"},
                positions=positions,
                allowed_symbols={"AAPL"},
            )

        source_decisions.assert_called_once_with(
            strategies=[strategy],
            allowed_symbols={"AAPL"},
            positions=positions,
            session=session,
        )
        self.assertEqual(state.metrics.decisions_total, 1)
        self.assertEqual(state.metrics.orders_rejected_total, 1)
        self.assertEqual(
            state.metrics.decision_reject_reason_total.get("broker_submit_failed"),
            1,
        )

    def test_simple_pipeline_paper_route_probe_can_repair_symbol_outside_candidates(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-route-probe-repair-symbol",
                description="simple paper lane route probe repair symbol",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "execution_tca_symbol_missing",
            ],
            "route_reacquisition_book": {
                "summary": {
                    "candidate_symbols": ["AAPL"],
                    "repair_candidate_symbols": ["NVDA"],
                    "repair_candidates": [
                        {
                            "symbol": "NVDA",
                            "state": "missing",
                            "reason": "execution_tca_symbol_missing",
                        }
                    ],
                }
            },
        }
        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value=proof_floor,
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("simple_lane"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(paper_route_probe.get("symbol"), "NVDA")
            self.assertEqual(paper_route_probe.get("mode"), "paper_route_acquisition")
            self.assertEqual(simple_lane.get("paper_route_probe_cap_applied"), True)

    def test_paper_route_probe_helpers_handle_missing_repair_metadata(self) -> None:
        self.assertFalse(SimpleTradingPipeline._proof_floor_market_session_open({}))
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_route_repair_symbols({}), set()
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_paper_route_probe_symbols({}), set()
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_symbol_route_probe_reasons({}, "NVDA"),
            set(),
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_route_repair_symbols(
                {"route_reacquisition_book": {}}
            ),
            set(),
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_symbol_route_probe_reasons(
                {"route_reacquisition_book": {}},
                "NVDA",
            ),
            set(),
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_route_repair_symbols(
                {
                    "route_reacquisition_book": {
                        "summary": {
                            "repair_candidate_symbols": "NVDA",
                            "candidate_symbols": [" nvda ", "", "MU"],
                        }
                    }
                }
            ),
            {"NVDA", "MU"},
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_paper_route_probe_symbols(
                {
                    "route_reacquisition_book": {
                        "summary": {
                            "paper_route_probe_eligible_symbols": [
                                " nvda ",
                                "",
                                "MU",
                            ],
                            "paper_route_probe_active_symbols": ["aapl"],
                        },
                        "paper_route_probe": {
                            "eligible_symbols": ["INTC"],
                            "active_symbols": ["AMZN"],
                        },
                    }
                }
            ),
            {"AAPL", "AMZN", "INTC", "MU", "NVDA"},
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_symbol_route_probe_reasons(
                {
                    "route_reacquisition_book": {
                        "summary": {
                            "repair_candidates": [
                                object(),
                                {
                                    "symbol": "MU",
                                    "state": "missing",
                                    "reason": "execution_tca_symbol_missing",
                                },
                                {
                                    "symbol": "NVDA",
                                    "state": "blocked",
                                    "reason": "execution_tca_symbol_missing",
                                },
                            ]
                        }
                    }
                },
                "NVDA",
            ),
            set(),
        )

        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-reference-price",
            params={},
        )

        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_reference_price(decision)
        )

    def test_paper_route_probe_context_rejects_unsafe_profiles(self) -> None:
        from app import config

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="route-probe-context",
            params={"price": "100"},
        )
        proof_floor = {
            "market_window": {"session_open": True},
            "blocking_reasons": ["execution_tca_route_universe_empty"],
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["NVDA"]}
            },
        }

        config.settings.trading_mode = "live"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
            )
        )

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = False
        disabled_submit_probe_context = pipeline._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=decision,
        )
        self.assertIsNotNone(disabled_submit_probe_context)
        assert disabled_submit_probe_context is not None
        self.assertEqual(
            disabled_submit_probe_context.get("simple_submit_enabled"), False
        )
        self.assertEqual(
            disabled_submit_probe_context.get("simple_submit_bypass_scope"),
            "paper_route_probe_only",
        )

        config.settings.trading_simple_submit_enabled = True
        sell_decision = decision.model_copy(update={"action": "sell"})
        config.settings.trading_allow_shorts = False
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=sell_decision,
            )
        )
        reducing_sell_decision = decision.model_copy(
            update={
                "action": "sell",
                "params": {
                    "price": "100",
                    "simple_lane": {
                        "quantity_resolution": {
                            "action": "sell",
                            "reason": "sell_reducing_long_fractional_allowed",
                            "short_increasing": False,
                        }
                    },
                },
            }
        )
        reducing_sell_probe_context = pipeline._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=reducing_sell_decision,
        )
        self.assertIsNotNone(reducing_sell_probe_context)
        assert reducing_sell_probe_context is not None
        self.assertEqual(reducing_sell_probe_context.get("side"), "sell")
        self.assertEqual(
            reducing_sell_probe_context.get("mode"), "paper_route_acquisition"
        )
        config.settings.trading_allow_shorts = True
        sell_probe_context = pipeline._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=sell_decision,
        )
        self.assertIsNotNone(sell_probe_context)
        assert sell_probe_context is not None
        self.assertEqual(sell_probe_context.get("side"), "sell")
        self.assertEqual(sell_probe_context.get("mode"), "paper_route_acquisition")

        config.settings.trading_simple_paper_route_probe_max_notional = 0.0
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
            )
        )

        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        closed_floor = {**proof_floor, "market_window": {"session_open": False}}
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=closed_floor,
                decision=decision,
            )
        )

        exit_bound_strategy = Strategy(
            name="paper-route-exit-bound",
            description=(
                "paper route exit-bound fixture\n[catalog_metadata]\n"
                + json.dumps({"params": {"exit_minute_after_open": "120"}})
            ),
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["NVDA"],
            max_notional_per_trade=Decimal("1000"),
        )
        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        ):
            exit_bound_probe_context = pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
                strategy=exit_bound_strategy,
            )
        self.assertIsNotNone(exit_bound_probe_context)
        assert exit_bound_probe_context is not None
        self.assertEqual(exit_bound_probe_context.get("exit_minute_after_open"), 120)
        self.assertEqual(
            exit_bound_probe_context.get("effective_exit_minute_after_open"),
            120,
        )
        self.assertEqual(
            exit_bound_probe_context.get("exit_due_at"),
            "2026-03-26T15:30:00+00:00",
        )
        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision,
                    strategy=exit_bound_strategy,
                )
            )
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=sell_decision,
                    strategy=exit_bound_strategy,
                )
            )

        no_route_reason_floor = {
            **proof_floor,
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
        }
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=no_route_reason_floor,
                decision=decision,
            )
        )

        record_level_route_repair_floor = {
            **proof_floor,
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {"candidate_symbols": ["NVDA"]},
                "records": [
                    {
                        "symbol": "NVDA",
                        "state": "probing",
                        "reason": (
                            "route_tca_passed_but_dependency_receipts_block_capital"
                        ),
                    }
                ],
            },
        }
        record_level_probe_context = pipeline._paper_route_probe_context(
            proof_floor=record_level_route_repair_floor,
            decision=decision,
        )
        self.assertIsNotNone(record_level_probe_context)
        assert record_level_probe_context is not None
        self.assertIn(
            "route_tca_passed_but_dependency_receipts_block_capital",
            cast(list[str], record_level_probe_context.get("blocking_reasons")),
        )

        symbol_level_route_repair_floor = {
            **proof_floor,
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {
                    "repair_candidate_symbols": ["NVDA"],
                    "repair_candidates": [
                        {
                            "symbol": "NVDA",
                            "state": "missing",
                            "reason": "execution_tca_symbol_missing",
                        }
                    ],
                }
            },
        }
        symbol_level_probe_context = pipeline._paper_route_probe_context(
            proof_floor=symbol_level_route_repair_floor,
            decision=decision,
        )
        self.assertIsNotNone(symbol_level_probe_context)
        assert symbol_level_probe_context is not None
        self.assertEqual(
            symbol_level_probe_context.get("mode"), "paper_route_acquisition"
        )
        self.assertIn(
            "execution_tca_symbol_missing",
            cast(list[str], symbol_level_probe_context.get("blocking_reasons")),
        )

        paper_route_probe_symbol_floor = {
            **proof_floor,
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {
                    "repair_candidate_symbols": ["MU"],
                    "paper_route_probe_eligible_symbols": ["NVDA"],
                }
            },
        }
        eligible_symbol_probe_context = pipeline._paper_route_probe_context(
            proof_floor=paper_route_probe_symbol_floor,
            decision=decision,
        )
        self.assertIsNotNone(eligible_symbol_probe_context)
        assert eligible_symbol_probe_context is not None
        self.assertEqual(
            eligible_symbol_probe_context.get("paper_route_probe_symbols"), ["NVDA"]
        )
        self.assertEqual(
            eligible_symbol_probe_context.get("route_repair_symbols"), ["MU"]
        )

        wrong_symbol_floor = {
            **proof_floor,
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["MU"]}
            },
        }
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=wrong_symbol_floor,
                decision=decision,
            )
        )

    def test_short_paper_route_probe_entry_after_exit_minute_rejected(self) -> None:
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        strategy = Strategy(
            name="paper-route-short-exit-bound",
            description=(
                "paper route short exit-bound fixture\n[catalog_metadata]\n"
                + json.dumps({"params": {"exit_minute_after_open": "120"}})
            ),
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AMZN"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AMZN",
            event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="route-probe-short-entry",
            params={"price": "200"},
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        ):
            self.assertTrue(
                pipeline._paper_route_probe_entry_after_exit_minute(
                    decision=decision,
                    strategy=strategy,
                )
            )

    def test_paper_route_probe_context_honors_external_target_plan_scope(self) -> None:
        from app import config

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="route-probe-target-plan-scope",
            params={"price": "100"},
        )
        proof_floor = {
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {
                    "repair_candidate_symbols": ["AAPL", "NVDA"],
                    "paper_route_probe_eligible_symbols": ["AAPL", "NVDA"],
                }
            },
        }
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0

        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={
                "targets": [
                    {
                        "paper_route_probe_symbols": ["AAPL"],
                        "candidate_id": "candidate-pairs-a",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "pairs-runtime-a",
                    },
                    {
                        "paper_route_probe_symbols": ["MSFT"],
                        "candidate_id": "candidate-other",
                        "hypothesis_id": "H-OTHER",
                        "strategy_name": "other-runtime",
                    },
                ]
            },
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision,
                )
            )
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision.model_copy(update={"symbol": "AAPL"}),
                )
            )
            target_source_metadata = {
                "mode": "paper_route_target_plan_source_decision",
                "paper_route_probe_next_session_max_notional": "25",
            }
            scoped_context = pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision.model_copy(
                    update={
                        "symbol": "AAPL",
                        "params": {
                            "price": "100",
                            "paper_route_target_plan": target_source_metadata,
                            "paper_route_target_plan_source_decision": (
                                target_source_metadata
                            ),
                        },
                    }
                ),
            )

        self.assertIsNotNone(scoped_context)
        assert scoped_context is not None
        self.assertEqual(
            scoped_context.get("paper_route_target_plan_symbols"), ["AAPL", "MSFT"]
        )
        self.assertEqual(
            scoped_context.get("paper_route_target_plan_source"),
            "external_target_plan_url",
        )
        self.assertEqual(
            scoped_context.get("source_candidate_ids"), ["candidate-pairs-a"]
        )
        self.assertEqual(scoped_context.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(
            scoped_context.get("source_strategy_names"), ["pairs-runtime-a"]
        )
        self.assertEqual(
            scoped_context.get("paper_route_probe_lineage_targets"),
            [
                {
                    "candidate_id": "candidate-pairs-a",
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "pairs-runtime-a",
                }
            ],
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={"load_error": "paper_route_target_plan_fetch_failed:test"},
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision.model_copy(update={"symbol": "AAPL"}),
                )
            )
        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={"targets": [{"paper_route_probe_symbols": []}]},
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision.model_copy(update={"symbol": "AAPL"}),
                )
            )

    def test_paper_decision_persists_external_target_lineage_without_gate_bypass(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100"},
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value={
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL"],
                            "candidate_id": "candidate-pairs-a",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                        }
                    ]
                },
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))

        self.assertEqual(params.get("source_candidate_ids"), ["candidate-pairs-a"])
        self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(target_plan.get("mode"), "paper_route_target_lineage")
        self.assertEqual(
            target_plan.get("paper_route_probe_lineage_targets"),
            [
                {
                    "candidate_id": "candidate-pairs-a",
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                }
            ],
        )
        self.assertNotIn("paper_route_probe", params)

    def test_external_paper_route_target_plan_cache_spans_scheduler_cycle(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_target_plan_timeout = (
            config.settings.trading_paper_route_target_plan_timeout_seconds
        )
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        now = datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc)
        try:
            with (
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    side_effect=[
                        now,
                        now + timedelta(seconds=30),
                        now + timedelta(seconds=61),
                    ],
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                    return_value={
                        "targets": [
                            {
                                "paper_route_probe_symbols": ["AAPL"],
                                "candidate_id": "candidate-pairs-a",
                            }
                        ]
                    },
                ) as fetch_plan,
            ):
                first_symbols, first_error, first_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
                second_symbols, second_error, second_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
                third_symbols, third_error, third_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
        finally:
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )
            config.settings.trading_paper_route_target_plan_timeout_seconds = (
                original_target_plan_timeout
            )

        self.assertEqual(first_symbols, {"AAPL"})
        self.assertIsNone(first_error)
        self.assertEqual(first_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(second_symbols, {"AAPL"})
        self.assertIsNone(second_error)
        self.assertEqual(second_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(third_symbols, {"AAPL"})
        self.assertIsNone(third_error)
        self.assertEqual(third_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(fetch_plan.call_count, 2)

    def test_external_paper_route_target_plan_cache_uses_recent_success_after_timeout(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_target_plan_timeout = (
            config.settings.trading_paper_route_target_plan_timeout_seconds
        )
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._paper_route_target_plan_cache = None
        pipeline._paper_route_target_plan_success_cache = None
        now = datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc)
        try:
            with (
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    side_effect=[now, now + timedelta(seconds=120)],
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                    side_effect=[
                        {
                            "targets": [
                                {
                                    "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                    "candidate_id": "candidate-pairs-a",
                                }
                            ]
                        },
                        {
                            "load_error": (
                                "paper_route_target_plan_fetch_failed:timed out"
                            ),
                        },
                    ],
                ) as fetch_plan,
            ):
                first_symbols, first_error, first_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
                second_symbols, second_error, second_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
        finally:
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )
            config.settings.trading_paper_route_target_plan_timeout_seconds = (
                original_target_plan_timeout
            )

        self.assertEqual(first_symbols, {"AAPL", "AMZN"})
        self.assertIsNone(first_error)
        self.assertEqual(first_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(second_symbols, {"AAPL", "AMZN"})
        self.assertIsNone(second_error)
        self.assertEqual(second_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(
            second_targets[0]["paper_route_target_plan_cache_status"],
            "stale_success",
        )
        self.assertEqual(
            second_targets[0]["paper_route_target_plan_last_load_error"],
            "paper_route_target_plan_fetch_failed:timed out",
        )
        self.assertEqual(fetch_plan.call_count, 2)

    def test_matching_paper_target_signal_gets_strategy_signal_paper_authority(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 5, 28, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 28, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100"},
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value={
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL"],
                            "paper_route_probe_window_start": window_start.isoformat(),
                            "paper_route_probe_window_end": window_end.isoformat(),
                            "candidate_id": "candidate-pairs-a",
                            "hypothesis_id": "H-PAIRS-01",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "strategy_lookup_names": [
                                str(strategy.id),
                                "microbar-cross-sectional-pairs-v1",
                            ],
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_REPLAY",
                            "runtime_strategy_name": (
                                "microbar-cross-sectional-pairs-v1"
                            ),
                            "evidence_collection_ok": True,
                            "canary_collection_authorized": True,
                            "bounded_evidence_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "bounded_evidence_collection_scope": (
                                "paper_route_probe_next_session_only"
                            ),
                            "bounded_evidence_collection_blockers": [],
                            "runtime_window_import_health_gate_blockers": [],
                            "paper_route_account_pre_session_blockers": [],
                            "paper_route_hpairs_symbol_blockers": [],
                            "paper_route_probe_pair_balance_state": "balanced",
                            "source_decision_readiness": {
                                "ready": True,
                                "blockers": [],
                            },
                            "paper_probation_authorized": True,
                        }
                    ]
                },
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))
            authority = cast(dict[str, Any], params.get("strategy_signal_paper"))

        self.assertEqual(params.get("source_candidate_ids"), ["candidate-pairs-a"])
        self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(params.get("source_decision_mode"), "strategy_signal_paper")
        self.assertTrue(params.get("profit_proof_eligible"))
        self.assertFalse(params.get("promotion_allowed"))
        self.assertEqual(authority.get("mode"), "strategy_signal_paper")
        self.assertEqual(authority.get("candidate_id"), "candidate-pairs-a")
        self.assertEqual(authority.get("hypothesis_id"), "H-PAIRS-01")
        self.assertEqual(
            authority.get("source_kind"), "paper_route_probe_runtime_observed"
        )
        self.assertEqual(
            authority.get("paper_route_probe_window_start"), window_start.isoformat()
        )
        self.assertEqual(
            target_plan.get("source_decision_mode"), "strategy_signal_paper"
        )
        self.assertEqual(target_plan.get("account_label"), "TORGHUT_SIM")
        self.assertEqual(
            target_plan.get("bounded_evidence_collection_scope"),
            "paper_route_probe_next_session_only",
        )
        self.assertTrue(target_plan.get("profit_proof_eligible"))
        self.assertIsNotNone(
            _bounded_sim_collection_metadata_from_decision(
                StrategyDecision(
                    strategy_id=params.get("strategy_id", ""),
                    symbol="AAPL",
                    event_ts=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
                    timeframe="1Sec",
                    action="sell",
                    qty=Decimal("1"),
                    params=params,
                ),
                account_label="TORGHUT_SIM",
                trading_mode="paper",
            )
        )
        self.assertNotIn("paper_route_probe", params)
        self.assertNotIn("paper_route_target_plan_source_decision", params)

    def test_strategy_signal_paper_uses_next_target_plan_over_closed_import_plan(
        self,
    ) -> None:
        from app import config

        closed_window_start = datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc)
        closed_window_end = datetime(2026, 5, 29, 20, 0, tzinfo=timezone.utc)
        next_window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        next_window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-target-plan"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            target_plan_payload = {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "target_count": 1,
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "paper_route_probe_window_start": (
                                closed_window_start.isoformat()
                            ),
                            "paper_route_probe_window_end": (
                                closed_window_end.isoformat()
                            ),
                            "candidate_id": "closed-friday-candidate",
                            "hypothesis_id": "H-PAIRS-01",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "paper_probation_authorized": True,
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "next_session_paper_route_runtime_window_evidence_collection",
                    "target_count": 1,
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "paper_route_probe_window_start": (
                                next_window_start.isoformat()
                            ),
                            "paper_route_probe_window_end": next_window_end.isoformat(),
                            "candidate_id": "candidate-pairs-monday",
                            "hypothesis_id": "H-PAIRS-01",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "strategy_lookup_names": [
                                str(strategy.id),
                                "microbar-cross-sectional-pairs-v1",
                            ],
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_REPLAY",
                            "runtime_strategy_name": (
                                "microbar-cross-sectional-pairs-v1"
                            ),
                            "evidence_collection_ok": True,
                            "canary_collection_authorized": True,
                            "bounded_evidence_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "bounded_evidence_collection_scope": (
                                "paper_route_probe_next_session_only"
                            ),
                            "bounded_evidence_collection_blockers": [],
                            "runtime_window_import_health_gate_blockers": [],
                            "paper_route_account_pre_session_blockers": [],
                            "paper_route_hpairs_symbol_blockers": [],
                            "paper_route_probe_pair_balance_state": "balanced",
                            "source_decision_readiness": {
                                "ready": True,
                                "blockers": [],
                            },
                            "paper_probation_authorized": True,
                        }
                    ],
                },
            }
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 6, 1, 15, 30, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100"},
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value=paper_route_target_plan_from_payload(target_plan_payload),
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            authority = cast(dict[str, Any], params.get("strategy_signal_paper"))

        self.assertEqual(params.get("source_decision_mode"), "strategy_signal_paper")
        self.assertTrue(params.get("profit_proof_eligible"))
        self.assertEqual(authority.get("candidate_id"), "candidate-pairs-monday")
        self.assertNotEqual(authority.get("candidate_id"), "closed-friday-candidate")
        self.assertEqual(
            authority.get("paper_route_probe_window_start"),
            next_window_start.isoformat(),
        )

    def test_strategy_signal_paper_target_rejects_unqualified_targets(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 5, 28, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 28, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
        )

        def make_decision(
            *,
            symbol: str = "AAPL",
            event_ts: datetime = datetime(2026, 5, 28, 15, 30),
            params: Mapping[str, Any] | None = None,
        ) -> StrategyDecision:
            return StrategyDecision(
                strategy_id=str(strategy.id),
                symbol=symbol,
                event_ts=event_ts,
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100", **dict(params or {})},
            )

        def make_target(**overrides: object) -> dict[str, object]:
            target: dict[str, object] = {
                "paper_route_probe_symbols": ["AAPL"],
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "candidate_id": "candidate-pairs-a",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "account_label": "TORGHUT_SIM",
                "source_account_label": "TORGHUT_REPLAY",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "source_kind": "paper_route_probe_runtime_observed",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "evidence_collection_ok": True,
                "canary_collection_authorized": True,
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "bounded_evidence_collection_scope": (
                    "paper_route_probe_next_session_only"
                ),
                "bounded_evidence_collection_blockers": [],
                "runtime_window_import_health_gate_blockers": [],
                "paper_route_account_pre_session_blockers": [],
                "paper_route_hpairs_symbol_blockers": [],
                "paper_route_probe_pair_balance_state": "balanced",
                "source_decision_readiness": {"ready": True, "blockers": []},
                "paper_probation_authorized": "yes",
            }
            target.update(overrides)
            return target

        good_decision = make_decision()
        good_target = make_target()

        self.assertFalse(_target_truthy(Decimal("0")))
        self.assertTrue(_target_truthy("yes"))

        config.settings.trading_mode = "live"
        self.assertIsNone(
            pipeline._strategy_signal_paper_target_for_decision(
                good_decision,
                strategy,
            )
        )

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = False
        self.assertIsNone(
            pipeline._strategy_signal_paper_target_for_decision(
                good_decision,
                strategy,
            )
        )
        config.settings.trading_simple_paper_route_probe_enabled = True

        guarded_cases: list[tuple[str, StrategyDecision, list[Mapping[str, Any]]]] = [
            (
                "source decision payload",
                make_decision(
                    params={"paper_route_target_plan_source_decision": {"mode": "x"}}
                ),
                [good_target],
            ),
            (
                "paper route probe exit",
                make_decision(params={"paper_route_probe_exit": {"mode": "x"}}),
                [good_target],
            ),
            (
                "route acquisition mode",
                make_decision(
                    params={"source_decision_mode": "route_acquisition_probe"}
                ),
                [good_target],
            ),
            ("blank symbol", make_decision(symbol=" "), [good_target]),
            (
                "empty strategy lookup names",
                good_decision,
                [
                    make_target(
                        strategy_lookup_names=[],
                        strategy_name=None,
                        strategy_id=None,
                        runtime_strategy_name=None,
                    )
                ],
            ),
            (
                "strategy mismatch",
                good_decision,
                [
                    make_target(
                        strategy_lookup_names=["other-strategy"],
                        runtime_strategy_name="other-strategy",
                    )
                ],
            ),
            ("missing candidate", good_decision, [make_target(candidate_id=None)]),
            ("missing hypothesis", good_decision, [make_target(hypothesis_id=None)]),
            ("wrong stage", good_decision, [make_target(observed_stage="backtest")]),
            ("wrong source kind", good_decision, [make_target(source_kind="manual")]),
            (
                "bounded collection blockers",
                good_decision,
                [
                    make_target(
                        paper_route_account_pre_session_blockers=[
                            "unlinked_order_events_present"
                        ]
                    )
                ],
            ),
            (
                "probation unauthorized",
                good_decision,
                [make_target(paper_probation_authorized=0)],
            ),
        ]
        for name, decision, targets in guarded_cases:
            with self.subTest(name=name):
                with patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL"}, None, targets),
                ):
                    self.assertIsNone(
                        pipeline._strategy_signal_paper_target_for_decision(
                            decision,
                            strategy,
                        )
                    )

        with patch.object(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            return_value=({"AAPL"}, "fetch failed", [good_target]),
        ):
            self.assertIsNone(
                pipeline._strategy_signal_paper_target_for_decision(
                    good_decision,
                    strategy,
                )
            )

        with patch.object(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            return_value=({"AAPL"}, None, [good_target]),
        ):
            self.assertEqual(
                pipeline._strategy_signal_paper_target_for_decision(
                    good_decision,
                    strategy,
                ),
                good_target,
            )

    def test_paper_route_target_source_skips_pair_with_open_strategy_exposure(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AMZN",
                timeframe="1Sec",
                decision_json={
                    "action": "sell",
                    "qty": "10",
                    "event_ts": (window_start + timedelta(minutes=3)).isoformat(),
                    "params": {
                        "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                        "profit_proof_eligible": False,
                        "paper_route_probe": {
                            "mode": "paper_route_acquisition",
                            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                            "profit_proof_eligible": False,
                        },
                    },
                },
                rationale="paper-route-entry",
                status="filled",
                created_at=window_start + timedelta(minutes=3),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="paper-amzn-open",
                    client_order_id="paper-amzn-open-client",
                    symbol="AMZN",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("10"),
                    filled_qty=Decimal("10"),
                    avg_fill_price=Decimal("272"),
                    status="filled",
                    raw_order={},
                    created_at=window_start + timedelta(minutes=4),
                    updated_at=window_start + timedelta(minutes=4),
                )
            )
            session.commit()

            target = {
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "source_kind": "paper_route_probe_runtime_observed",
                "candidate_id": "candidate-pairs-monday",
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "strategy_family": "microbar_cross_sectional_pairs",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_next_session_max_notional": "1000",
                "bounded_evidence_collection_authorized": True,
                "evidence_collection_ok": True,
                "source_decision_readiness": {"ready": True, "blockers": []},
                "runtime_window_import_health_gate_blockers": [
                    "evidence_continuity_not_ok"
                ],
                "runtime_window_import_promotion_blockers": ["drift_checks_not_ok"],
            }
            setattr(
                pipeline,
                "_external_paper_route_target_probe_symbols_cached",
                lambda: ({"AAPL", "AMZN"}, None, [target]),
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=window_start + timedelta(minutes=5),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols=set(),
                    positions=[],
                    session=session,
                )

        self.assertEqual(decisions, [])

    def test_paper_route_target_source_allows_flat_repaired_strategy_exposure(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AMZN",
                timeframe="1Sec",
                decision_json={
                    "action": "sell",
                    "qty": "10",
                    "event_ts": (
                        window_start - timedelta(days=3) + timedelta(minutes=3)
                    ).isoformat(),
                    "params": {
                        "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                        "profit_proof_eligible": False,
                    },
                },
                rationale="paper-route-entry",
                status="filled",
                created_at=window_start - timedelta(days=3) + timedelta(minutes=3),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="paper-amzn-stale-open",
                    client_order_id="paper-amzn-stale-open-client",
                    symbol="AMZN",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("10"),
                    filled_qty=Decimal("10"),
                    avg_fill_price=Decimal("272"),
                    status="filled",
                    raw_order={},
                    created_at=window_start - timedelta(days=3) + timedelta(minutes=2),
                    updated_at=window_start - timedelta(days=3) + timedelta(minutes=2),
                )
            )
            session.add(
                PositionSnapshot(
                    alpaca_account_label="TORGHUT_SIM",
                    as_of=window_start - timedelta(minutes=5),
                    equity=Decimal("100000"),
                    cash=Decimal("100000"),
                    buying_power=Decimal("200000"),
                    positions=[],
                )
            )
            session.commit()

            target = {
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "source_kind": "paper_route_probe_runtime_observed",
                "candidate_id": "candidate-pairs-monday",
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "strategy_family": "microbar_cross_sectional_pairs",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_next_session_max_notional": "1000",
                "bounded_evidence_collection_authorized": True,
                "evidence_collection_ok": True,
                "source_decision_readiness": {"ready": True, "blockers": []},
                "runtime_window_import_health_gate_blockers": [
                    "evidence_continuity_not_ok"
                ],
                "runtime_window_import_promotion_blockers": ["drift_checks_not_ok"],
            }
            setattr(
                pipeline,
                "_external_paper_route_target_probe_symbols_cached",
                lambda: ({"AAPL", "AMZN"}, None, [target]),
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=window_start + timedelta(minutes=5),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols=set(),
                    positions=[],
                    session=session,
                )

        self.assertEqual(
            [(decision.symbol, decision.action) for decision in decisions],
            [("AAPL", "buy"), ("AMZN", "sell")],
        )

    def test_bounded_hpairs_target_source_records_decisions_and_executions(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        now = window_start + timedelta(minutes=15)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_max_notional_per_order = 1000.0
        config.settings.trading_simple_max_notional_per_symbol = 1000.0

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            target = {
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "source_kind": "paper_route_probe_runtime_observed",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "strategy_family": "microbar_cross_sectional_pairs",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_next_session_max_notional": "0",
                "bounded_evidence_collection_max_notional": "500",
                "max_notional": "0",
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
                "evidence_collection_ok": True,
                "source_decision_readiness": {"ready": True, "blockers": []},
                "runtime_window_import_health_gate_blockers": [
                    "evidence_continuity_not_ok"
                ],
                "paper_route_account_pre_session_blockers": [],
                "paper_route_hpairs_symbol_blockers": [],
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
            }
            proof_floor = {
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "market_window": {"session_open": True},
                "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            }

            def priced_decision(
                decision: StrategyDecision, signal_price: object = None
            ) -> tuple[StrategyDecision, MarketSnapshot | None]:
                del signal_price
                params = dict(decision.params)
                params["price"] = Decimal("100")
                return decision.model_copy(update={"params": params}), None

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value=proof_floor,
                ),
                patch.object(
                    pipeline,
                    "_ensure_decision_price",
                    side_effect=priced_decision,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
                patch(
                    "app.trading.scheduler.pipeline.trading_now",
                    return_value=now,
                ),
            ):
                pipeline._process_paper_route_target_source_decisions(
                    session=session,
                    strategies=[strategy],
                    account=alpaca_client.get_account(),
                    positions=[],
                    allowed_symbols={"AAPL", "AMZN"},
                )

            decisions = session.execute(
                select(TradeDecision).order_by(TradeDecision.symbol)
            ).scalars().all()
            executions = session.execute(
                select(Execution).order_by(Execution.symbol)
            ).scalars().all()

        self.assertEqual([decision.symbol for decision in decisions], ["AAPL", "AMZN"])
        self.assertEqual(
            [decision.status for decision in decisions], ["submitted", "submitted"]
        )
        self.assertEqual(
            [execution.symbol for execution in executions], ["AAPL", "AMZN"]
        )
        self.assertEqual(len(alpaca_client.submitted), 2)
        for decision in decisions:
            payload = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], payload.get("params") or {})
            metadata = cast(
                dict[str, Any], params.get("paper_route_target_plan") or {}
            )
            self.assertEqual(
                metadata.get("paper_route_probe_next_session_max_notional"), "500"
            )
            self.assertFalse(params.get("promotion_allowed"))
            self.assertFalse(params.get("final_promotion_allowed"))
            self.assertFalse(params.get("final_promotion_authorized"))
            self.assertEqual(params.get("execution_account_label"), "TORGHUT_SIM")

    def test_paper_route_target_source_skips_pair_when_account_not_flat(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            target = {
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "source_kind": "paper_route_probe_runtime_observed",
                "candidate_id": "candidate-pairs-monday",
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "strategy_family": "microbar_cross_sectional_pairs",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_next_session_max_notional": "1000",
                "bounded_evidence_collection_authorized": True,
                "evidence_collection_ok": True,
                "source_decision_readiness": {"ready": True, "blockers": []},
            }
            setattr(
                pipeline,
                "_external_paper_route_target_probe_symbols_cached",
                lambda: ({"AAPL", "AMZN"}, None, [target]),
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=window_start + timedelta(minutes=5),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols=set(),
                    positions=[{"symbol": "NVDA", "qty": "1", "side": "long"}],
                    session=session,
                )

        self.assertEqual(decisions, [])

    def test_paper_route_target_plan_reserves_account_for_collection(self) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)
        target = {
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "bounded_evidence_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "runtime_window_import_health_gate_blockers": [
                "evidence_continuity_not_ok"
            ],
            "runtime_window_import_promotion_blockers": ["drift_checks_not_ok"],
        }
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda: ({"AAPL", "AMZN"}, None, [target]),
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=window_start + timedelta(minutes=5),
        ):
            reserves = pipeline._paper_route_target_plan_reserves_account(
                allowed_symbols=set()
            )

        self.assertTrue(reserves)

    def test_run_once_commits_and_skips_regular_signals_when_target_reserves_account(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={"price": Decimal("100")},
            timeframe="1Min",
        )
        ingestor = FakeIngestor([signal])
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "session_factory", self.session_local)
        setattr(pipeline, "state", TradingState())
        setattr(pipeline, "ingestor", ingestor)
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
        )
        setattr(pipeline, "_label_mature_rejected_signal_outcome_events", lambda: None)
        setattr(pipeline, "_prepare_run_once", lambda _session: [strategy])
        setattr(
            pipeline,
            "_capture_runtime_window_account_snapshot_if_due",
            lambda _session: None,
        )
        setattr(
            pipeline,
            "_warm_session_context_from_open",
            lambda _session, *, strategies: None,
        )
        setattr(pipeline, "_record_ingest_window", lambda _batch: None)
        setattr(
            pipeline,
            "_build_run_context",
            lambda _session: ({}, {}, [], {"AAPL", "AMZN"}),
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_exit_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_target_source_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_paper_route_target_plan_reserves_account",
            lambda *, allowed_symbols: True,
        )
        setattr(
            pipeline,
            "_quality_gate_signals",
            Mock(side_effect=AssertionError("regular signal path should be skipped")),
        )

        pipeline.run_once()

        self.assertEqual(ingestor.committed_batches, 1)

    def test_run_once_blocks_bounded_target_decisions_when_signal_ingest_times_out(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,AMZN"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL,AMZN"

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": "250",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "evidence_collection_ok": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "paper_route_probe_pair_balance_state": "balanced",
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        ingestor = NoSignalReasonIngestor(
            no_signal_reason="clickhouse_signal_query_timeout"
        )
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=ingestor,
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, [target]),
            ),
            patch("app.trading.scheduler.simple_pipeline.trading_now", return_value=now),
            patch("app.trading.scheduler.pipeline.trading_now", return_value=now),
        ):
            pipeline.run_once()

        self.assertEqual(ingestor.fetch_scopes, [({"AAPL", "AMZN"}, {"1Sec"})])
        self.assertEqual(alpaca_client.submitted, [])
        self.assertEqual(pipeline.state.last_ingest_reason, "clickhouse_signal_query_timeout")
        self.assertEqual(
            pipeline.state.last_signal_continuity_reason,
            "clickhouse_signal_query_timeout",
        )
        self.assertTrue(bool(pipeline.state.last_signal_continuity_actionable))
        blocker = cast(
            dict[str, Any],
            getattr(pipeline.state, "last_bounded_evidence_collection_blocker"),
        )
        self.assertEqual(blocker.get("blockers"), ["clickhouse_signal_query_timeout"])
        self.assertFalse(blocker.get("signals_authoritative"))
        with self.session_local() as session:
            self.assertEqual(list(session.execute(select(TradeDecision)).scalars()), [])
            self.assertEqual(list(session.execute(select(Execution)).scalars()), [])

    def test_run_once_scopes_hpairs_signal_ingest_and_emits_candidate_decisions(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,AMZN"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL,AMZN"

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signals = [
            SignalEnvelope(
                event_ts=now,
                symbol="AAPL",
                payload={"price": Decimal("100")},
                timeframe="1Sec",
                seq=1,
            ),
            SignalEnvelope(
                event_ts=now,
                symbol="AMZN",
                payload={"price": Decimal("100")},
                timeframe="1Sec",
                seq=2,
            ),
        ]
        target = {
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": "250",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "evidence_collection_ok": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "paper_route_probe_pair_balance_state": "balanced",
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        ingestor = FakeIngestor(signals, cursor_at=now, cursor_seq=2, cursor_symbol="AMZN")
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=ingestor,
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value={
                    "route_state": "repair_only",
                    "capital_state": "zero_notional",
                    "max_notional": "0",
                    "market_window": {"session_open": True},
                    "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
                },
            ),
            patch("app.trading.scheduler.simple_pipeline.trading_now", return_value=now),
            patch("app.trading.scheduler.pipeline.trading_now", return_value=now),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()

        self.assertEqual(ingestor.fetch_scopes, [({"AAPL", "AMZN"}, {"1Sec"})])
        self.assertEqual(ingestor.committed_batches, 1)
        with self.session_local() as session:
            decisions = list(session.execute(select(TradeDecision)).scalars())
            self.assertEqual(len(decisions), 2)
            symbols = sorted(decision.symbol for decision in decisions)
            self.assertEqual(symbols, ["AAPL", "AMZN"])
            for decision in decisions:
                decision_json = cast(dict[str, Any], decision.decision_json)
                params = cast(dict[str, Any], decision_json.get("params"))
                self.assertEqual(
                    params.get("source_decision_mode"),
                    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                )
                self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
                target_plan = cast(
                    dict[str, Any],
                    params.get("paper_route_target_plan"),
                )
                self.assertEqual(target_plan.get("candidate_id"), "candidate-pairs-monday")

    def test_fetch_signal_batch_falls_back_for_legacy_ingestor_signature(self) -> None:
        class LegacyIngestor:
            def __init__(self) -> None:
                self.calls = 0

            def fetch_signals(self, session: Session) -> SignalBatch:
                self.calls += 1
                return SignalBatch(
                    signals=[],
                    cursor_at=None,
                    cursor_seq=None,
                    cursor_symbol=None,
                )

        ingestor = LegacyIngestor()
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "ingestor", ingestor)

        with self.session_local() as session:
            batch = pipeline._fetch_signal_batch(
                session,
                signal_scope=({"AAPL"}, {"1Sec"}),
            )

        self.assertEqual(batch.signals, [])
        self.assertEqual(ingestor.calls, 1)

    def test_bounded_signal_scope_skips_unusable_targets_before_valid_target(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )

        def target(**overrides: object) -> dict[str, object]:
            item: dict[str, object] = {
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "candidate_id": "candidate-pairs-monday",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "source_kind": "paper_route_probe_runtime_observed",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "account_label": "TORGHUT_SIM",
                "evidence_collection_ok": True,
                "canary_collection_authorized": True,
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "bounded_evidence_collection_scope": (
                    "paper_route_probe_next_session_only"
                ),
                "bounded_evidence_collection_blockers": [],
                "runtime_window_import_health_gate_blockers": [],
                "paper_route_account_pre_session_blockers": [],
                "paper_route_hpairs_symbol_blockers": [],
                "paper_route_probe_pair_balance_state": "balanced",
                "source_decision_readiness": {"ready": True, "blockers": []},
            }
            item.update(overrides)
            return item

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
        targets = [
            target(paper_route_account_pre_session_blockers=["not_flat"]),
            target(paper_route_probe_window_start=None, paper_route_probe_window_end=None),
            target(
                paper_route_probe_window_start=(
                    window_start - timedelta(days=1)
                ).isoformat(),
                paper_route_probe_window_end=(window_end - timedelta(days=1)).isoformat(),
            ),
            target(strategy_name="missing-strategy", runtime_strategy_name="missing"),
            target(),
        ]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, targets),
            ),
            patch("app.trading.scheduler.simple_pipeline.trading_now", return_value=now),
        ):
            scope = pipeline._bounded_paper_route_signal_scope([strategy])

        self.assertEqual(scope, ({"AAPL", "AMZN"}, {"1Sec"}))

    def test_paper_route_target_plan_reservation_rejects_unusable_targets(self) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        now = window_start + timedelta(minutes=5)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        base_target = {
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "bounded_evidence_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
        }
        targets = [
            {
                **base_target,
                "paper_route_account_pre_session_blockers": [
                    "unlinked_order_events_present"
                ],
            },
            {**base_target, "paper_route_probe_window_start": None},
            {
                **base_target,
                "paper_route_probe_window_start": (
                    window_start + timedelta(days=1)
                ).isoformat(),
                "paper_route_probe_window_end": (
                    window_end + timedelta(days=1)
                ).isoformat(),
            },
            base_target,
        ]
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda: ({"AAPL", "AMZN"}, None, targets),
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=now,
        ):
            setattr(pipeline, "_is_market_session_open", lambda _now: False)
            self.assertFalse(
                pipeline._paper_route_target_plan_reserves_account(
                    allowed_symbols=set()
                )
            )
            setattr(pipeline, "_is_market_session_open", lambda _now: True)
            self.assertFalse(
                pipeline._paper_route_target_plan_reserves_account(
                    allowed_symbols={"MSFT"}
                )
            )

    def test_paper_route_flat_repair_snapshot_handles_query_and_shape_failures(
        self,
    ) -> None:
        class RaisingSession:
            def execute(self, *_args: object, **_kwargs: object) -> object:
                raise RuntimeError("snapshot query failed")

        class ResultWithStringPositions:
            def first(self) -> tuple[str, datetime]:
                return (
                    "not-a-position-list",
                    datetime(2026, 6, 1, tzinfo=timezone.utc),
                )

        class StringPositionsSession:
            def execute(
                self, *_args: object, **_kwargs: object
            ) -> ResultWithStringPositions:
                return ResultWithStringPositions()

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_flat_repair_snapshot(
                session=cast(Session, RaisingSession()),
                account_label="TORGHUT_SIM",
                symbol="AMZN",
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_flat_repair_snapshot(
                session=cast(Session, StringPositionsSession()),
                account_label="TORGHUT_SIM",
                symbol="AMZN",
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_account_exposure_detects_market_value(self) -> None:
        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_account_has_open_exposure(
                [{"symbol": "NVDA", "qty": "0", "market_value": "10"}]
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_account_has_open_exposure(
                [{"symbol": "NVDA", "qty": "0", "market_value": "0"}]
            )
        )

    def test_paper_decision_persists_external_target_lineage_existing_row(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AMZN"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AMZN",
                event_ts=datetime(2026, 3, 26, 14, 31, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "200"},
            )
            existing = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                pipeline.account_label,
            )
            existing_payload = cast(dict[str, Any], existing.decision_json)
            existing_params = cast(dict[str, Any], existing_payload.get("params"))
            self.assertNotIn("paper_route_target_plan", existing_params)

            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value={
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AMZN"],
                            "candidate_id": "candidate-pairs-a",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                        }
                    ]
                },
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            self.assertEqual(row.id, existing.id)
            session.refresh(row)
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))

        self.assertEqual(params.get("source_candidate_ids"), ["candidate-pairs-a"])
        self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(target_plan.get("mode"), "paper_route_target_lineage")
        self.assertNotIn("paper_route_probe", params)

    def test_paper_route_target_lineage_cache_and_existing_plan_merge(self) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        first = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            params={
                "price": "100",
                "paper_route_target_plan": {
                    "existing": "keep",
                    "source_candidate_ids": ["candidate-existing"],
                },
            },
        )
        second = first.model_copy(update={"symbol": "MSFT", "params": {"price": "200"}})
        fetch = Mock(
            return_value={
                "targets": [
                    {
                        "paper_route_probe_symbols": ["AAPL"],
                        "candidate_id": "candidate-aapl",
                        "hypothesis_id": "H-AAPL",
                        "strategy_name": "pairs-runtime-a",
                        "strategy_lookup_names": ["strategy-1"],
                    },
                    {
                        "paper_route_probe_symbols": ["MSFT"],
                        "candidate_id": "candidate-msft",
                        "hypothesis_id": "H-MSFT",
                        "strategy_name": "pairs-runtime-b",
                        "strategy_lookup_names": ["strategy-1"],
                    },
                ]
            }
        )

        with (
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 31, tzinfo=timezone.utc),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                fetch,
            ),
        ):
            enriched_first = pipeline._with_paper_route_target_lineage(first)
            enriched_second = pipeline._with_paper_route_target_lineage(second)

        self.assertEqual(fetch.call_count, 1)
        first_params = cast(dict[str, Any], enriched_first.params)
        first_target_plan = cast(
            dict[str, Any], first_params.get("paper_route_target_plan")
        )
        self.assertEqual(first_target_plan.get("existing"), "keep")
        self.assertEqual(
            first_target_plan.get("source_candidate_ids"),
            ["candidate-existing", "candidate-aapl"],
        )
        self.assertEqual(first_params.get("source_candidate_ids"), ["candidate-aapl"])
        self.assertEqual(first_params.get("source_hypothesis_ids"), ["H-AAPL"])
        second_params = cast(dict[str, Any], enriched_second.params)
        second_target_plan = cast(
            dict[str, Any], second_params.get("paper_route_target_plan")
        )
        self.assertEqual(
            second_target_plan.get("source_candidate_ids"), ["candidate-msft"]
        )
        self.assertEqual(second_params.get("source_hypothesis_ids"), ["H-MSFT"])
        self.assertNotIn("paper_route_probe", first_params)
        self.assertNotIn("paper_route_probe", second_params)

    def test_paper_route_target_lineage_rejects_strategy_mismatch(self) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="microbar-volume-continuation-long-top2-chip-v1@paper",
            symbol="AAPL",
            event_ts=datetime(2026, 5, 29, 17, 27, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            params={"price": "310.49"},
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={
                "targets": [
                    {
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_window_start": "2026-05-29T13:30:00+00:00",
                        "paper_route_probe_window_end": "2026-05-29T20:00:00+00:00",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "strategy_lookup_names": [
                            "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                            "microbar-cross-sectional-pairs-v1",
                        ],
                        "source_kind": "paper_route_probe_runtime_observed",
                    }
                ]
            },
        ):
            enriched = pipeline._with_paper_route_target_lineage(decision)

        self.assertNotIn("paper_route_target_plan", enriched.params)
        self.assertNotIn("source_candidate_ids", enriched.params)
        self.assertNotIn("source_hypothesis_ids", enriched.params)

    def test_paper_route_target_lineage_skips_empty_symbol_and_empty_lineage(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        base = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            params={"price": "100"},
        )
        fetch = Mock(
            return_value={"targets": [{"paper_route_probe_symbols": ["AAPL"]}]}
        )

        blank_symbol = pipeline._with_paper_route_target_lineage(
            base.model_copy(update={"symbol": "   "})
        )
        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            fetch,
        ):
            empty_lineage = pipeline._with_paper_route_target_lineage(base)

        self.assertNotIn("paper_route_target_plan", blank_symbol.params)
        self.assertNotIn("paper_route_target_plan", empty_lineage.params)
        self.assertEqual(fetch.call_count, 1)

    def test_paper_route_probe_short_increasing_sell_classification(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="route-probe-short-classification",
            params={"price": "100"},
        )

        self.assertFalse(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(decision)
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {"simple_lane": "missing-resolution"},
                    }
                )
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {"simple_lane": {"quantity_resolution": "missing"}},
                    }
                )
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "simple_lane": {
                                "quantity_resolution": {"short_increasing": "yes"}
                            }
                        },
                    }
                )
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "simple_lane": {
                                "quantity_resolution": {"short_increasing": "off"}
                            }
                        },
                    }
                )
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "sizing": {
                                "quantity_resolution": {
                                    "reason": "sell_reducing_long_fractional_allowed"
                                }
                            }
                        },
                    }
                )
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "sizing": {
                                "quantity_resolution": {
                                    "reason": "sell_short_increasing_fractional_allowed"
                                }
                            }
                        },
                    }
                )
            )
        )

    def test_paper_route_probe_cap_rejects_missing_or_tiny_quantity(
        self,
    ) -> None:
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        missing_price_decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-price",
            params={},
        )
        priced_decision = missing_price_decision.model_copy(
            update={"params": {"price": "100"}}
        )

        self.assertFalse(
            pipeline._paper_route_probe_capped_decision(
                decision=missing_price_decision,
                proof_floor={},
                context={"max_notional": "25"},
            )
        )
        self.assertFalse(
            pipeline._paper_route_probe_capped_decision(
                decision=priced_decision,
                proof_floor={},
                context={"max_notional": "0.00001"},
            )
        )

    def test_simple_pipeline_blocks_symbol_excluded_from_route_candidates(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live-route-filter",
                description="simple live lane route candidate filter",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        proof_floor = {
            "route_state": "live_micro_candidate",
            "capital_state": "live_allowed",
            "max_notional": "1000",
            "blocking_reasons": [],
            "route_reacquisition_book": {
                "summary": {
                    "scope_symbol_count": 2,
                    "candidate_symbols": ["AAPL"],
                    "repair_candidate_symbols": ["NVDA"],
                }
            },
        }
        with (
            patch.object(
                SimpleTradingPipeline,
                "_live_submission_gate",
                return_value={
                    "allowed": True,
                    "reason": "promotion_certificate_valid",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                },
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            persisted_floor = cast(
                dict[str, Any], decision_json.get("profitability_proof_floor")
            )
            route_book = cast(
                dict[str, Any], persisted_floor.get("route_reacquisition_book")
            )
            route_summary = cast(dict[str, Any], route_book.get("summary"))

            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_stage"),
                "blocked_profitability_route_symbol",
            )
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "profitability_route_symbol_excluded",
            )
            self.assertEqual(route_summary.get("candidate_symbols"), ["AAPL"])

    def test_simple_pipeline_skips_out_of_strategy_universe_signals_before_quote_quality(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_kill_switch_enabled = False

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-universe-filter",
                description="simple lane universe filter regression",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        allowed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )
        out_of_universe_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, 1, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 6, tzinfo=timezone.utc),
            symbol="MSFT",
            timeframe="1Min",
            seq=2,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
                "spread": 1,
            },
        )

        alpaca_client = FakeAlpacaClient()
        decision_engine = RecordingDecisionEngine()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([allowed_signal, out_of_universe_signal]),
            decision_engine=decision_engine,
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        pipeline.run_once()

        self.assertNotIn("MSFT", decision_engine.observed_symbols)

    def test_simple_pipeline_reconcile_updates_execution_status(self) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-reconcile",
                description="simple reconcile lane",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "paper_ready",
                "capital_state": "paper",
                "max_notional": "1000",
                "blocking_reasons": [],
            },
        ):
            pipeline.run_once()
        updates = pipeline.reconcile()

        self.assertEqual(updates, 1)
        with self.session_local() as session:
            execution = session.execute(select(Execution)).scalar_one()
            self.assertEqual(execution.status, "filled")

    def test_simple_pipeline_uses_client_order_id_for_idempotency(self) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-idempotency",
                description="simple idempotency",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "paper_ready",
                "capital_state": "paper",
                "max_notional": "1000",
                "blocking_reasons": [],
            },
        ):
            pipeline.run_once()
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        with self.session_local() as session:
            self.assertEqual(session.query(Execution).count(), 1)

    def test_simple_pipeline_blocks_shorts_when_asset_is_not_shortable(self) -> None:
        from app import config

        class _ShortBlockedClient(FakeAlpacaClient):
            def get_account(self) -> dict[str, str | bool]:
                account = super().get_account()
                account["shorting_enabled"] = True
                return account

            def get_asset(self, symbol_or_asset_id: str) -> dict[str, str | bool]:
                return {
                    "symbol": symbol_or_asset_id,
                    "tradable": True,
                    "shortable": False,
                }

        config.settings.trading_allow_shorts = True
        pipeline = SimpleTradingPipeline(
            alpaca_client=_ShortBlockedClient(),
            order_firewall=OrderFirewall(_ShortBlockedClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="shortability-check",
            params={"price": "100"},
        )

        reason = pipeline._simple_shortability_reason(decision=decision, positions=[])

        self.assertEqual(reason, "shorting_not_allowed_for_asset")

    def test_simple_pipeline_projects_remaining_buying_power_after_buy(self) -> None:
        account = {"buying_power": "150", "equity": "1000", "cash": "150"}
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="buying-power-projection",
            params={"price": "100", "simple_lane": {"notional": "100"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            account,
            [],
            decision,
        )

        self.assertEqual(Decimal(account["buying_power"]), Decimal("50"))

    def test_simple_pipeline_projects_short_increase_buying_power_for_excess_qty(
        self,
    ) -> None:
        account = {"buying_power": "150", "equity": "1000", "cash": "150"}
        positions = [{"symbol": "AAPL", "qty": "1", "side": "long"}]
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("3"),
            rationale="short-increase-projection",
            params={"price": "50", "simple_lane": {"notional": "150"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            account,
            positions,
            decision,
        )

        self.assertEqual(Decimal(account["buying_power"]), Decimal("50"))

    def test_simple_pipeline_skips_buying_power_projection_without_inputs(
        self,
    ) -> None:
        missing_buying_power = {"equity": "1000", "cash": "150"}
        buy_decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-buying-power",
            params={"price": "100"},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            missing_buying_power,
            [],
            buy_decision,
        )

        self.assertNotIn("buying_power", missing_buying_power)

        missing_notional = {"buying_power": "150", "equity": "1000", "cash": "150"}
        no_price_decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-notional",
            params={},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            missing_notional,
            [],
            no_price_decision,
        )

        self.assertEqual(Decimal(missing_notional["buying_power"]), Decimal("150"))

    def test_simple_pipeline_projects_notional_from_price_when_lane_missing(
        self,
    ) -> None:
        account = {"buying_power": "150", "equity": "1000", "cash": "150"}
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="price-notional-fallback",
            params={"price": "100"},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            account,
            [],
            decision,
        )

        self.assertEqual(Decimal(account["buying_power"]), Decimal("50"))

    def test_simple_pipeline_skips_projection_when_exposure_does_not_increase(
        self,
    ) -> None:
        reducing_sell_account = {
            "buying_power": "150",
            "equity": "1000",
            "cash": "150",
        }
        reducing_sell = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="reducing-sell",
            params={"price": "100", "simple_lane": {"notional": "100"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            reducing_sell_account,
            [{"symbol": "AAPL", "qty": "2", "side": "long"}],
            reducing_sell,
        )

        self.assertEqual(
            Decimal(reducing_sell_account["buying_power"]),
            Decimal("150"),
        )

        zero_qty_sell_account = {
            "buying_power": "150",
            "equity": "1000",
            "cash": "150",
        }
        zero_qty_sell = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("0"),
            rationale="zero-qty-sell",
            params={"price": "100", "simple_lane": {"notional": "100"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            zero_qty_sell_account,
            [],
            zero_qty_sell,
        )

        self.assertEqual(
            Decimal(zero_qty_sell_account["buying_power"]),
            Decimal("150"),
        )

    def test_execution_routing_uses_order_firewall_for_non_simulation_adapter(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

        self.assertIs(
            pipeline._execution_client_for_symbol("MSFT"),
            pipeline.order_firewall,
        )
        self.assertIs(
            pipeline._execution_client_for_symbol("AAPL"),
            pipeline.order_firewall,
        )

    def test_execution_routing_uses_simulation_adapter_when_active(self) -> None:
        alpaca_client = FakeAlpacaClient()
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-route",
            dataset_id="dataset-route",
        )
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=execution_adapter,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

        self.assertIs(
            pipeline._execution_client_for_symbol("MSFT"),
            execution_adapter,
        )

    def test_pipeline_skips_stale_feature_batch_and_commits_cursor(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="quality-gate regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            stale_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )

            execution_adapter = FakeAlpacaClient()
            ingestor = CursorAdvancingFakeIngestor(
                [stale_signal],
                cursor_at=stale_signal.event_ts,
                cursor_seq=stale_signal.seq,
                cursor_symbol=stale_signal.symbol,
            )
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 2)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 1)
            self.assertEqual(
                state.metrics.feature_quality_reject_reason_total.get(
                    "feature_staleness_exceeds_budget"
                ),
                1,
            )
            self.assertIsNone(
                state.metrics.feature_quality_cursor_commit_blocked_total.get(
                    "feature_staleness_exceeds_budget"
                )
            )
            self.assertGreater(state.metrics.feature_staleness_ms_p95, 1_000)
            self.assertEqual(execution_adapter.submitted, [])
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]

    def test_signal_batch_preserves_lag_metric_for_alpha_readiness(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )
        batch = SignalBatch(
            signals=[_with_default_executable_quote(signal)],
            cursor_at=signal.event_ts,
            cursor_seq=signal.seq,
            cursor_symbol=signal.symbol,
            query_start=signal.event_ts - timedelta(seconds=10),
            query_end=signal.event_ts,
            signal_lag_seconds=4.9,
        )
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with self.session_local() as session:
            prepared = pipeline._prepare_batch_for_decisions(
                session,
                batch,
                quality_signals=batch.signals,
            )

        self.assertTrue(prepared)
        self.assertEqual(pipeline.state.metrics.signal_lag_seconds, 4)
        self.assertEqual(pipeline.state.last_signal_continuity_state, "signals_present")
        self.assertFalse(bool(pipeline.state.last_signal_continuity_actionable))

    def test_signal_batch_counts_feature_rows_when_quality_enforcement_disabled(
        self,
    ) -> None:
        from app import config

        original = config.settings.trading_feature_quality_enabled
        config.settings.trading_feature_quality_enabled = False
        try:
            signal = SignalEnvelope(
                event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )
            batch = SignalBatch(
                signals=[_with_default_executable_quote(signal)],
                cursor_at=signal.event_ts,
                cursor_seq=signal.seq,
                cursor_symbol=signal.symbol,
                query_start=signal.event_ts - timedelta(seconds=10),
                query_end=signal.event_ts,
                signal_lag_seconds=4.9,
            )
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            with self.session_local() as session:
                prepared = pipeline._prepare_batch_for_decisions(
                    session,
                    batch,
                    quality_signals=batch.signals,
                )

            self.assertTrue(prepared)
            self.assertEqual(pipeline.state.metrics.feature_batch_rows_total, 1)
        finally:
            config.settings.trading_feature_quality_enabled = original

    def test_pipeline_blocks_cursor_on_non_staleness_feature_quality_failure(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="schema quality-gate regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            malformed_schema_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "2.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )

            execution_adapter = FakeAlpacaClient()
            ingestor = FakeIngestor(
                [malformed_schema_signal],
                cursor_at=malformed_schema_signal.event_ts,
                cursor_seq=malformed_schema_signal.seq,
                cursor_symbol=malformed_schema_signal.symbol,
            )
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 0)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 1)
            self.assertEqual(
                state.metrics.feature_quality_reject_reason_total.get(
                    "schema_mismatch"
                ),
                1,
            )
            self.assertEqual(
                state.metrics.feature_quality_cursor_commit_blocked_total.get(
                    "schema_mismatch"
                ),
                1,
            )
            self.assertEqual(execution_adapter.submitted, [])
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]

    def test_pipeline_accepts_replayed_batch_in_simulation_mode(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000
        config.settings.trading_kill_switch_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="simulation replay staleness regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            replayed_signal = SignalEnvelope(
                event_ts=datetime(2026, 3, 13, 13, 30, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 3, 15, 4, 2, 24, 236000, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )

            alpaca_client = FakeAlpacaClient()
            execution_adapter = FakeAlpacaClient()
            ingestor = FakeIngestor([replayed_signal])
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            with patch(
                "app.trading.features.simulation_context_enabled",
                return_value=True,
            ):
                pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 1)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 0)
            self.assertEqual(state.metrics.feature_staleness_ms_p95, 0)
            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_pipeline_suppresses_no_signal_alert_during_bootstrap_grace(self) -> None:
        from app import config

        original = {
            "trading_signal_no_signal_streak_alert_threshold": config.settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_bootstrap_grace_seconds": config.settings.trading_signal_bootstrap_grace_seconds,
        }
        config.settings.trading_signal_no_signal_streak_alert_threshold = 1
        config.settings.trading_signal_bootstrap_grace_seconds = 180

        try:
            state = TradingState()
            state.signal_bootstrap_started_at = datetime.now(timezone.utc)
            state.signal_bootstrap_completed_at = None
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            with patch(
                "app.trading.scheduler.pipeline._signal_bootstrap_grace_active",
                return_value=True,
            ):
                pipeline.record_no_signal_batch(
                    SignalBatch(
                        signals=[],
                        cursor_at=datetime(2026, 3, 13, 13, 30, tzinfo=timezone.utc),
                        cursor_seq=1,
                        cursor_symbol="AAPL",
                        no_signal_reason="no_signals_in_window",
                    )
                )

            self.assertFalse(state.last_signal_continuity_actionable)
            self.assertFalse(state.signal_continuity_alert_active)
            self.assertEqual(state.metrics.signal_continuity_actionable, 0)
            self.assertEqual(
                state.metrics.signal_expected_staleness_total.get(
                    "no_signals_in_window"
                ),
                1,
            )
        finally:
            config.settings.trading_signal_no_signal_streak_alert_threshold = original[
                "trading_signal_no_signal_streak_alert_threshold"
            ]
            config.settings.trading_signal_bootstrap_grace_seconds = original[
                "trading_signal_bootstrap_grace_seconds"
            ]

    def test_pipeline_treats_fresh_tail_state_as_expected_staleness(self) -> None:
        from app import config

        original = {
            "trading_signal_no_signal_streak_alert_threshold": config.settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_stale_lag_alert_seconds": config.settings.trading_signal_stale_lag_alert_seconds,
            "trading_signal_bootstrap_grace_seconds": config.settings.trading_signal_bootstrap_grace_seconds,
        }
        config.settings.trading_signal_no_signal_streak_alert_threshold = 1
        config.settings.trading_signal_stale_lag_alert_seconds = 300
        config.settings.trading_signal_bootstrap_grace_seconds = 0

        try:
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            pipeline.record_no_signal_batch(
                SignalBatch(
                    signals=[],
                    cursor_at=datetime(2026, 5, 5, 18, 3, tzinfo=timezone.utc),
                    cursor_seq=10,
                    cursor_symbol="NVDA",
                    no_signal_reason="cursor_tail_stable",
                    signal_lag_seconds=68,
                )
            )

            self.assertFalse(state.last_signal_continuity_actionable)
            self.assertFalse(state.signal_continuity_alert_active)
            self.assertEqual(state.metrics.signal_continuity_actionable, 0)
            self.assertEqual(state.metrics.signal_lag_seconds, 68)
            self.assertEqual(
                state.metrics.signal_expected_staleness_total.get("cursor_tail_stable"),
                1,
            )
            self.assertNotIn(
                "cursor_tail_stable",
                state.metrics.signal_staleness_alert_total,
            )
        finally:
            config.settings.trading_signal_no_signal_streak_alert_threshold = original[
                "trading_signal_no_signal_streak_alert_threshold"
            ]
            config.settings.trading_signal_stale_lag_alert_seconds = original[
                "trading_signal_stale_lag_alert_seconds"
            ]
            config.settings.trading_signal_bootstrap_grace_seconds = original[
                "trading_signal_bootstrap_grace_seconds"
            ]

    def test_pipeline_alerts_when_tail_lag_is_stale(self) -> None:
        from app import config

        original = {
            "trading_signal_no_signal_streak_alert_threshold": config.settings.trading_signal_no_signal_streak_alert_threshold,
            "trading_signal_stale_lag_alert_seconds": config.settings.trading_signal_stale_lag_alert_seconds,
            "trading_signal_bootstrap_grace_seconds": config.settings.trading_signal_bootstrap_grace_seconds,
        }
        config.settings.trading_signal_no_signal_streak_alert_threshold = 1
        config.settings.trading_signal_stale_lag_alert_seconds = 300
        config.settings.trading_signal_bootstrap_grace_seconds = 0

        try:
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            pipeline.record_no_signal_batch(
                SignalBatch(
                    signals=[],
                    cursor_at=datetime(2026, 5, 5, 18, 10, tzinfo=timezone.utc),
                    cursor_seq=11,
                    cursor_symbol="NVDA",
                    no_signal_reason="cursor_tail_stable",
                    signal_lag_seconds=301,
                )
            )

            self.assertTrue(state.last_signal_continuity_actionable)
            self.assertTrue(state.signal_continuity_alert_active)
            self.assertEqual(state.signal_continuity_alert_reason, "cursor_tail_stable")
            self.assertEqual(state.metrics.signal_continuity_actionable, 1)
            self.assertEqual(state.metrics.signal_lag_seconds, 301)
            self.assertEqual(
                state.metrics.signal_actionable_staleness_total.get(
                    "cursor_tail_stable"
                ),
                1,
            )
            self.assertEqual(
                state.metrics.signal_staleness_alert_total.get("cursor_tail_stable"),
                1,
            )
        finally:
            config.settings.trading_signal_no_signal_streak_alert_threshold = original[
                "trading_signal_no_signal_streak_alert_threshold"
            ]
            config.settings.trading_signal_stale_lag_alert_seconds = original[
                "trading_signal_stale_lag_alert_seconds"
            ]
            config.settings.trading_signal_bootstrap_grace_seconds = original[
                "trading_signal_bootstrap_grace_seconds"
            ]

    def test_pipeline_quality_gate_uses_allowed_symbol_subset(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000
        config.settings.trading_kill_switch_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="quality-gate subset regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            fresh_allowed_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )
            stale_out_of_universe_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc),
                symbol="MSFT",
                timeframe="1Min",
                seq=2,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                    "spread": 1,
                },
            )

            alpaca_client = FakeAlpacaClient()
            execution_adapter = FakeAlpacaClient()
            decision_engine = RecordingDecisionEngine()
            ingestor = FakeIngestor(
                [fresh_allowed_signal, stale_out_of_universe_signal]
            )
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=ingestor,
                decision_engine=decision_engine,
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 1)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 0)
            self.assertEqual(state.metrics.feature_batch_rows_total, 1)
            self.assertLessEqual(state.metrics.feature_staleness_ms_p95, 1_000)
            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
            self.assertNotIn("MSFT", decision_engine.observed_symbols)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_relevant_signal_symbols_ignore_disabled_strategies(self) -> None:
        enabled_strategy = Strategy(
            name="enabled-filter-source",
            description="enabled source",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        disabled_strategy = Strategy(
            name="disabled-filter-source",
            description="disabled source",
            enabled=False,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["MSFT"],
        )

        pipeline = self._build_warmup_pipeline(
            ingestor=WarmupIngestor(
                warmup_signals=[],
                signals=[],
                cursor_at=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            )
        )

        relevant_symbols = pipeline._relevant_signal_symbols(
            strategies=[enabled_strategy, disabled_strategy],
            allowed_symbols={"AAPL", "MSFT"},
        )

        self.assertEqual(relevant_symbols, {"AAPL"})

    def test_pipeline_continues_when_feature_quality_has_warning_only_null_rate(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_feature_quality_enabled": config.settings.trading_feature_quality_enabled,
            "trading_feature_max_staleness_ms": config.settings.trading_feature_max_staleness_ms,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,MSFT"
        config.settings.trading_feature_quality_enabled = True
        config.settings.trading_feature_max_staleness_ms = 1_000
        config.settings.trading_kill_switch_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="quality-gate warning-only regression",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "MSFT"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            valid_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                seq=1,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
            )
            incomplete_signal = SignalEnvelope(
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                ingest_ts=datetime(2026, 1, 1, 0, 0, 0, 500000, tzinfo=timezone.utc),
                symbol="MSFT",
                timeframe="1Min",
                seq=2,
                payload={
                    "feature_schema_version": "3.0.0",
                    "macd": {"macd": None, "signal": None},
                    "rsi14": None,
                    "price": 100,
                },
            )

            alpaca_client = FakeAlpacaClient()
            execution_adapter = FakeAlpacaClient()
            ingestor = FakeIngestor([valid_signal, incomplete_signal])
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            self.assertEqual(ingestor.committed_batches, 1)
            self.assertEqual(state.metrics.feature_quality_rejections_total, 1)
            self.assertEqual(
                state.metrics.feature_quality_reject_reason_total.get(
                    "required_feature_null_rate_exceeds_threshold"
                ),
                1,
            )
            self.assertIsNone(
                state.metrics.feature_quality_cursor_commit_blocked_total.get(
                    "required_feature_null_rate_exceeds_threshold"
                )
            )
            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_feature_quality_enabled = original[
                "trading_feature_quality_enabled"
            ]
            config.settings.trading_feature_max_staleness_ms = original[
                "trading_feature_max_staleness_ms"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_stale_planned_decision_is_force_blocked(self) -> None:
        from app import config

        original_timeout = config.settings.trading_planned_decision_timeout_seconds
        config.settings.trading_planned_decision_timeout_seconds = 60
        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="stale-planned",
                    description="stale planned decision rejection",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)

                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    params={"price": Decimal("100")},
                )
                executor = OrderExecutor()
                decision_row = executor.ensure_decision(
                    session, decision, strategy, "paper"
                )
                decision_row.created_at = datetime.now(timezone.utc) - timedelta(
                    seconds=300
                )
                session.add(decision_row)
                session.commit()

                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=executor,
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

                self.assertIsNone(pending)
                refreshed = session.get(TradeDecision, decision_row.id)
                assert refreshed is not None
                self.assertEqual(refreshed.status, "blocked")
                decision_json = refreshed.decision_json
                assert isinstance(decision_json, dict)
                self.assertEqual(
                    decision_json.get("submission_block_reason"),
                    "stale_planned_cleanup",
                )
                submission_block_atomic = decision_json.get("submission_block_atomic")
                assert isinstance(submission_block_atomic, list)
                self.assertIn("stale_planned_cleanup", submission_block_atomic)
                self.assertEqual(
                    decision_json.get("submission_stage"),
                    "blocked_stale_planned_cleanup",
                )
                self.assertEqual(
                    pipeline.state.metrics.submission_block_total.get(
                        "stale_planned_cleanup"
                    ),
                    1,
                )
                self.assertEqual(
                    pipeline.state.metrics.planned_decisions_stale_total, 1
                )
        finally:
            config.settings.trading_planned_decision_timeout_seconds = original_timeout

    def test_simulation_clock_does_not_reject_fresh_planned_decision(self) -> None:
        from app import config
        from app.trading import time_source as time_source_module

        original = {
            "trading_planned_decision_timeout_seconds": config.settings.trading_planned_decision_timeout_seconds,
            "trading_simulation_enabled": config.settings.trading_simulation_enabled,
            "trading_simulation_clock_mode": config.settings.trading_simulation_clock_mode,
            "trading_simulation_window_start": config.settings.trading_simulation_window_start,
            "trading_account_label": config.settings.trading_account_label,
        }
        original_load_cursor = (
            time_source_module.TradingTimeSource._load_clickhouse_cursor
        )
        config.settings.trading_planned_decision_timeout_seconds = 60
        config.settings.trading_simulation_enabled = True
        config.settings.trading_simulation_clock_mode = "cursor"
        config.settings.trading_simulation_window_start = "2026-02-10T15:00:00+00:00"
        config.settings.trading_account_label = "paper"
        time_source_module.TradingTimeSource._load_clickhouse_cursor = staticmethod(
            lambda **_: None
        )
        time_source_module._TIME_SOURCE._cache_by_account.clear()
        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="simulation-fresh-planned",
                    description="simulation planned decision freshness",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)

                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 2, 10, 15, 0, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    params={"price": Decimal("100")},
                )
                executor = OrderExecutor()
                decision_row = executor.ensure_decision(
                    session, decision, strategy, "paper"
                )
                decision_row.created_at = datetime(
                    2026, 2, 10, 15, 0, 30, tzinfo=timezone.utc
                )
                session.add(decision_row)
                session.commit()

                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=executor,
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

                self.assertIsNotNone(pending)
                refreshed = session.get(TradeDecision, decision_row.id)
                assert refreshed is not None
                self.assertEqual(refreshed.status, "planned")
                self.assertEqual(
                    pipeline.state.metrics.planned_decisions_timeout_rejected_total, 0
                )
                self.assertEqual(
                    pipeline.state.metrics.planned_decisions_stale_total, 0
                )
        finally:
            config.settings.trading_planned_decision_timeout_seconds = original[
                "trading_planned_decision_timeout_seconds"
            ]
            config.settings.trading_simulation_enabled = original[
                "trading_simulation_enabled"
            ]
            config.settings.trading_simulation_clock_mode = original[
                "trading_simulation_clock_mode"
            ]
            config.settings.trading_simulation_window_start = original[
                "trading_simulation_window_start"
            ]
            config.settings.trading_account_label = original["trading_account_label"]
            time_source_module.TradingTimeSource._load_clickhouse_cursor = (
                original_load_cursor
            )
            time_source_module._TIME_SOURCE._cache_by_account.clear()

    def test_live_shadow_stage_blocks_policy_approved_decision(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            with self.session_local() as session:
                strategy = Strategy(
                    name="shadow-stage",
                    description="shadow stage block",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": 1.2, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
            )
            alpaca_client = FakeAlpacaClient()
            state = TradingState()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_quant_status(account_label="paper"),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                decision_row = decision_rows[0]
                self.assertEqual(decision_row.status, "blocked")
                decision_json = decision_row.decision_json
                assert isinstance(decision_json, dict)
                self.assertEqual(
                    decision_json.get("submission_block_reason"),
                    "capital_stage_shadow",
                )
                self.assertEqual(
                    decision_json.get("submission_stage"),
                    "blocked_capital_stage_shadow",
                )
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                self.assertEqual(control_plane_snapshot.get("capital_stage"), "shadow")
                self.assertEqual(
                    control_plane_snapshot.get("trading_autonomy_allow_live_promotion"),
                    False,
                )
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), False)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "hypothesis_window_evidence_missing",
                )

            self.assertEqual(alpaca_client.submitted, [])
            self.assertEqual(
                state.metrics.submission_block_total.get("capital_stage_shadow"), 1
            )
            self.assertEqual(state.metrics.decision_state_total.get("blocked"), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]

    def test_live_submission_allows_autonomy_eligible_canary_without_static_flag(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            with self.session_local() as session:
                evidence_at = datetime.now(timezone.utc)
                strategy = Strategy(
                    name="live-canary-eligible",
                    description="promotion-eligible live canary",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        window_started_at=evidence_at - timedelta(minutes=15),
                        window_ended_at=evidence_at,
                        market_session_count=1,
                        decision_count=1,
                        trade_count=1,
                        order_count=1,
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        post_cost_expectancy_bps="2.5",
                        avg_abs_slippage_bps="1.0",
                        slippage_budget_bps="5.0",
                        capital_stage="0.10x canary",
                        payload_json=self._runtime_ledger_weighted_window_payload(),
                    )
                )
                session.add(
                    StrategyPromotionDecision(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        promotion_target="live",
                        state="0.10x canary",
                        allowed=True,
                        reason_summary="ready",
                    )
                )
                session.add(
                    self._runtime_ledger_bucket(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        strategy_family="live-canary-eligible",
                        post_cost_expectancy_bps=Decimal("2.5"),
                        bucket_at=evidence_at,
                    )
                )
                session.add(
                    StrategyHypothesis(
                        hypothesis_id="H-CONT-01",
                        lane_id="lane-cand-1",
                        strategy_family="live-canary-eligible",
                        active=True,
                    )
                )
                session.add(
                    VNextDatasetSnapshot(
                        run_id="run-1",
                        candidate_id="cand-1",
                        dataset_id="dataset-cand-1",
                        source="historical_market_replay",
                        dataset_version="run-1",
                        artifact_ref="s3://torghut/empirical/cand-1",
                    )
                )
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            state = TradingState(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
            )
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="live",
                session_factory=self.session_local,
            )

            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                self.assertNotEqual(decision_rows[0].status, "blocked")
                decision_json = decision_rows[0].decision_json
                assert isinstance(decision_json, dict)
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), True)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "promotion_certificate_valid",
                )
                self.assertEqual(
                    live_submission_gate.get("evidence_tuple", {}).get("hypothesis_id"),
                    "H-CONT-01",
                )

            self.assertEqual(len(alpaca_client.submitted), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_live_submission_blocks_autonomy_eligible_canary_without_promotion_evidence(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            blocked_summary = {
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            with self.session_local() as session:
                strategy = Strategy(
                    name="live-canary-missing-proof",
                    description="autonomy evidence without promotion proof",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            state = TradingState(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
            )
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="live",
                session_factory=self.session_local,
            )

            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=blocked_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                self.assertEqual(decision_rows[0].status, "blocked")
                decision_json = decision_rows[0].decision_json
                assert isinstance(decision_json, dict)
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), False)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "alpha_readiness_not_promotion_eligible",
                )
                self.assertIn(
                    "alpha_readiness_not_promotion_eligible",
                    live_submission_gate.get("blocked_reasons", []),
                )

            self.assertEqual(alpaca_client.submitted, [])
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_run_once_blocks_live_submission_when_quant_latest_store_is_empty(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_enabled": config.settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_enabled = False
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            allowed_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            with self.session_local() as session:
                strategy = Strategy(
                    name="live-canary-empty-quant",
                    description="autonomy evidence with empty quant latest store",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            state = TradingState(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
            )
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=allowed_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": False,
                        "status": "degraded",
                        "reason": "quant_latest_metrics_empty",
                        "blocking_reasons": [
                            "quant_latest_metrics_empty",
                            "quant_latest_store_alarm",
                        ],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                        "latest_metrics_count": 0,
                        "latest_metrics_updated_at": None,
                        "empty_latest_store_alarm": True,
                        "missing_update_alarm": False,
                        "metrics_pipeline_lag_seconds": None,
                        "stage_count": 0,
                        "max_stage_lag_seconds": 0,
                        "stages": [],
                    },
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_rows = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decision_rows), 1)
                self.assertEqual(decision_rows[0].status, "blocked")
                decision_json = decision_rows[0].decision_json
                assert isinstance(decision_json, dict)
                control_plane_snapshot = decision_json.get("control_plane_snapshot")
                assert isinstance(control_plane_snapshot, dict)
                live_submission_gate = control_plane_snapshot.get(
                    "live_submission_gate"
                )
                assert isinstance(live_submission_gate, dict)
                self.assertEqual(live_submission_gate.get("allowed"), False)
                self.assertEqual(
                    live_submission_gate.get("reason"),
                    "quant_latest_metrics_empty",
                )
                self.assertEqual(live_submission_gate.get("capital_state"), "observe")
                self.assertIn(
                    "quant_latest_store_alarm",
                    live_submission_gate.get("blocked_reasons", []),
                )

            self.assertEqual(alpaca_client.submitted, [])
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_enabled = original[
                "trading_autonomy_enabled"
            ]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_decision_engine_macd_rsi(self) -> None:
        engine = DecisionEngine()
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        signal = SignalEnvelope(
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25, "price": 100},
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].action, "buy")

    def test_decision_engine_attaches_price(self) -> None:
        engine = DecisionEngine(price_fetcher=FakePriceFetcher(Decimal("101.5")))
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        signal = SignalEnvelope(
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25},
            timeframe="1Min",
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].params.get("price"), Decimal("101.5"))

    def test_risk_engine_ignores_deprecated_live_enabled_flag(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = False

        try:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )

            with self.session_local() as session:
                engine = RiskEngine()
                verdict = engine.evaluate(
                    session,
                    decision,
                    strategy,
                    account={"equity": "10000", "buying_power": "10000"},
                    positions=[],
                    allowed_symbols={"AAPL"},
                )
            self.assertTrue(verdict.approved)
            self.assertNotIn("live_trading_disabled", verdict.reasons)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]

    def test_pipeline_idempotent_execution(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(len(executions), 1)
                self.assertIsNotNone(decisions[0].decision_hash)
                self.assertEqual(len(alpaca_client.submitted), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_fail_blocks_new_entries(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-fail",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_fail_block_new_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "fail")
                    self.assertTrue(gate_payload.get("entry_blocked"))

                self.assertEqual(alpaca_client.submitted, [])
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_action_total.get("fail"), 1
                )
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("fail"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_saturated_fail_sentinel_degrades(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-sentinel",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    json.dumps(
                        {
                            "generated_at": datetime.now(timezone.utc).isoformat(),
                            "uncertainty_gate_action": "fail",
                            "coverage_error": "1",
                            "shift_score": "1",
                            "conformal_interval_width": "0",
                        }
                    ),
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertNotEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertNotIn(
                        "runtime_uncertainty_gate_fail_block_new_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "degrade")
                    self.assertEqual(
                        gate_payload.get("source"),
                        "autonomy_gate_report_saturated_fail_sentinel",
                    )

                self.assertEqual(len(alpaca_client.submitted), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_runtime_uncertainty_gate_resolves_strictest_action_across_sources(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                encoding="utf-8",
            )
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(last_autonomy_gates=str(gate_path)),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={
                    "uncertainty_gate_action": "pass",
                    "runtime_uncertainty_gate": {"action": "degrade"},
                    "forecast_audit": {"uncertainty_gate_action": "abstain"},
                },
            )

            gate = pipeline._resolve_runtime_uncertainty_gate(decision)

            self.assertEqual(gate.action, "fail")
            self.assertEqual(gate.source, "autonomy_gate_report")

    def test_pipeline_runtime_uncertainty_gate_defaults_degrade_when_inputs_missing(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={},
        )

        gate, _runtime_payload = (
            pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision),
            pipeline._resolve_runtime_uncertainty_gate(decision),
        )
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "uncertainty_input_missing")
        self.assertEqual(_runtime_payload.action, "degrade")
        self.assertEqual(_runtime_payload.source, "uncertainty_input_missing")

    def test_pipeline_runtime_uncertainty_gate_stale_decision_payload_abstains(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        stale = datetime.now(timezone.utc) - timedelta(minutes=45)
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "runtime_uncertainty_gate": {
                    "action": "pass",
                    "generated_at": stale.isoformat().replace("+00:00", "Z"),
                    "coverage_error": "0.01",
                }
            },
        )

        gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "decision_runtime_payload_stale")
        self.assertEqual(gate.reason, "decision_runtime_payload_generated_at_stale")

    def test_pipeline_runtime_regime_gate_defaults_degrade_when_inputs_missing(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={},
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "missing")
        self.assertEqual(gate.reason, "missing")

    def test_pipeline_runtime_regime_gate_degrades_for_uncertain_regime_posterior(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.68", "R3": "0.32"},
                    "entropy": "0.95",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "regime_hmm_confidence")
        self.assertEqual(gate.reason, "regime_hmm_confidence_is_uncertain")

    def test_pipeline_runtime_regime_gate_abstains_for_high_entropy_low_confidence(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.60", "R3": "0.40"},
                    "entropy": "2.2",
                    "entropy_band": "high",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_confidence")
        self.assertEqual(gate.reason, "regime_hmm_confidence_too_low")

    def test_pipeline_runtime_regime_gate_respects_configured_entropy_band_thresholds(
        self,
    ) -> None:
        from app import config

        original_thresholds = dict(
            config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band
        )
        config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band = {
            **original_thresholds,
            "high": (0.55, 0.45),
        }
        try:
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("10"),
                params={
                    "regime_hmm": {
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": "0.60", "R3": "0.40"},
                        "entropy": "2.2",
                        "entropy_band": "high",
                        "predicted_next": "R3",
                        "artifact": {"model_id": "hmm-regime-v1.2.0"},
                        "guardrail": {"reason": "stable"},
                    },
                },
            )

            gate = pipeline._resolve_runtime_regime_gate(decision)
            self.assertEqual(gate.action, "pass")
            self.assertEqual(gate.source, "regime_hmm")
        finally:
            config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band = original_thresholds

    def test_pipeline_runtime_regime_gate_invalid_regime_gate_action_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_gate": {"action": "invalid"},
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "decision_regime_gate_invalid_action")
        self.assertEqual(gate.reason, "decision_regime_gate_invalid_action")

    def test_pipeline_runtime_regime_gate_unknown_regime_without_label_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "unknown",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_regime_gate_invalid_regime_id_without_label_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2-ish",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "legacy_bridge"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_regime_gate_invalid_schema_version_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v0",
                    "regime_id": "R2",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_schema_version_invalid")

    def test_pipeline_runtime_regime_gate_invalid_posterior_fails_closed(self) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "bad-probability", "R3": "0.5"},
                    "entropy": "1.2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "transition_shock": False,
                    "guardrail": {"stale": False, "fallback_to_defensive": False},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_non_authoritative")
        self.assertEqual(gate.reason, "hmm_invalid_posterior")

    def test_pipeline_runtime_regime_gate_invalid_schema_version_fails_closed_and_preserves_artifact_lineage(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v0",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1-feature-schema",
                        "training_run_id": "run-2026-03-01",
                    },
                    "transition_shock": False,
                    "guardrail": {"stale": False, "fallback_to_defensive": False},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_schema_version_invalid")
        self.assertIsNone(gate.regime_label)
        regime_payload = decision.params.get("regime_hmm")
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get("schema_version"), "hmm_regime_context_v0")
        regime_artifact = regime_payload.get("artifact")
        self.assertIsInstance(regime_artifact, dict)
        self.assertEqual(regime_artifact.get("model_id"), "hmm-regime-v1.2.0")
        self.assertEqual(regime_artifact.get("feature_schema"), "hmm-v1-feature-schema")
        self.assertEqual(regime_artifact.get("training_run_id"), "run-2026-03-01")

    def test_pipeline_runtime_regime_gate_invalid_posterior_fails_closed_and_preserves_artifact_lineage(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {
                        "R2": "bad-probability",
                        "R3": "0.5",
                    },
                    "entropy": "1.2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1-feature-schema",
                        "training_run_id": "run-2026-03-01",
                    },
                    "transition_shock": False,
                    "guardrail": {"stale": False, "fallback_to_defensive": False},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_non_authoritative")
        self.assertEqual(gate.reason, "hmm_invalid_posterior")
        self.assertIsNone(gate.regime_label)
        regime_payload = decision.params.get("regime_hmm")
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get("schema_version"), "hmm_regime_context_v1")
        regime_artifact = regime_payload.get("artifact")
        self.assertIsInstance(regime_artifact, dict)
        self.assertEqual(
            regime_artifact.get("model_id"),
            "hmm-regime-v1.2.0",
        )

    def test_pipeline_runtime_regime_gate_stale_hmm_is_fail_closed(self) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "aging_output", "stale": True},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_stale")
        self.assertEqual(gate.reason, "aging_output")

    def test_pipeline_runtime_regime_gate_stale_hmm_is_fail_closed_and_preserves_lineage(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1-feature-schema",
                        "training_run_id": "run-2026-03-01",
                    },
                    "guardrail": {"reason": "aging_output", "stale": True},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_stale")
        self.assertEqual(gate.reason, "aging_output")
        self.assertEqual(gate.regime_label, "trend")
        regime_payload = decision.params.get("regime_hmm")
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get("schema_version"), "hmm_regime_context_v1")
        regime_artifact = regime_payload.get("artifact")
        self.assertIsInstance(regime_artifact, dict)
        self.assertEqual(
            regime_artifact.get("model_id"),
            "hmm-regime-v1.2.0",
        )

    def test_pipeline_runtime_regime_gate_fallback_to_defensive_is_fail_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"fallback_to_defensive": True},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_stale")
        self.assertEqual(gate.regime_label, "R2")
        self.assertEqual(gate.reason, "fallback_to_defensive")

    def test_pipeline_runtime_regime_gate_non_authoritative_regime_with_legacy_label_fails_closed(
        self,
    ) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "not-a-regime-id",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "transitioning"},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_uncertainty_gate_report_parse_error_fails_closed(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-parse-error",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"fail"',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "abstain")
                    self.assertEqual(
                        gate_payload.get("source"),
                        "autonomy_gate_report_read_error",
                    )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_gate_report_stale_in_autonomy_path_abstains(
        self,
    ) -> None:
        stale_report = {
            "uncertainty_gate_action": "pass",
            "generated_at": (datetime.now(timezone.utc) - timedelta(minutes=45))
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            ),
            "coverage_error": "0.01",
            "shift_score": "0.10",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(json.dumps(stale_report), encoding="utf-8")
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(last_autonomy_gates=str(gate_path)),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={},
            )

            gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)
            self.assertEqual(gate.action, "abstain")
            self.assertEqual(gate.source, "autonomy_gate_report_stale")
            self.assertEqual(gate.reason, "autonomy_gate_report_generated_at_stale")

    def test_pipeline_runtime_regime_gate_transition_shock_blocks_risk_increasing_entry(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-regime-gate-transition-shock",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": 1.0},
                        "entropy": "0.42",
                        "entropy_band": "low",
                        "predicted_next": "R2",
                        "transition_shock": True,
                        "duration_ms": 123,
                        "artifact": {
                            "model_id": "hmm-regime-v1.2.0",
                            "feature_schema": "hmm-v1",
                            "training_run_id": "run-2026-02-21",
                        },
                        "guardrail": {
                            "stale": False,
                            "fallback_to_defensive": False,
                        },
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "abstain")
                    self.assertEqual(
                        gate_payload.get("source"), "regime_hmm_transition_shock"
                    )
                    regime_gate = gate_payload.get("regime_gate")
                    assert isinstance(regime_gate, dict)
                    self.assertEqual(regime_gate.get("action"), "abstain")
                    self.assertEqual(
                        regime_gate.get("reason"), "regime_context_transition_shock"
                    )

                self.assertEqual(len(alpaca_client.submitted), 0)
                self.assertEqual(
                    state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
                )
                self.assertEqual(
                    state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_regime_gate_stale_hmm_blocks_risk_increasing_entry_and_preserves_artifact_lineage(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo-stale-regime-lineage",
                        description="runtime-regime-gate-stale",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": 0.75},
                        "entropy": "1.23",
                        "entropy_band": "medium",
                        "predicted_next": "R3",
                        "transition_shock": False,
                        "duration_ms": 123,
                        "artifact": {
                            "model_id": "hmm-regime-v1.2.0",
                            "feature_schema": "hmm-v1",
                            "training_run_id": "run-2026-03-02",
                        },
                        "guardrail": {
                            "stale": True,
                            "fallback_to_defensive": False,
                            "reason": "aging_output",
                        },
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)

                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "abstain")
                    self.assertEqual(
                        gate_payload.get("source"),
                        "regime_hmm_stale",
                    )
                    regime_gate = gate_payload.get("regime_gate")
                    assert isinstance(regime_gate, dict)
                    self.assertEqual(regime_gate.get("action"), "abstain")
                    self.assertEqual(regime_gate.get("reason"), "aging_output")

                    regime_payload = params.get("regime_hmm")
                    self.assertIsInstance(regime_payload, dict)
                    self.assertEqual(
                        regime_payload.get("schema_version"),
                        "hmm_regime_context_v1",
                    )
                    regime_artifact = regime_payload.get("artifact")
                    self.assertIsInstance(regime_artifact, dict)
                    self.assertEqual(
                        regime_artifact.get("model_id"), "hmm-regime-v1.2.0"
                    )
                    self.assertEqual(regime_artifact.get("feature_schema"), "hmm-v1")
                    self.assertEqual(
                        regime_artifact.get("training_run_id"), "run-2026-03-02"
                    )
                    self.assertEqual(
                        regime_payload.get("hmm_state_posterior"), {"R2": "0.75"}
                    )
                    self.assertEqual(regime_payload.get("hmm_entropy"), "1.23")
                    self.assertEqual(regime_payload.get("hmm_entropy_band"), "medium")
                    self.assertEqual(regime_payload.get("hmm_transition_shock"), False)

                self.assertEqual(len(alpaca_client.submitted), 0)
                self.assertEqual(
                    state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
                )
                self.assertEqual(
                    state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_regime_gate_invalid_posterior_blocks_risk_increasing_entry_and_preserves_artifact_lineage(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo-invalid-posterior",
                        description="runtime-regime-gate-invalid-posterior",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": "bad-posterior"},
                        "entropy": "1.2",
                        "entropy_band": "medium",
                        "predicted_next": "R3",
                        "transition_shock": False,
                        "duration_ms": 123,
                        "artifact": {
                            "model_id": "hmm-regime-v1.2.0",
                            "feature_schema": "hmm-v1",
                            "training_run_id": "run-2026-03-02",
                        },
                        "guardrail": {
                            "stale": False,
                            "fallback_to_defensive": False,
                        },
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)

                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(
                        gate_payload.get("source"), "regime_hmm_non_authoritative"
                    )
                    regime_gate = gate_payload.get("regime_gate")
                    assert isinstance(regime_gate, dict)
                    self.assertEqual(regime_gate.get("action"), "abstain")
                    self.assertEqual(regime_gate.get("reason"), "hmm_invalid_posterior")

                    regime_payload = params.get("regime_hmm")
                    self.assertIsInstance(regime_payload, dict)
                    self.assertEqual(
                        regime_payload.get("schema_version"),
                        "hmm_regime_context_v1",
                    )
                    regime_artifact = regime_payload.get("artifact")
                    self.assertIsInstance(regime_artifact, dict)
                    self.assertEqual(
                        regime_artifact.get("model_id"),
                        "hmm-regime-v1.2.0",
                    )
                    self.assertEqual(
                        regime_artifact.get("feature_schema"),
                        "hmm-v1",
                    )
                    self.assertEqual(
                        regime_artifact.get("training_run_id"),
                        "run-2026-03-02",
                    )
                    self.assertEqual(regime_payload.get("hmm_entropy"), "1.2")
                    self.assertEqual(regime_payload.get("hmm_state_posterior"), {})
                    self.assertEqual(regime_payload.get("hmm_entropy_band"), "medium")
                    self.assertEqual(regime_payload.get("hmm_transition_shock"), False)

                self.assertEqual(len(alpaca_client.submitted), 0)
                self.assertEqual(
                    state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
                )
                self.assertEqual(
                    state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_regime_gate_unparseable_payload_fails_closed(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        class DeterministicDecisionEngine(DecisionEngine):
            def evaluate(
                self,
                _signal,
                _strategies,
                *,
                equity: Any | None = None,
            ) -> list[StrategyDecision]:
                _ = equity
                return [forced_decision]

        strategy_id: str
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="runtime-regime-gate-unparseable",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            strategy_id = str(strategy.id)

        forced_decision = StrategyDecision(
            strategy_id=strategy_id,
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={
                "regime_hmm": "bad-regime-payload",
            },
        )

        try:
            state = TradingState()
            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor(
                    [
                        SignalEnvelope(
                            event_ts=datetime.now(timezone.utc),
                            symbol="AAPL",
                            payload={
                                "macd": {"macd": 1.2, "signal": 0.5},
                                "rsi14": 25,
                                "price": 100,
                            },
                            timeframe="1Min",
                        )
                    ]
                ),
                decision_engine=DeterministicDecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(decisions[0].status, "rejected")
                decision_json = decisions[0].decision_json
                assert isinstance(decision_json, dict)
                self.assertIn(
                    "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                    decision_json.get("risk_reasons", []),
                )
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "abstain")
                self.assertEqual(gate_payload.get("source"), "regime_hmm_unparseable")
                regime_gate = gate_payload.get("regime_gate")
                assert isinstance(regime_gate, dict)
                self.assertEqual(regime_gate.get("action"), "abstain")
                self.assertEqual(
                    regime_gate.get("reason"), "regime_hmm_unparseable_payload"
                )

            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(
                state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
            )
            self.assertEqual(
                state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
            )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_abstain_allows_risk_reducing_exit(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-abstain",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"abstain"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 0.4, "signal": 1.0},
                        "rsi14": 75,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "long",
                            "market_value": "500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "submitted")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "abstain")
                    self.assertFalse(gate_payload.get("entry_blocked"))
                    self.assertFalse(gate_payload.get("risk_increasing_entry"))

                self.assertEqual(len(alpaca_client.submitted), 1)
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_action_total.get("abstain"),
                    1,
                )
                self.assertIsNone(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("abstain")
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_runtime_uncertainty_degrade_tightens_sizing_and_participation(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-degrade",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"degrade"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                self.assertEqual(len(alpaca_client.submitted), 1)
                self.assertEqual(alpaca_client.submitted[0]["qty"], "5.0")
                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "submitted")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertEqual(gate_payload.get("action"), "degrade")
                    self.assertEqual(gate_payload.get("degrade_qty_multiplier"), "0.50")
                    allocator = params.get("allocator")
                    assert isinstance(allocator, dict)
                    self.assertEqual(
                        allocator.get("max_participation_rate_override"), "0.05"
                    )
                    self.assertEqual(params.get("execution_seconds"), 120)

                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_action_total.get("degrade"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_runtime_uncertainty_gate_degrade_uses_regime_profile(self) -> None:
        from app import config

        original = {
            "qty_multipliers": config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
            "max_participation_rates": config.settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime,
            "min_execution_seconds": config.settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime,
        }

        config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = {
            "riskoff": 0.25,
        }
        config.settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime = {
            "riskoff": 0.03,
        }
        config.settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime = {
            "riskoff": 180,
        }

        try:
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("20"),
                params={
                    "regime_gate": {
                        "action": "pass",
                        "regime_label": "riskoff",
                    },
                },
            )

            updated_decision, payload, reason = (
                pipeline._apply_runtime_uncertainty_gate(
                    decision,
                    positions=[],
                )
            )

            self.assertIsNone(reason)
            self.assertEqual(payload.get("degrade_qty_multiplier"), "0.25")
            self.assertEqual(payload.get("max_participation_rate_override"), "0.03")
            self.assertEqual(payload.get("min_execution_seconds"), 180)
            self.assertEqual(
                str(
                    updated_decision.params["allocator"][
                        "max_participation_rate_override"
                    ]
                ),
                "0.03",
            )
            self.assertEqual(updated_decision.params.get("execution_seconds"), 180)
            self.assertEqual(Decimal(str(payload.get("adjusted_qty"))), Decimal("5"))
        finally:
            config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = original[
                "qty_multipliers"
            ]
            config.settings.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime = original[
                "max_participation_rates"
            ]
            config.settings.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime = original[
                "min_execution_seconds"
            ]

    def test_runtime_uncertainty_gate_degrade_does_not_increase_fractional_qty(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_fractional_equities_enabled": config.settings.trading_fractional_equities_enabled,
            "qty_multipliers": config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
        }
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = {
            "trend": 0.5,
        }

        try:
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("0.2766"),
                params={
                    "regime_gate": {
                        "action": "pass",
                        "regime_label": "trend",
                    },
                    "runtime_uncertainty_gate": {
                        "action": "degrade",
                    },
                },
            )

            updated_decision, payload, reason = (
                pipeline._apply_runtime_uncertainty_gate(
                    decision,
                    positions=[],
                )
            )

            self.assertIsNone(reason)
            self.assertEqual(payload.get("adjusted_qty"), "0.1383")
            self.assertEqual(updated_decision.qty, Decimal("0.1383"))
        finally:
            config.settings.trading_fractional_equities_enabled = original[
                "trading_fractional_equities_enabled"
            ]
            config.settings.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = original[
                "qty_multipliers"
            ]

    def test_runtime_uncertainty_gate_softens_saturated_autonomy_fail_sentinel(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "uncertainty_gate_action": "fail",
                        "coverage_error": "1",
                        "shift_score": "1",
                        "conformal_interval_width": "0",
                    }
                ),
                encoding="utf-8",
            )
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(last_autonomy_gates=str(gate_path)),
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("5"),
                params={},
            )

            gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)

            self.assertEqual(gate.action, "degrade")
            self.assertEqual(
                gate.source, "autonomy_gate_report_saturated_fail_sentinel"
            )
            self.assertEqual(
                gate.reason, "autonomy_gate_report_saturated_fail_sentinel"
            )

    def test_pipeline_runtime_uncertainty_uses_projected_positions_within_run(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-projected-positions",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("500"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"abstain"}',
                    encoding="utf-8",
                )
                event_ts = datetime.now(timezone.utc)
                signals = [
                    SignalEnvelope(
                        event_ts=event_ts,
                        symbol="AAPL",
                        payload={
                            "macd": {"macd": 1.2, "signal": 0.5},
                            "rsi14": 25,
                            "price": 100,
                        },
                        timeframe="1Min",
                    ),
                    SignalEnvelope(
                        event_ts=event_ts + timedelta(seconds=1),
                        symbol="AAPL",
                        payload={
                            "macd": {"macd": 1.2, "signal": 0.5},
                            "rsi14": 25,
                            "price": 100,
                        },
                        timeframe="1Min",
                    ),
                ]
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "short",
                            "market_value": "-500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor(signals),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 2)
                    status_counts = {
                        status: sum(1 for item in decisions if item.status == status)
                        for status in {"submitted", "rejected"}
                    }
                    self.assertEqual(status_counts.get("submitted"), 1)
                    self.assertEqual(status_counts.get("rejected"), 1)
                    rejected = next(
                        item for item in decisions if item.status == "rejected"
                    )
                    decision_json = rejected.decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        decision_json.get("risk_reasons", []),
                    )

                self.assertEqual(len(alpaca_client.submitted), 1)
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("abstain"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_apply_projected_position_decision_updates_market_value(self) -> None:
        positions = [
            {"symbol": "AAPL", "qty": "5", "side": "long", "market_value": "500"}
        ]
        decision = StrategyDecision(
            strategy_id="demo",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("2"),
            params={"price": "100"},
        )

        _apply_projected_position_decision(positions, decision)

        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["qty"], "7")
        self.assertEqual(positions[0]["side"], "long")
        self.assertEqual(positions[0]["market_value"], "700")

    def test_project_open_orders_onto_positions_projects_buy_exposure(self) -> None:
        positions: list[dict[str, Any]] = []

        projected = _project_open_orders_onto_positions(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "side": "buy",
                    "qty": "3",
                    "filled_qty": "1",
                    "limit_price": "100",
                    "type": "limit",
                    "time_in_force": "day",
                }
            ],
        )

        self.assertEqual(projected, 1)
        self.assertEqual(
            positions,
            [{"symbol": "AAPL", "qty": "2", "side": "long", "market_value": "200"}],
        )

    def test_project_open_orders_onto_positions_projects_sell_against_existing_long(
        self,
    ) -> None:
        positions: list[dict[str, Any]] = [
            {"symbol": "AAPL", "qty": "5", "side": "long", "market_value": "500"}
        ]

        projected = _project_open_orders_onto_positions(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "side": "sell",
                    "qty": "4",
                    "filled_qty": "1",
                    "limit_price": "100",
                    "type": "limit",
                    "time_in_force": "day",
                }
            ],
        )

        self.assertEqual(projected, 1)
        self.assertEqual(
            positions,
            [{"symbol": "AAPL", "qty": "2", "side": "long", "market_value": "200"}],
        )

    def test_resolve_execution_context_positions_projects_open_orders(self) -> None:
        pipeline = TradingPipeline.__new__(TradingPipeline)
        pipeline.account_label = "paper"

        class AdapterWithOpenOrders:
            name = "test"

            def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                if status == "open":
                    return [
                        {
                            "symbol": "AAPL",
                            "side": "buy",
                            "qty": "3",
                            "filled_qty": "1",
                            "limit_price": "100",
                            "type": "limit",
                            "time_in_force": "day",
                        }
                    ]
                return []

        pipeline.execution_adapter = AdapterWithOpenOrders()

        positions = pipeline._resolve_execution_context_positions([])

        self.assertEqual(
            positions,
            [{"symbol": "AAPL", "qty": "2", "side": "long", "market_value": "200"}],
        )

    def test_resolve_execution_context_positions_tags_matching_strategy_fill(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={"action": "buy"},
                rationale="paper-route-entry",
                status="submitted",
                created_at=session_open + timedelta(minutes=60),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="paper-aapl-1",
                    client_order_id="paper-aapl-1-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    avg_fill_price=Decimal("101"),
                    status="filled",
                    raw_order={},
                    created_at=session_open + timedelta(minutes=61),
                    updated_at=session_open + timedelta(minutes=61),
                )
            )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [
                        {
                            "symbol": "AAPL",
                            "qty": "2",
                            "side": "long",
                            "avg_entry_price": "101",
                        }
                    ],
                    session=session,
                )

        self.assertEqual(positions[0]["strategy_id"], str(strategy.id))
        self.assertEqual(
            positions[0]["strategy_position_source"],
            "current_session_filled_executions",
        )
        self.assertEqual(
            positions[0]["strategy_position_session_open"],
            session_open.isoformat(),
        )

    def test_resolve_execution_context_positions_tags_prior_open_strategy_exposure(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        prior_session_open = session_open - timedelta(days=1)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={"action": "buy"},
                rationale="paper-route-entry",
                status="filled",
                created_at=prior_session_open + timedelta(minutes=60),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="paper-aapl-prior-open",
                    client_order_id="paper-aapl-prior-open-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    avg_fill_price=Decimal("101"),
                    status="filled",
                    raw_order={},
                    created_at=prior_session_open + timedelta(minutes=61),
                    updated_at=prior_session_open + timedelta(minutes=61),
                )
            )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [
                        {
                            "symbol": "AAPL",
                            "qty": "2",
                            "side": "long",
                            "avg_entry_price": "101",
                        }
                    ],
                    session=session,
                )

        self.assertEqual(positions[0]["strategy_id"], str(strategy.id))
        self.assertEqual(
            positions[0]["strategy_position_source"],
            "open_exposure_filled_executions",
        )
        self.assertTrue(positions[0]["strategy_position_stale_session_repair"])
        self.assertEqual(
            positions[0]["strategy_position_session_open"],
            session_open.isoformat(),
        )

    def test_resolve_execution_context_positions_does_not_tag_closed_prior_exposure(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        prior_session_open = session_open - timedelta(days=1)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            for index, (side, created_offset) in enumerate(
                [("buy", 60), ("sell", 120)],
                start=1,
            ):
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Sec",
                    decision_json={"action": side},
                    rationale="paper-route-entry" if side == "buy" else "time-exit",
                    status="filled",
                    created_at=prior_session_open + timedelta(minutes=created_offset),
                )
                session.add(decision)
                session.commit()
                session.refresh(decision)
                session.add(
                    Execution(
                        trade_decision_id=decision.id,
                        alpaca_account_label="paper",
                        alpaca_order_id=f"paper-aapl-prior-closed-{index}",
                        client_order_id=f"paper-aapl-prior-closed-{index}-client",
                        symbol="AAPL",
                        side=side,
                        order_type="market",
                        time_in_force="day",
                        submitted_qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("101"),
                        status="filled",
                        raw_order={},
                        created_at=prior_session_open
                        + timedelta(minutes=created_offset + 1),
                        updated_at=prior_session_open
                        + timedelta(minutes=created_offset + 1),
                    )
                )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [{"symbol": "AAPL", "qty": "2", "side": "long"}],
                    session=session,
                )

        self.assertNotIn("strategy_id", positions[0])

    def test_resolve_execution_context_positions_does_not_tag_mismatched_fill(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={"action": "buy"},
                rationale="paper-route-entry",
                status="submitted",
                created_at=session_open + timedelta(minutes=60),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="paper-aapl-2",
                    client_order_id="paper-aapl-2-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    avg_fill_price=Decimal("101"),
                    status="filled",
                    raw_order={},
                    created_at=session_open + timedelta(minutes=61),
                    updated_at=session_open + timedelta(minutes=61),
                )
            )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [{"symbol": "AAPL", "qty": "3", "side": "long"}],
                    session=session,
                )

        self.assertNotIn("strategy_id", positions[0])

    def test_resolve_execution_context_positions_splits_multi_strategy_symbol_position(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategies = [
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="runtime isolated paper proof",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL"],
                ),
                Strategy(
                    name="microbar-volume-continuation-long-top2-chip-v1",
                    description="runtime isolated paper proof",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL"],
                ),
            ]
            session.add_all(strategies)
            session.commit()
            for strategy in strategies:
                session.refresh(strategy)

            for index, (strategy, qty, price) in enumerate(
                [
                    (strategies[0], Decimal("1.25"), Decimal("100")),
                    (strategies[1], Decimal("2.75"), Decimal("104")),
                ],
                start=1,
            ):
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Sec",
                    decision_json={"action": "buy"},
                    rationale="paper-route-entry",
                    status="filled",
                    created_at=session_open + timedelta(minutes=60 + index),
                )
                session.add(decision)
                session.commit()
                session.refresh(decision)
                session.add(
                    Execution(
                        trade_decision_id=decision.id,
                        alpaca_account_label="paper",
                        alpaca_order_id=f"paper-aapl-{index}",
                        client_order_id=f"paper-aapl-{index}-client",
                        symbol="AAPL",
                        side="buy",
                        order_type="market",
                        time_in_force="day",
                        submitted_qty=qty,
                        filled_qty=qty,
                        avg_fill_price=price,
                        status="filled",
                        raw_order={},
                        created_at=session_open + timedelta(minutes=61 + index),
                        updated_at=session_open + timedelta(minutes=61 + index),
                    )
                )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [{"symbol": "AAPL", "qty": "4.00", "side": "long"}],
                    session=session,
                )

        self.assertEqual(len(positions), 2)
        self.assertEqual(
            {position["strategy_id"] for position in positions},
            {str(strategy.id) for strategy in strategies},
        )
        self.assertEqual(
            {Decimal(str(position["qty"])) for position in positions},
            {Decimal("1.25"), Decimal("2.75")},
        )
        self.assertTrue(
            all(
                position["strategy_position_split_from_aggregate"]
                for position in positions
            )
        )

    def test_attach_current_session_strategy_position_tags_fails_closed_on_query_error(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        pipeline = TradingPipeline.__new__(TradingPipeline)
        pipeline.account_label = "paper"
        session = Mock()
        session.execute.side_effect = RuntimeError("db unavailable")
        positions = [{"symbol": "AAPL", "qty": "1", "side": "long"}]

        with patch(
            "app.trading.scheduler.pipeline.trading_now",
            return_value=session_open + timedelta(minutes=150),
        ):
            tagged = pipeline._attach_current_session_strategy_position_tags(
                session,
                positions,
            )

        self.assertIs(tagged, positions)
        self.assertNotIn("strategy_id", tagged[0])

    def test_attach_current_session_strategy_position_tags_ignores_invalid_fill_rows(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        pipeline = TradingPipeline.__new__(TradingPipeline)
        pipeline.account_label = "paper"
        session = Mock()
        session.execute.return_value.all.return_value = [
            (
                SimpleNamespace(
                    symbol="",
                    filled_qty=Decimal("1"),
                    side="buy",
                    avg_fill_price=Decimal("101"),
                    created_at=session_open + timedelta(minutes=1),
                ),
                SimpleNamespace(symbol="", strategy_id="strategy-empty-symbol"),
            ),
            (
                SimpleNamespace(
                    symbol="AAPL",
                    filled_qty=None,
                    side="buy",
                    avg_fill_price=Decimal("101"),
                    created_at=session_open + timedelta(minutes=2),
                ),
                SimpleNamespace(symbol="AAPL", strategy_id="strategy-no-fill"),
            ),
            (
                SimpleNamespace(
                    symbol="AAPL",
                    filled_qty=Decimal("1"),
                    side="hold",
                    avg_fill_price=Decimal("101"),
                    created_at=session_open + timedelta(minutes=3),
                ),
                SimpleNamespace(symbol="AAPL", strategy_id="strategy-bad-side"),
            ),
        ]
        positions = [{"symbol": "AAPL", "qty": "1", "side": "long"}]

        with patch(
            "app.trading.scheduler.pipeline.trading_now",
            return_value=session_open + timedelta(minutes=150),
        ):
            tagged = pipeline._attach_current_session_strategy_position_tags(
                session,
                positions,
            )

        self.assertIs(tagged, positions)
        self.assertNotIn("strategy_id", tagged[0])

    def test_attach_strategy_position_tag_fail_closed_edges(self) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        exposures = {
            "AAPL": {
                "strategy-a": {"qty": Decimal("2")},
                "strategy-b": {"qty": Decimal("2")},
            }
        }

        self.assertFalse(
            TradingPipeline._same_side_position_exposure(
                Decimal("0"),
                Decimal("2"),
            )
        )
        already_tagged = {"symbol": "AAPL", "qty": "2", "strategy_id": "existing"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                already_tagged,
                exposures=exposures,
                session_open=session_open,
            ),
            already_tagged,
        )
        no_symbol = {"qty": "2"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                no_symbol,
                exposures=exposures,
                session_open=session_open,
            ),
            no_symbol,
        )
        no_exposure = {"symbol": "MSFT", "qty": "2"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                no_exposure,
                exposures=exposures,
                session_open=session_open,
            ),
            no_exposure,
        )
        nonpositive = {"symbol": "AAPL", "qty": "0"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                nonpositive,
                exposures=exposures,
                session_open=session_open,
            ),
            nonpositive,
        )
        ambiguous = {"symbol": "AAPL", "qty": "2", "side": "long"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                ambiguous,
                exposures=exposures,
                session_open=session_open,
            ),
            ambiguous,
        )

    def test_attach_strategy_position_tag_reconstructs_avg_entry_from_fills(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        tagged = TradingPipeline._attach_strategy_position_tag(
            {"symbol": "AAPL", "qty": "2", "side": "long"},
            exposures={
                "AAPL": {
                    "strategy-a": {
                        "qty": Decimal("2"),
                        "buy_qty": Decimal("2"),
                        "buy_notional": Decimal("202"),
                        "latest_execution_at": session_open + timedelta(minutes=1),
                    }
                }
            },
            session_open=session_open,
        )

        self.assertEqual(tagged["strategy_id"], "strategy-a")
        self.assertEqual(tagged["avg_entry_price"], "101")
        self.assertEqual(
            tagged["strategy_position_latest_execution_at"],
            (session_open + timedelta(minutes=1)).isoformat(),
        )

    def test_attach_strategy_position_tag_handles_signed_short_qty(self) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        tagged = TradingPipeline._attach_strategy_position_tag(
            {"symbol": "AMZN", "qty": "-41"},
            exposures={
                "AMZN": {
                    "strategy-pairs": {
                        "qty": Decimal("-41"),
                        "latest_execution_at": session_open + timedelta(minutes=61),
                    }
                }
            },
            session_open=session_open,
        )

        self.assertEqual(tagged["strategy_id"], "strategy-pairs")
        self.assertEqual(tagged["qty"], "41")
        self.assertEqual(tagged["side"], "short")

    def test_microbar_pairs_are_symmetric_entries_with_position_isolation(self) -> None:
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
        )

        self.assertTrue(_strategy_uses_position_isolation(strategy))
        self.assertTrue(
            _is_entry_action_for_strategies(strategies=[strategy], action="buy")
        )
        self.assertTrue(
            _is_entry_action_for_strategies(strategies=[strategy], action="sell")
        )
        self.assertFalse(
            _is_exit_action_for_strategies(strategies=[strategy], action="buy")
        )
        self.assertFalse(
            _is_exit_action_for_strategies(strategies=[strategy], action="sell")
        )

    def test_pipeline_runtime_uncertainty_rechecks_after_llm_adjustment(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_adjustment_allowed = True
        _set_llm_guardrails(config, adjustment_approved=True)

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-post-llm-recheck",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("500"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "short",
                            "market_value": "-500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                    llm_review_engine=FakeLLMReviewEngine(
                        verdict="adjust",
                        adjusted_qty=Decimal("6"),
                        adjusted_order_type="market",
                    ),
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_fail_block_new_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertTrue(gate_payload.get("entry_blocked"))
                    self.assertTrue(gate_payload.get("risk_increasing_entry"))

                self.assertEqual(alpaca_client.submitted, [])
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("fail"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_maybe_record_lean_strategy_shadow_rolls_back_session_on_failure(
        self,
    ) -> None:
        pipeline = object.__new__(TradingPipeline)
        metrics = Mock()
        pipeline.state = SimpleNamespace(metrics=metrics)
        pipeline.lean_lane_manager = Mock()
        pipeline.lean_lane_manager.record_strategy_shadow.side_effect = RuntimeError(
            "boom"
        )

        session = Mock()
        execution_client = Mock()
        execution_client.evaluate_strategy_shadow.return_value = {
            "run_id": "run-1",
            "parity_status": "blocked_missing_empirical_authority",
        }
        decision = SimpleNamespace(
            strategy_id="strategy-1",
            symbol="AAPL",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
        )

        original_enabled = config.settings.trading_lean_strategy_shadow_enabled
        original_disable_switch = config.settings.trading_lean_lane_disable_switch
        try:
            config.settings.trading_lean_strategy_shadow_enabled = True
            config.settings.trading_lean_lane_disable_switch = False
            TradingPipeline._maybe_record_lean_strategy_shadow(
                pipeline,
                session=session,
                decision=decision,
                execution_client=execution_client,
                selected_adapter_name="lean",
            )
        finally:
            config.settings.trading_lean_strategy_shadow_enabled = original_enabled
            config.settings.trading_lean_lane_disable_switch = original_disable_switch

        session.rollback.assert_called_once()
        metrics.record_lean_strategy_shadow.assert_any_call("error")

    def test_runtime_uncertainty_gate_records_uncertainty_sub_gate_action(self) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        gate_payload = {
            "action": "fail",
            "source": "regime_hmm_transition_shock",
            "uncertainty_gate": {"action": "pass", "source": "autonomy_gate_report"},
            "regime_gate": {"action": "fail", "source": "regime_hmm_transition_shock"},
        }

        pipeline._record_runtime_uncertainty_gate_result(
            gate_payload=gate_payload,
            gate_rejection="runtime_uncertainty_gate_fail_block_new_entries",
        )

        self.assertEqual(
            pipeline.state.metrics.runtime_uncertainty_gate_action_total.get("pass"),
            1,
        )
        self.assertEqual(
            pipeline.state.metrics.runtime_uncertainty_gate_action_total.get("fail"),
            None,
        )
        self.assertEqual(pipeline.state.last_runtime_uncertainty_gate_action, "pass")

    def test_runtime_uncertainty_gate_blocks_source_is_component_scoped(self) -> None:
        pipeline = TradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={
                "uncertainty_gate_action": "pass",
                "regime_gate": {
                    "action": "fail",
                    "source": "decision_regime_gate",
                    "reason": "regime_context_transition_shock",
                },
            },
        )

        _, payload, reason = pipeline._apply_runtime_uncertainty_gate(
            decision,
            positions=[],
        )

        self.assertEqual(reason, "runtime_uncertainty_gate_fail_block_new_entries")
        self.assertEqual(payload.get("regime_action_blocked"), "decision_regime_gate")
        self.assertIsNone(payload.get("uncertainty_action_blocked"))

    def test_runtime_uncertainty_gate_degrades_autonomy_coverage_failures(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write(
                json.dumps(
                    {
                        "uncertainty_gate_action": "fail",
                        "coverage_error": "1",
                        "shift_score": "1",
                        "conformal_interval_width": "0",
                    }
                )
            )
            gate_path = handle.name
        try:
            state = TradingState()
            state.last_autonomy_gates = gate_path
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("4"),
                params={"price": Decimal("100")},
            )

            degraded, payload, reason = pipeline._apply_runtime_uncertainty_gate(
                decision,
                positions=[],
            )

            self.assertIsNone(reason)
            self.assertEqual(payload.get("action"), "degrade")
            self.assertIn(
                payload.get("source"),
                {
                    "autonomy_gate_report_coverage_fallback",
                    "autonomy_gate_report_saturated_fail_sentinel",
                },
            )
            self.assertLess(degraded.qty, decision.qty)
        finally:
            Path(gate_path).unlink(missing_ok=True)

    def test_submit_order_retries_sell_inventory_conflict_after_cancel(self) -> None:
        client = SellInventoryConflictRetryClient()
        order_firewall = OrderFirewall(client)
        pipeline = TradingPipeline(
            alpaca_client=client,
            order_firewall=order_firewall,
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )
            decision_row = pipeline.executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution, rejected = pipeline._submit_order_with_handling(
                session=session,
                execution_client=order_firewall,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name="alpaca",
                retry_delays=[],
            )

            self.assertFalse(rejected)
            self.assertIsNotNone(execution)
            self.assertEqual(client.cancel_calls, ["open-sell-1"])
            self.assertEqual(len(client.submitted), 1)
            self.assertEqual(Decimal(client.submitted[0]["qty"]), Decimal("1"))
            session.refresh(decision_row)
            broker_precheck_recovery = decision_row.decision_json.get(
                "broker_precheck_recovery", {}
            )
            self.assertEqual(
                broker_precheck_recovery.get("code"),
                "sell_inventory_conflict_retried_after_cancel",
            )
            self.assertEqual(broker_precheck_recovery.get("status"), "cleared")

    def test_runtime_uncertainty_gate_does_not_bypass_kill_switch_precedence(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-precedence",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"abstain"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 0.4, "signal": 1.0},
                        "rsi14": 75,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "long",
                            "market_value": "500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                self.assertEqual(alpaca_client.submitted, [])
                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    risk_reasons = decision_json.get("risk_reasons", [])
                    self.assertIn("kill_switch_enabled", risk_reasons)
                    self.assertNotIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        risk_reasons,
                    )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_persists_adaptive_policy_and_records_fallback_metric(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="adaptive-metrics",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                    "regime_label": "trend",
                },
                timeframe="1Min",
            )

            fallback_policy = AdaptiveExecutionPolicyDecision(
                key="AAPL:trend",
                symbol="AAPL",
                regime_label="trend",
                sample_size=12,
                adaptive_samples=8,
                baseline_slippage_bps=Decimal("8"),
                recent_slippage_bps=Decimal("16"),
                baseline_shortfall_notional=Decimal("1"),
                recent_shortfall_notional=Decimal("4"),
                effect_size_bps=Decimal("-8"),
                degradation_bps=Decimal("8"),
                expected_shortfall_coverage=Decimal("1"),
                expected_shortfall_sample_count=12,
                fallback_active=True,
                fallback_reason="adaptive_policy_degraded",
                prefer_limit=True,
                participation_rate_scale=Decimal("0.8"),
                execution_seconds_scale=Decimal("1.2"),
                aggressiveness="defensive",
                generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

            state = TradingState()
            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )

            with patch(
                "app.trading.scheduler.pipeline.derive_adaptive_execution_policy",
                return_value=fallback_policy,
            ):
                pipeline.run_once()

            with self.session_local() as session:
                decision_row = session.execute(select(TradeDecision)).scalar_one()
                decision_json = decision_row.decision_json
                assert isinstance(decision_json, dict)
                params = decision_json.get("params")
                assert isinstance(params, dict)
                execution_policy = params.get("execution_policy")
                assert isinstance(execution_policy, dict)
                adaptive = execution_policy.get("adaptive")
                assert isinstance(adaptive, dict)
                self.assertFalse(adaptive.get("applied"))
                self.assertEqual(adaptive.get("reason"), "adaptive_policy_degraded")

            self.assertEqual(state.metrics.adaptive_policy_decisions_total, 1)
            self.assertEqual(state.metrics.adaptive_policy_fallback_total, 1)
            self.assertEqual(state.metrics.adaptive_policy_applied_total, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_kill_switch_cancels_and_blocks_submissions(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_kill_switch_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()

            self.assertEqual(alpaca_client.cancel_all_calls, 1)
            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(pipeline.state.metrics.orders_rejected_total, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_reuses_account_snapshot_within_reconcile_interval(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_reconcile_ms": config.settings.trading_reconcile_ms,
        }
        config.settings.trading_enabled = False
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_reconcile_ms = 60000

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = CountingAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            pipeline.run_once()

            self.assertEqual(alpaca_client.account_calls, 1)
            self.assertEqual(alpaca_client.position_calls, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_reconcile_ms = original["trading_reconcile_ms"]

    def test_pipeline_persists_price_snapshot(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": Decimal("101.5"),
                    "spread": Decimal("0.02"),
                    "imbalance_bid_px": Decimal("101.49"),
                    "imbalance_ask_px": Decimal("101.51"),
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                price_fetcher=FakePriceFetcher(
                    Decimal("101.5"), spread=Decimal("0.02")
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 1)
                decision_json = decisions[0].decision_json
                params = decision_json.get("params", {})
                self.assertEqual(params.get("price"), "101.5")
                snapshot = params.get("price_snapshot", {})
                self.assertEqual(snapshot.get("price"), "101.5")
                self.assertEqual(snapshot.get("source"), "price_fetcher")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]

    def test_pipeline_llm_approve(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_abstain_fail_mode": config.settings.llm_abstain_fail_mode,
            "llm_escalate_fail_mode": config.settings.llm_escalate_fail_mode,
            "llm_quality_fail_mode": config.settings.llm_quality_fail_mode,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_abstain_fail_mode = "veto"
        config.settings.llm_escalate_fail_mode = "veto"
        config.settings.llm_quality_fail_mode = "veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="approve"),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "approve")
                self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_abstain_fail_mode = original["llm_abstain_fail_mode"]
            config.settings.llm_escalate_fail_mode = original["llm_escalate_fail_mode"]
            config.settings.llm_quality_fail_mode = original["llm_quality_fail_mode"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_order_submit_rejection_does_not_crash_or_retry(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca = RejectingAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            pipeline.run_once()
            pipeline.run_once()

            self.assertEqual(alpaca.submit_calls, 1)
            self.assertEqual(alpaca.cancel_calls, ["order-existing"])

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]

    def test_sell_inventory_conflict_does_not_cancel_existing_sell_order(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            alpaca = SellInventoryConflictAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca,
                order_firewall=OrderFirewall(alpaca),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            execution, rejected = pipeline._submit_order_with_handling(
                session=session,
                execution_client=alpaca,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name="alpaca",
                retry_delays=[],
            )

            self.assertIsNone(execution)
            self.assertTrue(rejected)
            self.assertEqual(alpaca.cancel_calls, ["existing-sell-order"])

            session.refresh(decision_row)
            self.assertEqual(decision_row.status, "rejected")
            self.assertEqual(
                decision_row.decision_json.get("reject_reason_atomic"),
                ["sell_inventory_unavailable"],
            )
            self.assertEqual(
                decision_row.decision_json.get("broker_precheck", {}).get("code"),
                "precheck_sell_qty_exceeds_available",
            )
            self.assertEqual(
                decision_row.decision_json.get("broker_precheck_recovery", {}).get(
                    "status"
                ),
                "blocked",
            )

    def test_pipeline_llm_veto(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="veto"),
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_adjust(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_adjustment_allowed = True
        _set_llm_guardrails(config, adjustment_approved=True)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            with tempfile.TemporaryDirectory() as tmpdir:
                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}', encoding="utf-8"
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.1, "signal": 0.4},
                        "rsi14": 25,
                        "price": 100,
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R1",
                        "posterior": {"R1": 1.0},
                        "entropy": "0.12",
                        "entropy_band": "low",
                        "predicted_next": "R1",
                        "transition_shock": False,
                        "duration_ms": 0,
                        "artifact": {
                            "model_id": "hmm-regime-v1.0",
                            "feature_schema": "hmm-v1",
                            "training_run_id": "run-2026",
                        },
                        "guardrail": {
                            "stale": False,
                            "fallback_to_defensive": False,
                        },
                    },
                    timeframe="1Min",
                )

                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(last_autonomy_gates=str(gate_path)),
                    account_label="paper",
                    session_factory=self.session_local,
                    llm_review_engine=FakeLLMReviewEngine(
                        verdict="adjust",
                        adjusted_qty=Decimal("8"),
                        adjusted_order_type="limit",
                        limit_price=Decimal("101.5"),
                    ),
                )

                pipeline.run_once()

                with self.session_local() as session:
                    reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                    executions = session.execute(select(Execution)).scalars().all()
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(reviews[0].verdict, "adjust")
                    self.assertEqual(reviews[0].adjusted_qty, Decimal("8"))
                    self.assertEqual(len(executions), 1)
                    self.assertEqual(executions[0].submitted_qty, Decimal("8"))
                    decision_json = decisions[0].decision_json
                    self.assertIn("llm_adjusted_decision", decision_json)
                    self.assertEqual(decision_json["llm_adjusted_decision"]["qty"], "8")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_failure_fallbacks(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_abstain_fail_mode": config.settings.llm_abstain_fail_mode,
            "llm_escalate_fail_mode": config.settings.llm_escalate_fail_mode,
            "llm_quality_fail_mode": config.settings.llm_quality_fail_mode,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            config.settings.trading_mode = "paper"
            config.settings.trading_live_enabled = False
            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
            )
            pipeline.run_once()

            with self.session_local() as session:
                executions = session.execute(select(Execution)).scalars().all()
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                self.assertEqual(len(executions), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
                self.assertEqual(
                    reviews[0].response_json.get("effective_verdict"), "approve"
                )
                policy_resolution = reviews[0].response_json.get("policy_resolution")
                self.assertIsInstance(policy_resolution, dict)
                assert isinstance(policy_resolution, dict)
                self.assertIn("effective_fail_mode", policy_resolution)
                self.assertIn("reasoning", policy_resolution)
                lineage = reviews[0].response_json.get("dspy_lineage")
                self.assertIsInstance(lineage, dict)
                assert isinstance(lineage, dict)
                self.assertEqual(
                    lineage.get("program_name"),
                    config.settings.llm_dspy_program_name,
                )
                self.assertEqual(
                    lineage.get("signature_version"),
                    config.settings.llm_dspy_signature_version,
                )
                configured_artifact_hash = config.settings.llm_dspy_artifact_hash
                if isinstance(configured_artifact_hash, str):
                    expected_artifact_hash = configured_artifact_hash.strip() or None
                else:
                    expected_artifact_hash = None
                self.assertEqual(lineage.get("artifact_hash"), expected_artifact_hash)
                committee_veto_alignment = reviews[0].response_json.get(
                    "committee_veto_alignment"
                )
                self.assertIsInstance(committee_veto_alignment, dict)
                assert isinstance(committee_veto_alignment, dict)
                self.assertFalse(committee_veto_alignment.get("committee_veto", True))
                self.assertFalse(
                    committee_veto_alignment.get("deterministic_veto", True)
                )

            config.settings.trading_mode = "live"
            config.settings.trading_live_enabled = True
            config.settings.trading_autonomy_allow_live_promotion = True
            live_signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.2, "signal": 0.3},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )
            live_alpaca = FakeAlpacaClient()
            pipeline_live = TradingPipeline(
                alpaca_client=live_alpaca,
                order_firewall=OrderFirewall(live_alpaca),
                ingestor=FakeIngestor([live_signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=live_alpaca,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(error=RuntimeError("boom")),
            )
            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline_live.run_once()

            with self.session_local() as session:
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(executions), 2)
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(decisions[-1].status, "submitted")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_committee_veto_detection_helper(self) -> None:
        with_veto = {
            "committee": {
                "roles": {
                    "risk_critic": {"verdict": "veto"},
                    "execution_critic": {"verdict": "approve"},
                }
            }
        }
        without_veto = {
            "committee": {
                "roles": {
                    "risk_critic": {"verdict": "approve"},
                    "execution_critic": {"verdict": "adjust"},
                }
            }
        }

        self.assertTrue(_committee_trace_has_veto(with_veto))
        self.assertFalse(_committee_trace_has_veto(without_veto))
        self.assertFalse(_committee_trace_has_veto({}))

    def test_dspy_lineage_helper_uses_response_payload(self) -> None:
        response_json = {
            "dspy": {
                "mode": "active",
                "program_name": "trade-review-committee-v9",
                "signature_version": "2026-03-03.v9",
                "artifact_hash": "f" * 64,
                "artifact_source": "runtime_fallback",
            }
        }

        lineage = _build_dspy_lineage(response_json)

        self.assertEqual(lineage["mode"], "active")
        self.assertEqual(lineage["program_name"], "trade-review-committee-v9")
        self.assertEqual(lineage["signature_version"], "2026-03-03.v9")
        self.assertEqual(lineage["artifact_hash"], "f" * 64)
        self.assertEqual(lineage["artifact_source"], "runtime_fallback")

    def test_pipeline_llm_unsupported_runtime_state_vetoes_decision(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_abstain_fail_mode": config.settings.llm_abstain_fail_mode,
            "llm_escalate_fail_mode": config.settings.llm_escalate_fail_mode,
            "llm_quality_fail_mode": config.settings.llm_quality_fail_mode,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            config.settings.trading_mode = "paper"
            config.settings.trading_live_enabled = False
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(
                    error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].response_json.get("effective_verdict"), "veto"
                )
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_unsupported_runtime_state_vetoes_decision_in_shadow_mode(
        self,
    ) -> None:
        from app import config

        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_runtime_disabled",)

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine(
                error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
            )
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_UnavailableLiveRuntime(),
            ):
                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="live",
                    session_factory=self.session_local,
                    llm_review_engine=engine,
                )
                eligible_summary = {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                }
                self._seed_promotion_certificate_evidence()
                with (
                    patch(
                        "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                        return_value=eligible_summary,
                    ),
                    patch(
                        "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                        return_value={"ready": True, "status": "healthy"},
                    ),
                    patch(
                        "app.trading.scheduler.pipeline.load_quant_evidence_status",
                        return_value=self._healthy_live_quant_status(),
                    ),
                ):
                    pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].response_json.get("effective_verdict"), "veto"
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_allows_live_path(self) -> None:
        from app import config

        class _AvailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return True, ()

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_abstain_fail_mode": config.settings.llm_abstain_fail_mode,
            "llm_escalate_fail_mode": config.settings.llm_escalate_fail_mode,
            "llm_quality_fail_mode": config.settings.llm_quality_fail_mode,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_abstain_fail_mode = "veto"
        config.settings.llm_escalate_fail_mode = "veto"
        config.settings.llm_quality_fail_mode = "veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_AvailableLiveRuntime(),
            ):
                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="live",
                    session_factory=self.session_local,
                    llm_review_engine=engine,
                )
                eligible_summary = {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_abstain_fail_mode = original["llm_abstain_fail_mode"]
            config.settings.llm_escalate_fail_mode = original["llm_escalate_fail_mode"]
            config.settings.llm_quality_fail_mode = original["llm_quality_fail_mode"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_readiness_blocked_without_dspy_live_artifact(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_active_mode_requires_dspy_live_executor",)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_UnavailableLiveRuntime(),
            ):
                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="live",
                    session_factory=self.session_local,
                    llm_review_engine=engine,
                )
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_when_stage_not_stage3(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage2"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=engine,
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(len(decisions), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(
                    reviews[0].response_json.get("llm_runtime", {}).get("subtype"),
                    "policy_blocked",
                )
                self.assertEqual(
                    decisions[0].decision_json.get("llm_runtime", {}).get("subtype"),
                    "policy_blocked",
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocked_in_live(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)
        config.settings.llm_model_version_lock = "mismatch-model:v2"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=engine,
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                llm_runtime = reviews[0].response_json.get("llm_runtime", {})
                self.assertEqual(
                    llm_runtime.get("reject_reason"),
                    "llm_runtime_fallback_policy_blocked",
                )
                self.assertEqual(llm_runtime.get("subtype"), "policy_blocked")
                self.assertIsInstance(llm_runtime.get("primary_reason"), str)
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_classify_dspy_live_runtime_block_distinguishes_artifact_and_runtime_causes(
        self,
    ) -> None:
        artifact = TradingPipeline._classify_dspy_live_runtime_block(
            ("dspy_bootstrap_artifact_forbidden",)
        )
        runtime = TradingPipeline._classify_dspy_live_runtime_block(
            ("dspy_live_readiness_error:TimeoutError",)
        )

        self.assertEqual(
            artifact, ("llm_runtime_fallback_artifact_invalid", "artifact_invalid")
        )
        self.assertEqual(
            runtime, ("llm_runtime_fallback_runtime_not_ready", "runtime_not_ready")
        )

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_malformed_artifact_hash(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.llm_dspy_artifact_hash = "not-a-valid-hex-hash"
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings"
            ) as from_settings:
                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="live",
                    session_factory=self.session_local,
                )
                pipeline.run_once()
                from_settings.assert_not_called()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_before_readiness_probe(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)
        config.settings.llm_model_version_lock = "mismatch-model:v2"

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings"
            ) as from_settings:
                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="live",
                    session_factory=self.session_local,
                    llm_review_engine=engine,
                )
                pipeline.run_once()
                from_settings.assert_not_called()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale,
                    "llm_dspy_live_runtime_gate_blocked",
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_bootstrap_artifact_hash(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=engine,
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_can_pass_through_with_degraded_qty(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_dspy_live_runtime_block_fail_mode": config.settings.llm_dspy_live_runtime_block_fail_mode,
            "llm_dspy_live_runtime_block_qty_multiplier": config.settings.llm_dspy_live_runtime_block_qty_multiplier,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_fail_open_live_approved = True
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_dspy_live_runtime_block_fail_mode = (
            "pass_through_reduced_size"
        )
        config.settings.llm_dspy_live_runtime_block_qty_multiplier = 0.5
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=CountingLLMReviewEngine(),
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()

                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale,
                    "llm_dspy_live_runtime_gate_blocked",
                )
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
                self.assertLess(executions[0].submitted_qty, Decimal("10"))
                self.assertGreaterEqual(executions[0].submitted_qty, Decimal("1"))
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_dspy_live_runtime_block_fail_mode = original[
                "llm_dspy_live_runtime_block_fail_mode"
            ]
            config.settings.llm_dspy_live_runtime_block_qty_multiplier = original[
                "llm_dspy_live_runtime_block_qty_multiplier"
            ]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_shadow_bootstrap_artifact_keeps_live_submission_operational(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "shadow"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
            )

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()

                self.assertEqual(len(reviews), 1)
                self.assertNotEqual(reviews[0].verdict, "error")
                self.assertNotEqual(
                    reviews[0].rationale,
                    "llm_dspy_live_runtime_gate_blocked",
                )
                dspy_payload = reviews[0].response_json.get("dspy")
                self.assertIsInstance(dspy_payload, dict)
                assert isinstance(dspy_payload, dict)
                self.assertEqual(dspy_payload.get("artifact_source"), "bootstrap")
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]

    def test_pipeline_llm_dspy_runtime_reduced_sell_uses_seeded_simulation_inventory(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_simulation_enabled": config.settings.trading_simulation_enabled,
            "trading_allow_shorts": config.settings.trading_allow_shorts,
            "trading_fractional_equities_enabled": config.settings.trading_fractional_equities_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_dspy_live_runtime_block_fail_mode": config.settings.llm_dspy_live_runtime_block_fail_mode,
            "llm_dspy_live_runtime_block_qty_multiplier": config.settings.llm_dspy_live_runtime_block_qty_multiplier,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_simulation_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_fail_open_live_approved = True
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = (
            DSPyReviewRuntime.bootstrap_artifact_hash()
        )
        config.settings.llm_rollout_stage = "stage3"
        config.settings.llm_dspy_live_runtime_block_fail_mode = (
            "pass_through_reduced_size"
        )
        config.settings.llm_dspy_live_runtime_block_qty_multiplier = 0.5
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo-sell",
                    description="demo sell",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("100"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 0.1, "signal": 0.4},
                    "rsi14": 75,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = PositionedAlpacaClient(
                [{"symbol": "AAPL", "qty": "2", "side": "long"}]
            )
            execution_adapter = SimulationExecutionAdapter(
                bootstrap_servers=None,
                security_protocol=None,
                sasl_mechanism=None,
                sasl_username=None,
                sasl_password=None,
                topic="torghut.sim.trade-updates.v1",
                account_label="live",
                simulation_run_id="sim-test",
                dataset_id="dataset-a",
            )
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=execution_adapter,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=CountingLLMReviewEngine(),
            )
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
                patch(
                    "app.trading.scheduler.pipeline.trading_now",
                    return_value=signal.event_ts,
                ),
                patch(
                    "app.trading.execution_adapters.active_simulation_runtime_context",
                    return_value={"run_id": "sim-test", "dataset_id": "dataset-a"},
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()

                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale,
                    "llm_dspy_live_runtime_gate_blocked",
                )
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
                self.assertLess(executions[0].submitted_qty, Decimal("1"))
                remaining_qty = Decimal(
                    str(execution_adapter.list_positions()[0]["qty"])
                )
                self.assertEqual(
                    remaining_qty,
                    Decimal("2") - executions[0].submitted_qty,
                )
                self.assertEqual(
                    execution_adapter.list_positions(),
                    [
                        {
                            "symbol": "AAPL",
                            "qty": str(remaining_qty.normalize()),
                            "side": "long",
                            "alpaca_account_label": "live",
                        }
                    ],
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_simulation_enabled = original[
                "trading_simulation_enabled"
            ]
            config.settings.trading_allow_shorts = original["trading_allow_shorts"]
            config.settings.trading_fractional_equities_enabled = original[
                "trading_fractional_equities_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_dspy_live_runtime_block_fail_mode = original[
                "llm_dspy_live_runtime_block_fail_mode"
            ]
            config.settings.llm_dspy_live_runtime_block_qty_multiplier = original[
                "llm_dspy_live_runtime_block_qty_multiplier"
            ]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_dspy_live_runtime_gate_blocks_without_jangar_base_url(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "strict_veto"
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        config.settings.jangar_base_url = None
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine()
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
                llm_review_engine=engine,
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale, "llm_dspy_live_runtime_gate_blocked"
                )
                self.assertEqual(reviews[0].response_json.get("fallback"), "veto")
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_disabled_keeps_live_submission_operational(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_autonomy_allow_live_promotion": config.settings.trading_autonomy_allow_live_promotion,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_autonomy_allow_live_promotion = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = False
        config.settings.llm_shadow_mode = True
        config.settings.llm_dspy_runtime_mode = "disabled"
        config.settings.llm_dspy_artifact_hash = None

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="live",
                session_factory=self.session_local,
            )

            eligible_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            self._seed_promotion_certificate_evidence()
            with (
                patch(
                    "app.trading.scheduler.pipeline.build_hypothesis_runtime_summary",
                    return_value=eligible_summary,
                ),
                patch(
                    "app.trading.scheduler.pipeline.build_empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.trading.scheduler.pipeline.load_quant_evidence_status",
                    return_value=self._healthy_live_quant_status(),
                ),
            ):
                pipeline.run_once()

            with self.session_local() as session:
                llm_reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()

            self.assertEqual(llm_reviews, [])
            self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]

    def test_pipeline_llm_dspy_unsupported_runtime_state_vetoes_in_live(self) -> None:
        from app import config

        class _UnavailableLiveRuntime:
            def evaluate_live_readiness(self) -> tuple[bool, tuple[str, ...]]:
                return False, ("dspy_runtime_disabled",)

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": config.settings.llm_fail_open_live_approved,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
            "llm_dspy_runtime_mode": config.settings.llm_dspy_runtime_mode,
            "llm_dspy_artifact_hash": config.settings.llm_dspy_artifact_hash,
            "llm_dspy_program_name": config.settings.llm_dspy_program_name,
            "llm_dspy_signature_version": config.settings.llm_dspy_signature_version,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "jangar_base_url": config.settings.jangar_base_url,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        config.settings.llm_fail_open_live_approved = True
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_dspy_runtime_mode = "active"
        config.settings.jangar_base_url = "http://jangar.test"
        config.settings.llm_dspy_artifact_hash = "a" * 64
        config.settings.llm_rollout_stage = "stage3"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            engine = CountingLLMReviewEngine(
                error=DSPyRuntimeUnsupportedStateError("dspy_runtime_disabled")
            )
            with patch(
                "app.trading.scheduler.pipeline.DSPyReviewRuntime.from_settings",
                return_value=_UnavailableLiveRuntime(),
            ):
                pipeline = TradingPipeline(
                    alpaca_client=FakeAlpacaClient(),
                    order_firewall=OrderFirewall(FakeAlpacaClient()),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=FakeAlpacaClient(),
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(),
                    account_label="live",
                    session_factory=self.session_local,
                    llm_review_engine=engine,
                )
                pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].rationale,
                    "llm_dspy_live_runtime_gate_blocked",
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(engine.review_calls, 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
            config.settings.llm_dspy_runtime_mode = original["llm_dspy_runtime_mode"]
            config.settings.llm_dspy_artifact_hash = original["llm_dspy_artifact_hash"]
            config.settings.llm_dspy_program_name = original["llm_dspy_program_name"]
            config.settings.llm_dspy_signature_version = original[
                "llm_dspy_signature_version"
            ]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.jangar_base_url = original["jangar_base_url"]

    def test_pipeline_llm_guardrails_force_shadow(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_shadow_mode = False
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_allowed_models_raw = None
        config.settings.llm_evaluation_report = None
        config.settings.llm_effective_challenge_id = None
        config.settings.llm_shadow_completed_at = None
        config.settings.llm_adjustment_approved = False

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(verdict="veto"),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
                self.assertEqual(pipeline.state.metrics.llm_guardrail_shadow_total, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_circuit_open(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(circuit_open=True),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(len(executions), 1)
                self.assertEqual(pipeline.state.metrics.llm_circuit_open_total, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_stage1_live_uses_mode_consistent_fail_mode(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_rollout_stage = "stage1_shadow_pilot"
        config.settings.llm_shadow_mode = False
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(circuit_open=True),
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(decisions[0].status, "blocked")
                self.assertEqual(
                    decisions[0].decision_json.get("submission_block_reason"),
                    "capital_stage_shadow",
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(pipeline.state.metrics.llm_fail_mode_override_total, 0)
                self.assertEqual(
                    pipeline.state.metrics.llm_fail_mode_exception_total, 0
                )
                self.assertEqual(
                    pipeline.state.metrics.llm_policy_resolution_total.get("compliant"),
                    1,
                )
                self.assertEqual(
                    pipeline.state.metrics.llm_stage_policy_violation_total, 1
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_stage1_market_context_failure_keeps_shadow_mode(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_market_context_fail_mode": config.settings.trading_market_context_fail_mode,
            "llm_enabled": config.settings.llm_enabled,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_live_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_market_context_fail_mode = "fail_closed"
        config.settings.llm_enabled = True
        config.settings.llm_rollout_stage = "stage1_shadow_pilot"
        config.settings.llm_shadow_mode = False
        config.settings.llm_fail_mode = "pass_through"
        config.settings.llm_fail_mode_enforcement = "configured"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            class _FailingMarketContextClient:
                @staticmethod
                def fetch(symbol: str) -> MarketContextBundle | None:
                    raise RuntimeError(f"market-context unavailable for {symbol}")

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(),
            )
            pipeline.market_context_client = _FailingMarketContextClient()

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].response_json.get("error"),
                    "market_context_fetch_error",
                )
                self.assertEqual(
                    decisions[0].decision_json.get("market_context", {}).get("reason"),
                    "market_context_fetch_error",
                )
                policy_resolution = reviews[0].response_json.get("policy_resolution")
                self.assertIsInstance(policy_resolution, dict)
                # Stage1 rollout must stay shadow-only even when fail mode is configured as fail_closed.
                self.assertEqual(decisions[0].status, "blocked")
                self.assertEqual(
                    decisions[0].decision_json.get("submission_block_reason"),
                    "capital_stage_shadow",
                )
                self.assertEqual(len(executions), 0)
                self.assertEqual(
                    pipeline.state.metrics.llm_market_context_block_total, 1
                )
                self.assertEqual(pipeline.state.metrics.llm_guardrail_shadow_total, 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_market_context_fail_mode = original[
                "trading_market_context_fail_mode"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_stage2_fail_mode_forces_pass_through(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_rollout_stage": config.settings.llm_rollout_stage,
            "llm_shadow_mode": config.settings.llm_shadow_mode,
            "llm_fail_mode": config.settings.llm_fail_mode,
            "llm_fail_mode_enforcement": config.settings.llm_fail_mode_enforcement,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_model_version_lock": config.settings.llm_model_version_lock,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_rollout_stage = "stage2"
        config.settings.llm_shadow_mode = False
        config.settings.llm_fail_mode = "veto"
        config.settings.llm_fail_mode_enforcement = "configured"
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(circuit_open=True),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "error")
                self.assertEqual(
                    reviews[0].response_json.get("fallback"), "pass_through"
                )
                policy_resolution = reviews[0].response_json.get("policy_resolution")
                self.assertIsInstance(policy_resolution, dict)
                assert isinstance(policy_resolution, dict)
                self.assertEqual(policy_resolution.get("rollout_stage"), "stage2")
                self.assertEqual(
                    pipeline.state.metrics.llm_policy_resolution_total.get("violation"),
                    1,
                )
                self.assertEqual(decisions[0].status, "submitted")
                self.assertEqual(len(executions), 1)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_rollout_stage = original["llm_rollout_stage"]
            config.settings.llm_shadow_mode = original["llm_shadow_mode"]
            config.settings.llm_fail_mode = original["llm_fail_mode"]
            config.settings.llm_fail_mode_enforcement = original[
                "llm_fail_mode_enforcement"
            ]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_model_version_lock = original["llm_model_version_lock"]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_min_confidence(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.9
        _set_llm_guardrails(config)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            signal = SignalEnvelope(
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                payload={
                    "macd": {"macd": 1.1, "signal": 0.4},
                    "rsi14": 25,
                    "price": 100,
                },
                timeframe="1Min",
            )

            alpaca_client = FakeAlpacaClient()
            pipeline = TradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
                llm_review_engine=FakeLLMReviewEngine(
                    verdict="approve", confidence=0.1
                ),
            )

            pipeline.run_once()

            with self.session_local() as session:
                reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                decisions = session.execute(select(TradeDecision)).scalars().all()
                executions = session.execute(select(Execution)).scalars().all()
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0].verdict, "veto")
                self.assertEqual(decisions[0].status, "rejected")
                self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_pipeline_llm_adjust_out_of_bounds(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_live_enabled": config.settings.trading_live_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_adjustment_allowed = True
        config.settings.llm_min_confidence = 0.0
        _set_llm_guardrails(config, adjustment_approved=True)

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="demo",
                    description="demo",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            with tempfile.TemporaryDirectory() as tmpdir:
                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"pass"}', encoding="utf-8"
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.1, "signal": 0.4},
                        "rsi14": 25,
                        "price": 100,
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R1",
                        "posterior": {"R1": 1.0},
                        "entropy": "0.12",
                        "entropy_band": "low",
                        "predicted_next": "R1",
                        "transition_shock": False,
                        "duration_ms": 0,
                        "artifact": {
                            "model_id": "hmm-regime-v1.0",
                            "feature_schema": "hmm-v1",
                            "training_run_id": "run-2026",
                        },
                        "guardrail": {
                            "stale": False,
                            "fallback_to_defensive": False,
                        },
                    },
                    timeframe="1Min",
                )

                alpaca_client = FakeAlpacaClient()
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=TradingState(last_autonomy_gates=str(gate_path)),
                    account_label="paper",
                    session_factory=self.session_local,
                    llm_review_engine=FakeLLMReviewEngine(
                        verdict="adjust",
                        adjusted_qty=Decimal("50"),
                        adjusted_order_type="market",
                    ),
                )

                pipeline.run_once()

                with self.session_local() as session:
                    reviews = session.execute(select(LLMDecisionReview)).scalars().all()
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    executions = session.execute(select(Execution)).scalars().all()
                    self.assertEqual(len(reviews), 1)
                    self.assertEqual(reviews[0].verdict, "adjust")
                    self.assertEqual(reviews[0].adjusted_qty, Decimal("12.5"))
                    self.assertEqual(decisions[0].status, "rejected")
                    self.assertEqual(len(executions), 0)
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_live_enabled = original["trading_live_enabled"]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]
