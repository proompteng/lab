from __future__ import annotations

from typing import cast

import pytest
from sqlalchemy import text

from app.trading.alpaca_mutation_recovery import LinkedSubmissionRecoveryExecutor
from app.trading.execution.durable_existing_order_recovery import (
    DurableExistingOrderRecoveryRequest,
    recover_durable_linked_existing_order,
)
from tests.execution.test_linked_submission_recovery_postgres import (
    _ObservedOrderExecutor,
    _force_linked_recovery_due,
    _observed_order,
    _recovery_decision,
    _recovery_firewall,
    _upgrade_to_strict_submit_recovery,
)
from tests.execution.test_linked_submission_terminal_postgres import (
    _TerminalHarness,
    _enter_linked_io,
    terminal_harness,
)

__all__ = ("terminal_harness",)


def test_order_executor_existing_order_recovery_returns_terminal_execution(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    _force_linked_recovery_due(
        terminal_harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )
    executor = _ObservedOrderExecutor()
    order = _observed_order(fixture)
    order["status"] = "canceled"

    with terminal_harness.sessions() as session:
        result = recover_durable_linked_existing_order(
            DurableExistingOrderRecoveryRequest(
                executor=cast(LinkedSubmissionRecoveryExecutor, executor),
                session=session,
                firewall=_recovery_firewall(),
                decision_row=_recovery_decision(session, fixture),
                account_label="paper",
                existing_orders=(order,),
            )
        )

    assert result.handled
    assert result.execution is not None
    assert result.execution.status == "canceled"
    assert executor.calls == 1


def test_order_executor_existing_order_recovery_rolls_back_partial_execution(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    _force_linked_recovery_due(
        terminal_harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )
    executor = _ObservedOrderExecutor(fail_after_insert=True)
    with (
        terminal_harness.sessions() as session,
        pytest.raises(RuntimeError, match="injected_after_execution_insert"),
    ):
        recover_durable_linked_existing_order(
            DurableExistingOrderRecoveryRequest(
                executor=cast(LinkedSubmissionRecoveryExecutor, executor),
                session=session,
                firewall=_recovery_firewall(),
                decision_row=_recovery_decision(session, fixture),
                account_label="paper",
                existing_orders=(_observed_order(fixture),),
            )
        )

    assert executor.calls == 1
    with terminal_harness.engine.connect() as connection:
        claim_state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
        receipt_state = connection.execute(
            text(
                "SELECT state FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id "
                "ORDER BY sequence_no DESC LIMIT 1"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).scalar_one()
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert (claim_state, receipt_state, execution_count) == (
        "broker_io",
        "broker_io",
        0,
    )
