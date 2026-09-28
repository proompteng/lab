"""Strategy capital authority boundary for broker submissions."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from ....config import settings
from ...models import StrategyDecision
from ...strategy_capital_authority import StrategyCapitalVerdict
from ...strategy_capital_runtime import (
    RuntimeStrategyCapitalRequest,
    evaluate_runtime_strategy_capital_authority,
    hold_runtime_strategy_capital_authority_for_submission,
)

from .contexts import DecisionBlockRequest, DecisionSubmissionContext
from .shared import TradingPipelineRuntime
from .support import is_runtime_risk_increasing_entry, optional_decimal

logger = logging.getLogger(__name__)


def decision_execution_notional(decision: StrategyDecision) -> Decimal:
    """Resolve the notional that will cross the execution boundary."""

    price = (
        decision.limit_price
        or decision.stop_price
        or optional_decimal(decision.params.get("price"))
    )
    if price is not None and price > 0 and decision.qty > 0:
        return decision.qty * price
    portfolio_sizing = decision.params.get("portfolio_sizing")
    if isinstance(portfolio_sizing, Mapping):
        output = cast(Mapping[str, object], portfolio_sizing).get("output")
        if isinstance(output, Mapping):
            final_notional = optional_decimal(
                cast(Mapping[str, object], output).get("final_notional")
            )
            if final_notional is not None and final_notional > 0:
                return final_notional
    for key in (
        "notional",
        "notional_usd",
        "target_notional",
        "target_notional_usd",
        "final_notional",
    ):
        value = optional_decimal(decision.params.get(key))
        if value is not None and value > 0:
            return value
    return Decimal("0")


def _current_capital_loss(state: object) -> Decimal | None:
    daily_start = optional_decimal(getattr(state, "capital_daily_start_equity", None))
    high_water = optional_decimal(getattr(state, "capital_high_water_equity", None))
    current = optional_decimal(getattr(state, "capital_current_equity", None))
    baselines = [
        value for value in (daily_start, high_water) if value is not None and value > 0
    ]
    if not baselines or current is None or current < 0:
        return None
    return max(max(baselines) - current, Decimal("0"))


class TradingPipelineStrategyCapitalAuthorityMixin(TradingPipelineRuntime):
    def _persist_strategy_capital_authority_verdict(
        self,
        context: DecisionSubmissionContext,
        verdict: StrategyCapitalVerdict,
    ) -> dict[str, object]:
        payload = verdict.to_payload()
        decision_row = context.decision_row
        decision_row.strategy_capital_authority_id = verdict.authority_id
        decision_row.strategy_capital_authority_digest = verdict.authority_digest
        decision_row.strategy_capital_authority_evaluated_at = verdict.evaluated_at
        decision_row.strategy_capital_authority_allowed = verdict.allowed
        self.executor.update_decision_params(
            context.session,
            decision_row,
            {"strategy_capital_authority": payload},
        )
        return payload

    def _strategy_capital_authority_allows_submission(
        self,
        context: DecisionSubmissionContext,
        decision: StrategyDecision,
        adapter_name: str,
    ) -> bool:
        if adapter_name == "simulation" or not is_runtime_risk_increasing_entry(
            decision, context.positions
        ):
            return True
        verdict = evaluate_runtime_strategy_capital_authority(
            context.session,
            strategy=context.strategy,
            request=RuntimeStrategyCapitalRequest(
                decision_id=context.decision_row.id,
                account_label=context.decision_row.alpaca_account_label,
                account_mode=settings.trading_mode,
                adapter_name=adapter_name,
                symbol=decision.symbol,
                side=decision.action,
                order_notional=decision_execution_notional(decision),
                positions=context.positions,
                capital_loss=_current_capital_loss(self.state),
                observed_at=datetime.now(timezone.utc),
            ),
        )
        if verdict.allowed:
            verdict = hold_runtime_strategy_capital_authority_for_submission(
                context.session,
                strategy=context.strategy,
                verdict=verdict,
                observed_at=datetime.now(timezone.utc),
            )
        authority_payload = self._persist_strategy_capital_authority_verdict(
            context,
            verdict,
        )
        if verdict.allowed:
            return True
        primary_reason = (
            verdict.reason_codes[0]
            if verdict.reason_codes
            else "strategy_capital_authority_denied"
        )
        self._block_decision_submission(
            DecisionBlockRequest(
                session=context.session,
                decision=decision,
                decision_row=context.decision_row,
                reason=primary_reason,
                submission_stage="blocked_strategy_capital_authority",
                capital_stage=verdict.stage.value,
                extra_metadata={"strategy_capital_authority": authority_payload},
            )
        )
        logger.warning(
            "Decision blocked by strategy capital authority "
            "strategy_ref=%s strategy_id=%s decision_id=%s symbol=%s reasons=%s",
            context.strategy.name,
            decision.strategy_id,
            context.decision_row.id,
            decision.symbol,
            verdict.reason_codes,
        )
        return False


__all__ = (
    "TradingPipelineStrategyCapitalAuthorityMixin",
    "decision_execution_notional",
)
