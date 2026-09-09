"""Persistence of broker-observed linked submissions."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, cast

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ...models import Execution, TradeDecision
from ..decision_submission_claims.types import DecisionSubmissionClaimHandle
from ..models import StrategyDecision
from ..order_feed import link_order_events_to_execution
from .order_executor_core_support import (
    extract_execution_policy_context as _extract_execution_policy_context,
)


if TYPE_CHECKING:
    from .shared_context import (
        OrderExecutorContract as _LinkedSubmissionRecoveryBase,
    )
else:
    _LinkedSubmissionRecoveryBase = object


class _LinkedSubmissionRecoveryMethods(_LinkedSubmissionRecoveryBase):
    def recover_linked_order_submission(
        self,
        *,
        session: Session,
        execution_client: object,
        claim_handle: DecisionSubmissionClaimHandle,
        order_response: Mapping[str, object],
    ) -> Execution:
        """Persist a broker-observed order without issuing broker I/O or committing."""

        decision_row = _load_recovery_decision(session, claim_handle)
        broker_order_id = _broker_order_id(
            order_response,
            expected_client_order_id=claim_handle.client_order_id,
        )
        _lock_and_validate_existing_execution(
            session,
            claim_handle=claim_handle,
            decision_row=decision_row,
            broker_order_id=broker_order_id,
        )
        decision = _recovery_strategy_decision(decision_row)
        execution_policy_context = _extract_execution_policy_context(
            decision,
            decision_row=decision_row,
        )
        execution = self._sync_submitted_order_execution(
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            account_label=claim_handle.account_label,
            execution_expected_adapter="alpaca",
            execution_policy_context=execution_policy_context,
            order_response=order_response,
            commit=False,
        )

        link_order_events_to_execution(session, execution)
        return execution


def _load_recovery_decision(
    session: Session,
    claim_handle: DecisionSubmissionClaimHandle,
) -> TradeDecision:
    decision_row = session.execute(
        select(TradeDecision).where(
            TradeDecision.id == claim_handle.decision_id,
            TradeDecision.alpaca_account_label == claim_handle.account_label,
        )
    ).scalar_one_or_none()
    if decision_row is None:
        raise ValueError("linked_submission_recovery_decision_not_found")
    if str(decision_row.decision_hash or "").strip() != claim_handle.client_order_id:
        raise ValueError("linked_submission_recovery_client_order_id_mismatch")
    return decision_row


def _broker_order_id(
    order_response: Mapping[str, object],
    *,
    expected_client_order_id: str,
) -> str:
    broker_order_id = str(
        order_response.get("id") or order_response.get("order_id") or ""
    ).strip()
    client_order_id = str(order_response.get("client_order_id") or "").strip()
    if not broker_order_id:
        raise ValueError("linked_submission_recovery_broker_order_id_required")
    if not client_order_id or client_order_id != expected_client_order_id:
        raise ValueError("linked_submission_recovery_client_order_id_mismatch")
    return broker_order_id


def _lock_and_validate_existing_execution(
    session: Session,
    *,
    claim_handle: DecisionSubmissionClaimHandle,
    decision_row: TradeDecision,
    broker_order_id: str,
) -> None:
    existing_executions = (
        session.execute(
            select(Execution)
            .where(
                Execution.alpaca_account_label == claim_handle.account_label,
                or_(
                    Execution.alpaca_order_id == broker_order_id,
                    Execution.client_order_id == claim_handle.client_order_id,
                ),
            )
            .with_for_update()
        )
        .scalars()
        .all()
    )
    if len(existing_executions) > 1:
        raise ValueError("linked_submission_recovery_execution_identity_conflict")
    if not existing_executions:
        return
    existing = existing_executions[0]
    if (
        str(existing.alpaca_order_id) != broker_order_id
        or (
            existing.client_order_id is not None
            and existing.client_order_id != claim_handle.client_order_id
        )
        or (
            existing.trade_decision_id is not None
            and str(existing.trade_decision_id) != str(decision_row.id)
        )
    ):
        raise ValueError("linked_submission_recovery_execution_identity_conflict")


def _recovery_strategy_decision(decision_row: TradeDecision) -> StrategyDecision:
    raw_decision = decision_row.decision_json
    if not isinstance(raw_decision, Mapping):
        raise ValueError("linked_submission_recovery_decision_payload_invalid")
    decision_payload = cast(Mapping[str, object], raw_decision)
    return StrategyDecision.model_validate(dict(decision_payload))


LinkedSubmissionRecoveryMethods = _LinkedSubmissionRecoveryMethods

__all__ = ("LinkedSubmissionRecoveryMethods",)
