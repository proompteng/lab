"""Per-signal entry processing for the Hyperliquid execution loop."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Protocol, cast

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    fingerprint_broker_endpoint,
)
from ..trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionAlreadyProcessed,
    BrokerMutationSubmissionDeferred,
    BrokerMutationSubmitCoordinator,
    UnlinkedOrderSubmissionCallbacks,
)

from .config import HyperliquidExecutionConfig
from .exchange import (
    HyperliquidExecutionExchange,
    hyperliquid_submit_request_payload,
)
from .models import (
    FeatureSnapshot,
    OrderIntent,
    OrderResult,
    RiskState,
    RiskVerdict,
    Signal,
)
from .order_policy import build_order_intent
from .profitability import (
    ProfitabilityGateResult,
    evaluate_profitability_gate,
    profitability_blocked_verdict,
)
from .repository import HyperliquidExecutionRepository
from .risk import evaluate_signal_risk
from .strategy import generate_signal


class FeatureProcessingContext(Protocol):
    @property
    def cycle_id(self) -> str: ...

    @property
    def started_at(self) -> datetime: ...

    @property
    def features(self) -> tuple[FeatureSnapshot, ...]: ...

    @property
    def risk_state(self) -> RiskState: ...


class CycleCountsWriter(Protocol):
    signals_written: int
    orders_submitted: int

    def record_risk_block(self, coin: str, reason: str) -> None: ...

    def record_order_error(self, error_type: str) -> None: ...

    def record_position_reduce_only(self, action: dict[str, object]) -> None: ...

    def record_profitability_gate(
        self,
        coin: str,
        gate: dict[str, object],
    ) -> None: ...


_POSITION_CHECK_ERRORS = (
    LookupError,
    OSError,
    RuntimeError,
    SQLAlchemyError,
    TypeError,
    ValueError,
)
_ORDER_SUBMISSION_ERRORS = (
    LookupError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
)


@dataclass(frozen=True)
class _EntryRuntime:
    repository: HyperliquidExecutionRepository
    config: HyperliquidExecutionConfig
    exchange: HyperliquidExecutionExchange
    context: FeatureProcessingContext
    counts: CycleCountsWriter
    submit_coordinator: BrokerMutationSubmitCoordinator


def process_features(
    *,
    repository: HyperliquidExecutionRepository,
    config: HyperliquidExecutionConfig,
    exchange: HyperliquidExecutionExchange,
    context: FeatureProcessingContext,
    counts: CycleCountsWriter,
    submit_coordinator: BrokerMutationSubmitCoordinator,
) -> None:
    runtime = _EntryRuntime(
        repository,
        config,
        exchange,
        context,
        counts,
        submit_coordinator,
    )
    for feature in context.features:
        submitted = _process_feature(runtime, feature)
        if submitted:
            break


def _process_feature(runtime: _EntryRuntime, feature: FeatureSnapshot) -> bool:
    signal = generate_signal(
        feature,
        runtime.config,
        now=runtime.context.started_at,
        run_id=runtime.context.cycle_id,
    )
    signal_id = runtime.repository.insert_signal(
        cycle_id=runtime.context.cycle_id,
        signal=signal,
    )
    runtime.counts.signals_written += 1
    verdict = evaluate_signal_risk(
        signal,
        runtime.context.risk_state,
        runtime.config,
    )
    if not verdict.allowed:
        _record_blocked_verdict(runtime, signal, verdict)
        return False
    return _process_allowed_signal(runtime, signal, signal_id, verdict)


def _process_allowed_signal(
    runtime: _EntryRuntime,
    signal: Signal,
    signal_id: str,
    verdict: RiskVerdict,
) -> bool:
    gate = _evaluate_profitability(runtime, signal, verdict)
    if not gate.allowed:
        blocked = profitability_blocked_verdict(verdict, gate.reason)
        _record_blocked_verdict(runtime, signal, blocked)
        return False
    reduce_only = _position_reduce_only_action(runtime, signal)
    if reduce_only is not None:
        runtime.counts.record_position_reduce_only(reduce_only)
        blocked = profitability_blocked_verdict(verdict, str(reduce_only["reason"]))
        _record_blocked_verdict(runtime, signal, blocked)
        return _reduce_only_consumed_order_slot(reduce_only)
    runtime.repository.insert_multifactor_risk_and_target(
        run_id=runtime.context.cycle_id,
        verdict=verdict,
    )
    return _submit_order(runtime, signal, signal_id, verdict)


def _position_reduce_only_action(
    runtime: _EntryRuntime,
    signal: Signal,
) -> dict[str, object] | None:
    try:
        return _close_opposite_position_before_entry(
            runtime.repository,
            runtime.exchange,
            signal,
        )
    except _POSITION_CHECK_ERRORS as exc:
        runtime.counts.record_order_error(type(exc).__name__)
        return {
            "reason": "reduce_only_position_check_failed",
            "status": "rejected",
            "error_type": type(exc).__name__,
        }


def _evaluate_profitability(
    runtime: _EntryRuntime,
    signal: Signal,
    verdict: RiskVerdict,
) -> ProfitabilityGateResult:
    state = runtime.repository.symbol_profitability_state(
        coin=signal.coin,
        now=runtime.context.started_at,
        account_value_usd=runtime.context.risk_state.account_value_usd,
    )
    gate = evaluate_profitability_gate(
        signal=signal,
        verdict=verdict,
        state=state,
        config=runtime.config,
        now=runtime.context.started_at,
    )
    runtime.counts.record_profitability_gate(signal.coin, gate.to_details())
    return gate


def _submit_order(
    runtime: _EntryRuntime,
    signal: Signal,
    signal_id: str,
    verdict: RiskVerdict,
) -> bool:
    try:
        intent = build_order_intent(
            signal=signal,
            verdict=verdict,
            config=runtime.config,
            signal_id=signal_id,
            now=runtime.context.started_at,
        )
        intent = _normalize_order_intent(runtime.exchange, intent)
        _validate_order_intent_crossability(runtime.exchange, intent)
        mutation_intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="hyperliquid",
                account_label=runtime.config.account_label,
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    runtime.config.exchange_api_url
                ),
                operation="submit_order",
                risk_class="risk_increasing",
                purpose="initial_submission",
                workflow_id=f"hyperliquid-submit/{intent.cloid}",
                client_request_id=intent.cloid,
                target=BrokerMutationTarget(kind="order", key=intent.cloid),
                request_payload=hyperliquid_submit_request_payload(intent),
            )
        )
        runtime.submit_coordinator.submit_unlinked_order(
            cast(Session, runtime.repository.session),
            intent=mutation_intent,
            callbacks=UnlinkedOrderSubmissionCallbacks(
                broker_call=lambda permit: runtime.exchange.submit_order(
                    intent,
                    mutation_permit=permit,
                ),
                persist_terminal=lambda terminal: _persist_hyperliquid_terminal(
                    runtime,
                    intent,
                    terminal,
                    verdict,
                ),
                build_settlement=lambda terminal: _hyperliquid_settlement(
                    intent,
                    terminal,
                ),
            ),
        )
    except BrokerMutationSubmissionAlreadyProcessed:
        return False
    except BrokerMutationSubmissionDeferred as exc:
        runtime.counts.record_order_error(type(exc).__name__)
        raise
    except _ORDER_SUBMISSION_ERRORS as exc:
        runtime.counts.record_order_error(type(exc).__name__)
        return False
    runtime.counts.orders_submitted += 1
    return True


def _persist_hyperliquid_terminal(
    runtime: _EntryRuntime,
    intent: OrderIntent,
    result: OrderResult,
    verdict: RiskVerdict,
) -> None:
    runtime.repository.insert_order(intent, result)
    runtime.repository.insert_multifactor_execution_intent(
        run_id=runtime.context.cycle_id,
        intent=intent,
        result=result,
        verdict=verdict,
    )
    runtime.repository.update_reject_cooldown(
        coin=intent.coin,
        rejection_reason=result.rejection_reason,
        config=runtime.config,
    )


def _hyperliquid_settlement(
    intent: OrderIntent,
    result: OrderResult,
) -> BrokerMutationSettlement:
    rejected = result.status.strip().lower() == "rejected"
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="rejected" if rejected else "acknowledged",
            broker_reference=result.exchange_order_id,
            execution_id=None,
            evidence_payload={
                "route": "hyperliquid",
                "client_order_id": intent.cloid,
                "market_id": intent.market_id,
                "status": result.status,
                "rejection_reason": result.rejection_reason,
            },
        )
    )


def _normalize_order_intent(
    exchange: HyperliquidExecutionExchange,
    intent: OrderIntent,
) -> OrderIntent:
    normalize = getattr(exchange, "normalize_order_intent", None)
    if not callable(normalize):
        return intent
    return cast(Callable[[OrderIntent], OrderIntent], normalize)(intent)


def _validate_order_intent_crossability(
    exchange: HyperliquidExecutionExchange,
    intent: OrderIntent,
) -> None:
    validate = getattr(exchange, "validate_order_intent_crossability", None)
    if callable(validate):
        cast(Callable[[OrderIntent], None], validate)(intent)


def _reduce_only_consumed_order_slot(action: dict[str, object]) -> bool:
    submitted_statuses = {"accepted", "filled", "submitted"}
    return str(action.get("status") or "").lower() in submitted_statuses


def _close_opposite_position_before_entry(
    repository: HyperliquidExecutionRepository,
    exchange: HyperliquidExecutionExchange,
    signal: Signal,
) -> dict[str, object] | None:
    if signal.action not in {"buy", "sell"}:
        return None
    position = repository.position_for_coin(signal.coin)
    if position is None or position.size == Decimal("0"):
        return None
    opposite_position = (
        signal.action == "buy"
        and position.size < Decimal("0")
        or signal.action == "sell"
        and position.size > Decimal("0")
    )
    if not opposite_position:
        return None
    close_coin = position.sdk_coin or signal.coin
    result = exchange.close_position_reduce_only(close_coin, size=abs(position.size))
    return {
        "schema_version": "torghut.hyperliquid-position-aware-reduce-only.v1",
        "coin": signal.coin,
        "sdk_coin": close_coin,
        "reason": "reduce_only_close_before_opposite_entry",
        "signal_action": signal.action,
        "previous_position_size": str(position.size),
        "size": str(abs(position.size)),
        "status": result.status,
        "exchange_order_id": result.exchange_order_id,
        "rejection_reason": result.rejection_reason,
    }


def _record_blocked_verdict(
    runtime: _EntryRuntime,
    signal: Signal,
    verdict: RiskVerdict,
) -> None:
    runtime.repository.insert_multifactor_risk_and_target(
        run_id=runtime.context.cycle_id,
        verdict=verdict,
    )
    runtime.counts.record_risk_block(signal.coin, verdict.reason)
