"""Persistence of broker-observed linked submissions."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Optional, cast

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ...models import Execution, TradeDecision
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
        execution_client: Any,
        decision_id: uuid.UUID | str,
        account_label: str,
        order_response: Mapping[str, object],
        execution_expected_adapter: Optional[str] = None,
    ) -> Execution:
        """Persist a broker-observed order without issuing broker I/O or committing."""

        normalized_decision_id = uuid.UUID(str(decision_id))
        decision_row = session.execute(
            select(TradeDecision).where(
                TradeDecision.id == normalized_decision_id,
                TradeDecision.alpaca_account_label == account_label,
            )
        ).scalar_one_or_none()
        if decision_row is None:
            raise ValueError("linked_submission_recovery_decision_not_found")
        broker_order_id = str(
            order_response.get("id") or order_response.get("order_id") or ""
        ).strip()
        client_order_id = str(order_response.get("client_order_id") or "").strip()
        expected_client_order_id = str(decision_row.decision_hash or "").strip()
        if not broker_order_id:
            raise ValueError("linked_submission_recovery_broker_order_id_required")
        if not client_order_id or client_order_id != expected_client_order_id:
            raise ValueError("linked_submission_recovery_client_order_id_mismatch")
        existing_executions = (
            session.execute(
                select(Execution)
                .where(
                    Execution.alpaca_account_label == account_label,
                    or_(
                        Execution.alpaca_order_id == broker_order_id,
                        Execution.client_order_id == client_order_id,
                    ),
                )
                .with_for_update()
            )
            .scalars()
            .all()
        )
        if len(existing_executions) > 1:
            raise ValueError("linked_submission_recovery_execution_identity_conflict")
        if existing_executions:
            existing = existing_executions[0]
            if (
                str(existing.alpaca_order_id) != broker_order_id
                or (
                    existing.client_order_id is not None
                    and existing.client_order_id != client_order_id
                )
                or (
                    existing.trade_decision_id is not None
                    and str(existing.trade_decision_id) != str(decision_row.id)
                )
            ):
                raise ValueError(
                    "linked_submission_recovery_execution_identity_conflict"
                )
        raw_decision = decision_row.decision_json
        if not isinstance(raw_decision, Mapping):
            raise ValueError("linked_submission_recovery_decision_payload_invalid")
        decision_payload = cast(Mapping[str, object], raw_decision)
        decision = StrategyDecision.model_validate(dict(decision_payload))
        execution_policy_context = _extract_execution_policy_context(
            decision,
            decision_row=decision_row,
        )
        execution = self._sync_submitted_order_execution(
            session=session,
            execution_client=execution_client,
            decision=decision,
            decision_row=decision_row,
            account_label=account_label,
            execution_expected_adapter=execution_expected_adapter,
            execution_policy_context=execution_policy_context,
            order_response=order_response,
            commit=False,
        )

        link_order_events_to_execution(session, execution)
        return execution


LinkedSubmissionRecoveryMethods = _LinkedSubmissionRecoveryMethods

__all__ = ("LinkedSubmissionRecoveryMethods",)
