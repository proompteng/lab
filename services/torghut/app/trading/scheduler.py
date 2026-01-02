"""Background scheduler for the trading pipeline."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from ..db import SessionLocal
from ..models import LLMDecisionReview, Strategy, TradeDecision
from ..snapshots import snapshot_account_and_positions
from .decisions import DecisionEngine
from .execution import OrderExecutor
from .ingest import ClickHouseSignalIngestor
from .llm import LLMReviewEngine, apply_policy
from .models import StrategyDecision
from .reconcile import Reconciler
from .risk import RiskEngine
from .universe import UniverseResolver

logger = logging.getLogger(__name__)


@dataclass
class TradingMetrics:
    decisions_total: int = 0
    orders_submitted_total: int = 0
    orders_rejected_total: int = 0
    reconcile_updates_total: int = 0


@dataclass
class TradingState:
    running: bool = False
    last_run_at: Optional[datetime] = None
    last_reconcile_at: Optional[datetime] = None
    last_error: Optional[str] = None
    metrics: TradingMetrics = field(default_factory=TradingMetrics)


class TradingPipeline:
    """Orchestrate ingest -> decide -> risk -> execute for one cycle."""

    def __init__(
        self,
        alpaca_client: TorghutAlpacaClient,
        ingestor: ClickHouseSignalIngestor,
        decision_engine: DecisionEngine,
        risk_engine: RiskEngine,
        executor: OrderExecutor,
        reconciler: Reconciler,
        universe_resolver: UniverseResolver,
        state: TradingState,
        account_label: str,
        session_factory: Callable[[], Session] = SessionLocal,
        llm_review_engine: Optional[LLMReviewEngine] = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.ingestor = ingestor
        self.decision_engine = decision_engine
        self.risk_engine = risk_engine
        self.executor = executor
        self.reconciler = reconciler
        self.universe_resolver = universe_resolver
        self.state = state
        self.account_label = account_label
        self.session_factory = session_factory
        if llm_review_engine is not None:
            self.llm_review_engine = llm_review_engine
        elif settings.llm_enabled:
            self.llm_review_engine = LLMReviewEngine()
        else:
            self.llm_review_engine = None

    def run_once(self) -> None:
        with self.session_factory() as session:
            strategies = self._load_strategies(session)
            if not strategies:
                logger.info("No enabled strategies found; skipping trading cycle")
                return

            signals = self.ingestor.fetch_signals(session)
            if not signals:
                return

            account_snapshot = snapshot_account_and_positions(session, self.alpaca_client, self.account_label)
            account = {
                "equity": str(account_snapshot.equity),
                "cash": str(account_snapshot.cash),
                "buying_power": str(account_snapshot.buying_power),
            }
            positions = account_snapshot.positions

            allowed_symbols = self.universe_resolver.get_symbols()

            for signal in signals:
                decisions = self.decision_engine.evaluate(signal, strategies)
                if not decisions:
                    continue
                for decision in decisions:
                    self.state.metrics.decisions_total += 1
                    self._handle_decision(session, decision, strategies, account, positions, allowed_symbols)

    def reconcile(self) -> int:
        with self.session_factory() as session:
            updates = self.reconciler.reconcile(session, self.alpaca_client)
            if updates:
                self.state.metrics.reconcile_updates_total += updates
            return updates

    def _handle_decision(
        self,
        session: Session,
        decision: StrategyDecision,
        strategies: list[Strategy],
        account: dict[str, str],
        positions: list[dict[str, str]],
        allowed_symbols: Optional[set[str]],
    ) -> None:
        strategy = next((s for s in strategies if str(s.id) == decision.strategy_id), None)
        if strategy is None:
            return

        strategy_symbols = _coerce_strategy_symbols(strategy.universe_symbols)
        if strategy_symbols and allowed_symbols:
            symbol_allowlist = strategy_symbols & allowed_symbols
        elif strategy_symbols:
            symbol_allowlist = strategy_symbols
        else:
            symbol_allowlist = allowed_symbols

        decision_row = self.executor.ensure_decision(session, decision, strategy, self.account_label)
        if self.executor.execution_exists(session, decision_row):
            return

        decision, llm_reject_reason = self._apply_llm_review(
            session,
            decision,
            decision_row,
            account,
            positions,
        )
        if llm_reject_reason:
            self.state.metrics.orders_rejected_total += 1
            self.executor.mark_rejected(session, decision_row, llm_reject_reason)
            return

        verdict = self.risk_engine.evaluate(session, decision, strategy, account, positions, symbol_allowlist)
        if not verdict.approved:
            self.state.metrics.orders_rejected_total += 1
            for reason in verdict.reasons:
                logger.info(
                    "Decision rejected strategy_id=%s symbol=%s reason=%s",
                    decision.strategy_id,
                    decision.symbol,
                    reason,
                )
            self.executor.mark_rejected(session, decision_row, ";".join(verdict.reasons))
            return

        if not settings.trading_enabled:
            return

        execution = self.executor.submit_order(
            session,
            self.alpaca_client,
            decision,
            decision_row,
            self.account_label,
        )
        if execution:
            self.state.metrics.orders_submitted_total += 1
            logger.info(
                "Order submitted strategy_id=%s decision_id=%s symbol=%s alpaca_order_id=%s",
                decision.strategy_id,
                decision_row.id,
                decision.symbol,
                execution.alpaca_order_id,
            )

    @staticmethod
    def _load_strategies(session: Session) -> list[Strategy]:
        stmt = select(Strategy).where(Strategy.enabled.is_(True))
        return list(session.execute(stmt).scalars().all())

    def _apply_llm_review(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, str]],
    ) -> tuple[StrategyDecision, Optional[str]]:
        if not settings.llm_enabled:
            return decision, None

        engine = self.llm_review_engine or LLMReviewEngine()
        request_json: dict[str, Any] = {}
        try:
            request = engine.build_request(decision, account, positions)
            request_json = request.model_dump(mode="json")
            outcome = engine.review(decision, account, positions)
            policy_outcome = apply_policy(decision, outcome.response)

            response_json = dict(outcome.response_json)
            if policy_outcome.reason:
                response_json["policy_override"] = policy_outcome.reason
                response_json["policy_verdict"] = policy_outcome.verdict

            adjusted_qty = None
            adjusted_order_type = None
            if policy_outcome.verdict == "adjust":
                adjusted_qty = Decimal(str(policy_outcome.decision.qty))
                adjusted_order_type = policy_outcome.decision.order_type

            self._persist_llm_review(
                session=session,
                decision_row=decision_row,
                model=outcome.model,
                prompt_version=outcome.prompt_version,
                request_json=outcome.request_json,
                response_json=response_json,
                verdict=policy_outcome.verdict,
                confidence=outcome.response.confidence,
                adjusted_qty=adjusted_qty,
                adjusted_order_type=adjusted_order_type,
                rationale=outcome.response.rationale,
                risk_flags=outcome.response.risk_flags,
                tokens_prompt=outcome.tokens_prompt,
                tokens_completion=outcome.tokens_completion,
            )

            if policy_outcome.verdict == "veto":
                return decision, policy_outcome.reason or "llm_veto"

            return policy_outcome.decision, None
        except Exception as exc:
            fallback = self._resolve_llm_fallback()
            verdict = "veto" if fallback == "veto" else "approve"
            response_json = {
                "error": str(exc),
                "fallback": fallback,
            }
            if not request_json:
                request_json = {"decision": decision.model_dump(mode="json")}
            self._persist_llm_review(
                session=session,
                decision_row=decision_row,
                model=settings.llm_model,
                prompt_version=settings.llm_prompt_version,
                request_json=request_json,
                response_json=response_json,
                verdict=verdict,
                confidence=None,
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale=f"llm_error_{fallback}",
                risk_flags=[type(exc).__name__],
                tokens_prompt=None,
                tokens_completion=None,
            )
            if fallback == "veto":
                logger.warning("LLM review failed; vetoing decision_id=%s error=%s", decision_row.id, exc)
                return decision, "llm_error"
            logger.warning("LLM review failed; pass-through decision_id=%s error=%s", decision_row.id, exc)
            return decision, None

    @staticmethod
    def _resolve_llm_fallback() -> str:
        if settings.trading_mode == "live":
            return "veto"
        return settings.llm_fail_mode

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
        review = LLMDecisionReview(
            trade_decision_id=decision_row.id,
            model=model,
            prompt_version=prompt_version,
            input_json=request_json,
            response_json=response_json,
            verdict=verdict,
            confidence=Decimal(str(confidence)) if confidence is not None else None,
            adjusted_qty=adjusted_qty,
            adjusted_order_type=adjusted_order_type,
            rationale=rationale,
            risk_flags=risk_flags,
            tokens_prompt=tokens_prompt,
            tokens_completion=tokens_completion,
        )
        session.add(review)
        session.commit()


def _coerce_strategy_symbols(raw: object) -> set[str]:
    if raw is None:
        return set()
    if isinstance(raw, list):
        symbols: set[str] = set()
        for symbol in cast(list[Any], raw):
            cleaned = str(symbol).strip()
            if cleaned:
                symbols.add(cleaned)
        return symbols
    if isinstance(raw, str):
        return {symbol.strip() for symbol in raw.split(",") if symbol.strip()}
    return set()


class TradingScheduler:
    """Async background scheduler for trading pipeline."""

    def __init__(self) -> None:
        self.state = TradingState()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._pipeline = TradingPipeline(
            alpaca_client=TorghutAlpacaClient(),
            ingestor=ClickHouseSignalIngestor(),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=self.state,
            account_label=settings.trading_account_label,
        )

    async def start(self) -> None:
        if self._task:
            return
        self._stop_event.clear()
        self.state.running = True
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if not self._task:
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self.state.running = False

    async def _run_loop(self) -> None:
        poll_interval = settings.trading_poll_ms / 1000
        reconcile_interval = settings.trading_reconcile_ms / 1000
        last_reconcile = datetime.now(timezone.utc)

        while not self._stop_event.is_set():
            try:
                self._pipeline.run_once()
                self.state.last_run_at = datetime.now(timezone.utc)
            except Exception as exc:  # pragma: no cover - loop guard
                logger.exception("Trading loop failed: %s", exc)
                self.state.last_error = str(exc)

            now = datetime.now(timezone.utc)
            if now - last_reconcile >= timedelta(seconds=reconcile_interval):
                try:
                    updates = self._pipeline.reconcile()
                    if updates:
                        logger.info("Reconciled %s executions", updates)
                    self.state.last_reconcile_at = datetime.now(timezone.utc)
                except Exception as exc:  # pragma: no cover - loop guard
                    logger.exception("Reconcile loop failed: %s", exc)
                    self.state.last_error = str(exc)
                last_reconcile = now

            await asyncio.sleep(poll_interval)


__all__ = ["TradingScheduler", "TradingState", "TradingMetrics"]
