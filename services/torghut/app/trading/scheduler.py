"""Background scheduler for the trading pipeline."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from ..db import SessionLocal
from ..models import LLMDecisionReview, Strategy, TradeDecision, coerce_json_payload
from ..snapshots import snapshot_account_and_positions
from ..strategies import StrategyCatalog
from .decisions import DecisionEngine
from .execution import OrderExecutor
from .execution_policy import ExecutionPolicy
from .firewall import OrderFirewall, OrderFirewallBlocked
from .ingest import ClickHouseSignalIngestor
from .llm import LLMReviewEngine, apply_policy
from .models import SignalEnvelope, StrategyDecision
from .portfolio import PortfolioSizingResult, sizer_from_settings
from .prices import ClickHousePriceFetcher, MarketSnapshot, PriceFetcher
from .reconcile import Reconciler
from .risk import RiskEngine
from .universe import UniverseResolver
from .llm.schema import MarketSnapshot as LLMMarketSnapshot
from .llm.schema import PortfolioSnapshot, RecentDecisionSummary

logger = logging.getLogger(__name__)


def _extract_json_error_payload(error: Exception) -> Optional[dict[str, Any]]:
    raw = str(error).strip()
    if not raw.startswith('{'):
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return cast(dict[str, Any], parsed)
    return None


def _format_order_submit_rejection(error: Exception) -> str:
    payload = _extract_json_error_payload(error)
    if payload:
        code = payload.get('code')
        reject_reason = payload.get('reject_reason')
        existing_order_id = payload.get('existing_order_id')
        parts: list[str] = ['alpaca_order_rejected']
        if code is not None:
            parts.append(f'code={code}')
        if reject_reason:
            parts.append(f'reason={reject_reason}')
        if existing_order_id:
            parts.append(f'existing_order_id={existing_order_id}')
        return ' '.join(parts)
    return f'alpaca_order_submit_failed {type(error).__name__}: {error}'


@dataclass
class TradingMetrics:
    decisions_total: int = 0
    orders_submitted_total: int = 0
    orders_rejected_total: int = 0
    reconcile_updates_total: int = 0
    llm_requests_total: int = 0
    llm_approve_total: int = 0
    llm_veto_total: int = 0
    llm_adjust_total: int = 0
    llm_error_total: int = 0
    llm_parse_error_total: int = 0
    llm_validation_error_total: int = 0
    llm_circuit_open_total: int = 0
    llm_shadow_total: int = 0
    llm_tokens_prompt_total: int = 0
    llm_tokens_completion_total: int = 0


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
        order_firewall: OrderFirewall,
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
        price_fetcher: Optional[PriceFetcher] = None,
        strategy_catalog: StrategyCatalog | None = None,
        execution_policy: Optional[ExecutionPolicy] = None,
    ) -> None:
        self.alpaca_client = alpaca_client
        self.order_firewall = order_firewall
        self.ingestor = ingestor
        self.decision_engine = decision_engine
        self.risk_engine = risk_engine
        self.executor = executor
        self.reconciler = reconciler
        self.universe_resolver = universe_resolver
        self.state = state
        self.account_label = account_label
        self.session_factory = session_factory
        self.price_fetcher = price_fetcher or ClickHousePriceFetcher()
        self._snapshot_cache = None
        self._snapshot_cached_at: Optional[datetime] = None
        self.strategy_catalog = strategy_catalog
        self.execution_policy = execution_policy or ExecutionPolicy()
        if llm_review_engine is not None:
            self.llm_review_engine = llm_review_engine
        elif settings.llm_enabled:
            self.llm_review_engine = LLMReviewEngine()
        else:
            self.llm_review_engine = None

    def run_once(self) -> None:
        with self.session_factory() as session:
            self.order_firewall.cancel_open_orders_if_kill_switch()
            if self.strategy_catalog is not None:
                self.strategy_catalog.refresh(session)
            strategies = self._load_strategies(session)
            if not strategies:
                logger.info("No enabled strategies found; skipping trading cycle")
                return

            batch = self.ingestor.fetch_signals(session)
            if not batch.signals:
                return

            account_snapshot = self._get_account_snapshot(session)
            account = {
                "equity": str(account_snapshot.equity),
                "cash": str(account_snapshot.cash),
                "buying_power": str(account_snapshot.buying_power),
            }
            positions = account_snapshot.positions

            allowed_symbols = self.universe_resolver.get_symbols()

            for signal in batch.signals:
                try:
                    decisions = self.decision_engine.evaluate(signal, strategies, equity=account_snapshot.equity)
                except Exception:
                    logger.exception("Decision evaluation failed symbol=%s timeframe=%s", signal.symbol, signal.timeframe)
                    continue

                if not decisions:
                    continue

                for decision in decisions:
                    self.state.metrics.decisions_total += 1
                    try:
                        self._handle_decision(session, decision, strategies, account, positions, allowed_symbols)
                    except Exception:
                        # Keep the loop alive and commit the cursor so we don't reprocess the same signals forever.
                        logger.exception(
                            "Decision handling failed strategy_id=%s symbol=%s timeframe=%s",
                            decision.strategy_id,
                            decision.symbol,
                            decision.timeframe,
                        )
                        self.state.metrics.orders_rejected_total += 1

            self.ingestor.commit_cursor(session, batch)

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
        positions: list[dict[str, Any]],
        allowed_symbols: set[str],
    ) -> None:
        decision_row: Optional[TradeDecision] = None
        try:
            strategy = next((s for s in strategies if str(s.id) == decision.strategy_id), None)
            if strategy is None:
                return

            strategy_symbols = _coerce_strategy_symbols(strategy.universe_symbols)
            if strategy_symbols:
                if allowed_symbols:
                    symbol_allowlist = strategy_symbols & allowed_symbols
                else:
                    symbol_allowlist = strategy_symbols
            else:
                symbol_allowlist = allowed_symbols

            decision_row = self.executor.ensure_decision(session, decision, strategy, self.account_label)
            if decision_row.status != "planned":
                return
            if self.executor.execution_exists(session, decision_row):
                return

            decision, snapshot = self._ensure_decision_price(decision, signal_price=decision.params.get("price"))
            if snapshot is not None:
                params_update = decision.model_dump(mode="json").get("params", {})
                if isinstance(params_update, Mapping):
                    self.executor.update_decision_params(session, decision_row, cast(Mapping[str, Any], params_update))

            sizing_result = self._apply_portfolio_sizing(decision, strategy, account, positions)
            decision = sizing_result.decision
            sizing_params = decision.model_dump(mode="json").get("params", {})
            if isinstance(sizing_params, Mapping) and "portfolio_sizing" in sizing_params:
                self.executor.update_decision_params(session, decision_row, cast(Mapping[str, Any], sizing_params))
            if not sizing_result.approved:
                self.state.metrics.orders_rejected_total += 1
                for reason in sizing_result.reasons:
                    logger.info(
                        "Decision rejected by portfolio sizing strategy_id=%s symbol=%s reason=%s",
                        decision.strategy_id,
                        decision.symbol,
                        reason,
                    )
                self.executor.mark_rejected(session, decision_row, ";".join(sizing_result.reasons))
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

            policy_outcome = self.execution_policy.evaluate(
                decision,
                strategy=strategy,
                positions=positions,
                market_snapshot=snapshot,
                kill_switch_enabled=self.order_firewall.status().kill_switch_enabled,
            )
            decision = policy_outcome.decision
            self.executor.update_decision_params(session, decision_row, policy_outcome.params_update())
            if not policy_outcome.approved:
                self.state.metrics.orders_rejected_total += 1
                for reason in policy_outcome.reasons:
                    logger.info(
                        "Decision rejected by execution policy strategy_id=%s symbol=%s reason=%s",
                        decision.strategy_id,
                        decision.symbol,
                        reason,
                    )
                self.executor.mark_rejected(session, decision_row, ";".join(policy_outcome.reasons))
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

            try:
                execution = self.executor.submit_order(
                    session,
                    self.order_firewall,
                    decision,
                    decision_row,
                    self.account_label,
                    retry_delays=policy_outcome.retry_delays,
                )
            except OrderFirewallBlocked as exc:
                self.state.metrics.orders_rejected_total += 1
                self.executor.mark_rejected(session, decision_row, str(exc))
                logger.warning(
                    "Order blocked by firewall strategy_id=%s decision_id=%s symbol=%s reason=%s",
                    decision.strategy_id,
                    decision_row.id,
                    decision.symbol,
                    exc,
                )
                return
            except Exception as exc:
                self.state.metrics.orders_rejected_total += 1
                payload = _extract_json_error_payload(exc) or {}
                existing_order_id = payload.get("existing_order_id")
                if existing_order_id:
                    try:
                        self.order_firewall.cancel_order(str(existing_order_id))
                        logger.info(
                            "Canceled conflicting Alpaca order decision_id=%s existing_order_id=%s",
                            decision_row.id,
                            existing_order_id,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to cancel conflicting Alpaca order decision_id=%s existing_order_id=%s",
                            decision_row.id,
                            existing_order_id,
                        )
                reason = _format_order_submit_rejection(exc)
                self.executor.mark_rejected(session, decision_row, reason)
                logger.warning(
                    "Order submission failed strategy_id=%s decision_id=%s symbol=%s error=%s",
                    decision.strategy_id,
                    decision_row.id,
                    decision.symbol,
                    exc,
                )
                return

            if execution:
                self.state.metrics.orders_submitted_total += 1
                logger.info(
                    "Order submitted strategy_id=%s decision_id=%s symbol=%s alpaca_order_id=%s",
                    decision.strategy_id,
                    decision_row.id,
                    decision.symbol,
                    execution.alpaca_order_id,
                )
        except Exception as exc:
            logger.exception(
                "Decision handling failed strategy_id=%s symbol=%s error=%s",
                decision.strategy_id,
                decision.symbol,
                exc,
            )
            if decision_row is not None and decision_row.status == "planned":
                self.state.metrics.orders_rejected_total += 1
                self.executor.mark_rejected(session, decision_row, f"decision_handler_error {type(exc).__name__}")
            return

    def _apply_portfolio_sizing(
        self,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: list[dict[str, Any]],
    ) -> PortfolioSizingResult:
        equity = _optional_decimal(account.get("equity"))
        sizer = sizer_from_settings(strategy, equity)
        return sizer.size(decision, account=account, positions=positions)

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
        positions: list[dict[str, Any]],
    ) -> tuple[StrategyDecision, Optional[str]]:
        if not settings.llm_enabled:
            return decision, None

        engine = self.llm_review_engine or LLMReviewEngine()
        if engine.circuit_breaker.is_open():
            self.state.metrics.llm_circuit_open_total += 1
            return self._handle_llm_unavailable(
                session,
                decision,
                decision_row,
                account,
                positions,
                reason="llm_circuit_open",
            )
        request_json: dict[str, Any] = {}
        try:
            self.state.metrics.llm_requests_total += 1
            portfolio_snapshot = _build_portfolio_snapshot(account, positions)
            market_snapshot = self._build_market_snapshot(decision)
            recent_decisions = _load_recent_decisions(
                session,
                decision.strategy_id,
                decision.symbol,
            )
            request = engine.build_request(
                decision,
                account,
                positions,
                portfolio_snapshot,
                market_snapshot,
                recent_decisions,
            )
            request_json = request.model_dump(mode="json")
            outcome = engine.review(
                decision,
                account,
                positions,
                request=request,
                portfolio=portfolio_snapshot,
                market=market_snapshot,
                recent_decisions=recent_decisions,
            )
            policy_outcome = apply_policy(decision, outcome.response)

            response_json = dict(outcome.response_json)
            if policy_outcome.reason:
                response_json["policy_override"] = policy_outcome.reason
                response_json["policy_verdict"] = policy_outcome.verdict

            adjusted_qty = None
            adjusted_order_type = None
            if policy_outcome.verdict == "adjust":
                self.state.metrics.llm_adjust_total += 1
                adjusted_qty = Decimal(str(policy_outcome.decision.qty))
                adjusted_order_type = policy_outcome.decision.order_type
                self._persist_llm_adjusted_decision(session, decision_row, policy_outcome.decision)
            elif policy_outcome.verdict == "approve":
                self.state.metrics.llm_approve_total += 1
            elif policy_outcome.verdict == "veto":
                self.state.metrics.llm_veto_total += 1

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

            engine.circuit_breaker.record_success()
            if outcome.tokens_prompt is not None:
                self.state.metrics.llm_tokens_prompt_total += outcome.tokens_prompt
            if outcome.tokens_completion is not None:
                self.state.metrics.llm_tokens_completion_total += outcome.tokens_completion
            if settings.llm_shadow_mode:
                self.state.metrics.llm_shadow_total += 1
                return decision, None
            if policy_outcome.verdict == "veto":
                return decision, policy_outcome.reason or "llm_veto"

            return policy_outcome.decision, None
        except Exception as exc:
            engine.circuit_breaker.record_error()
            self.state.metrics.llm_error_total += 1
            error_code = str(exc)
            if error_code == "llm_response_not_json":
                self.state.metrics.llm_parse_error_total += 1
            elif error_code == "llm_response_invalid":
                self.state.metrics.llm_validation_error_total += 1
            fallback = self._resolve_llm_fallback()
            effective_verdict = "veto" if fallback == "veto" else "approve"
            response_json = {
                "error": str(exc),
                "fallback": fallback,
                "effective_verdict": effective_verdict,
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
                verdict="error",
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

    def _handle_llm_unavailable(
        self,
        session: Session,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account: dict[str, str],
        positions: list[dict[str, Any]],
        reason: str,
    ) -> tuple[StrategyDecision, Optional[str]]:
        fallback = self._resolve_llm_fallback()
        effective_verdict = "veto" if fallback == "veto" else "approve"
        portfolio_snapshot = _build_portfolio_snapshot(account, positions)
        market_snapshot = self._build_market_snapshot(decision)
        recent_decisions = _load_recent_decisions(
            session,
            decision.strategy_id,
            decision.symbol,
        )
        request_payload = {
            "decision": decision.model_dump(mode="json"),
            "portfolio": portfolio_snapshot.model_dump(mode="json"),
            "market": market_snapshot.model_dump(mode="json") if market_snapshot else None,
            "recent_decisions": [item.model_dump(mode="json") for item in recent_decisions],
            "reason": reason,
        }
        self._persist_llm_review(
            session=session,
            decision_row=decision_row,
            model=settings.llm_model,
            prompt_version=settings.llm_prompt_version,
            request_json=request_payload,
            response_json={"error": reason, "fallback": fallback, "effective_verdict": effective_verdict},
            verdict="error",
            confidence=None,
            adjusted_qty=None,
            adjusted_order_type=None,
            rationale=reason,
            risk_flags=[reason],
            tokens_prompt=None,
            tokens_completion=None,
        )
        if settings.llm_shadow_mode:
            self.state.metrics.llm_shadow_total += 1
            return decision, None
        if fallback == "veto":
            return decision, "llm_error"
        return decision, None

    def _build_market_snapshot(self, decision: StrategyDecision) -> Optional[LLMMarketSnapshot]:
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
    def _resolve_llm_fallback() -> str:
        if settings.trading_mode == "live":
            return "veto"
        return settings.llm_fail_mode

    def _get_account_snapshot(self, session: Session):
        now = datetime.now(timezone.utc)
        snapshot_ttl = timedelta(milliseconds=settings.trading_reconcile_ms)
        if self._snapshot_cache and self._snapshot_cached_at:
            if now - self._snapshot_cached_at < snapshot_ttl:
                return self._snapshot_cache
        # Reuse snapshots within the reconcile interval to reduce Alpaca and DB churn.
        snapshot = snapshot_account_and_positions(session, self.alpaca_client, self.account_label)
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
        response_payload = coerce_json_payload(response_json)
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
        decision_json["llm_adjusted_decision"] = coerce_json_payload(decision.model_dump(mode="json"))
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()


def _coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def _price_snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


def _build_portfolio_snapshot(account: dict[str, str], positions: list[dict[str, Any]]) -> PortfolioSnapshot:
    equity = _optional_decimal(account.get("equity"))
    cash = _optional_decimal(account.get("cash"))
    buying_power = _optional_decimal(account.get("buying_power"))
    exposure_by_symbol: dict[str, Decimal] = {}
    total_exposure = Decimal("0")
    for position in positions:
        symbol = position.get("symbol")
        if not symbol:
            continue
        market_value = _optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        exposure_by_symbol[symbol] = exposure_by_symbol.get(symbol, Decimal("0")) + market_value
        total_exposure += abs(market_value)
    return PortfolioSnapshot(
        equity=equity,
        cash=cash,
        buying_power=buying_power,
        total_exposure=total_exposure,
        exposure_by_symbol=exposure_by_symbol,
        positions=positions,
    )


def _load_recent_decisions(
    session: Session, strategy_id: str, symbol: str
) -> list[RecentDecisionSummary]:
    if settings.llm_recent_decisions <= 0:
        return []
    stmt = (
        select(TradeDecision)
        .where(TradeDecision.strategy_id == strategy_id)
        .where(TradeDecision.symbol == symbol)
        .order_by(TradeDecision.created_at.desc())
        .limit(settings.llm_recent_decisions)
    )
    decisions = session.execute(stmt).scalars().all()
    summaries: list[RecentDecisionSummary] = []
    for decision in decisions:
        decision_json = _coerce_json(decision.decision_json)
        params_value: object = decision_json.get("params")
        params_map: Mapping[str, Any] = {}
        if isinstance(params_value, Mapping):
            params_map = cast(Mapping[str, Any], params_value)
        price = _optional_decimal(params_map.get("price"))
        if price is None and isinstance(params_map.get("price_snapshot"), Mapping):
            snapshot_map = cast(Mapping[str, Any], params_map.get("price_snapshot"))
            price = _optional_decimal(snapshot_map.get("price"))
        summaries.append(
            RecentDecisionSummary(
                decision_id=str(decision.id),
                strategy_id=str(decision.strategy_id),
                symbol=decision.symbol,
                action=decision_json.get("action", "buy"),
                qty=_optional_decimal(decision_json.get("qty")) or Decimal("0"),
                status=decision.status,
                created_at=decision.created_at,
                rationale=decision.rationale,
                price=price,
            )
        )
    return summaries


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


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


class TradingScheduler:
    """Async background scheduler for trading pipeline."""

    def __init__(self) -> None:
        self.state = TradingState()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._pipeline: Optional[TradingPipeline] = None

    def llm_status(self) -> dict[str, object]:
        circuit_snapshot = None
        if self._pipeline and self._pipeline.llm_review_engine:
            circuit_snapshot = self._pipeline.llm_review_engine.circuit_breaker.snapshot()
        return {
            "enabled": settings.llm_enabled,
            "shadow_mode": settings.llm_shadow_mode,
            "fail_mode": settings.llm_fail_mode,
            "circuit": circuit_snapshot,
        }

    def _build_pipeline(self) -> TradingPipeline:
        price_fetcher = ClickHousePriceFetcher()
        strategy_catalog = StrategyCatalog.from_settings()
        alpaca_client = TorghutAlpacaClient()
        order_firewall = OrderFirewall(alpaca_client)
        return TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=order_firewall,
            ingestor=ClickHouseSignalIngestor(),
            decision_engine=DecisionEngine(price_fetcher=price_fetcher),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=self.state,
            account_label=settings.trading_account_label,
            price_fetcher=price_fetcher,
            strategy_catalog=strategy_catalog,
        )

    async def start(self) -> None:
        if self._task:
            return
        if self._pipeline is None:
            self._pipeline = self._build_pipeline()
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
                if self._pipeline is None:
                    raise RuntimeError("trading_pipeline_not_initialized")
                await asyncio.to_thread(self._pipeline.run_once)
                self.state.last_run_at = datetime.now(timezone.utc)
                self.state.last_error = None
            except Exception as exc:  # pragma: no cover - loop guard
                logger.exception("Trading loop failed: %s", exc)
                self.state.last_error = str(exc)

            now = datetime.now(timezone.utc)
            if now - last_reconcile >= timedelta(seconds=reconcile_interval):
                try:
                    if self._pipeline is None:
                        raise RuntimeError("trading_pipeline_not_initialized")
                    updates = await asyncio.to_thread(self._pipeline.reconcile)
                    if updates:
                        logger.info("Reconciled %s executions", updates)
                    self.state.last_reconcile_at = datetime.now(timezone.utc)
                    self.state.last_error = None
                except Exception as exc:  # pragma: no cover - loop guard
                    logger.exception("Reconcile loop failed: %s", exc)
                    self.state.last_error = str(exc)
                last_reconcile = now

            await asyncio.sleep(poll_interval)


__all__ = ["TradingScheduler", "TradingState", "TradingMetrics"]
