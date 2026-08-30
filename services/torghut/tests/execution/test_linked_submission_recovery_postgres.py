from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from typing import cast

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models import Execution, TradeDecision
from app.trading.alpaca_mutation_recovery import LinkedSubmissionRecoveryExecutor
from app.trading.broker_mutation_receipts import (
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationReceiptAcquireResult,
    BrokerMutationReceiptFenceError,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    acquire_broker_mutation_recovery,
    build_broker_mutation_settlement,
    build_broker_mutation_recovery_observation,
    build_linked_submission_terminal_settlement,
    record_linked_submission_recovery_observation,
    release_broker_mutation_recovery,
    settle_linked_submission_recovery,
)
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimHandle,
    acquire_decision_submission_recovery_claim,
)
from app.trading.execution.durable_existing_order_recovery import (
    DurableExistingOrderRecoveryRequest,
    recover_durable_linked_existing_order,
)
from app.trading.firewall import OrderFirewall
from app.trading.broker_mutation_receipts.persistence import (
    append_full_state_event,
    full_state_values_from_event,
    load_latest_receipt_event,
)
from app.trading.broker_mutation_receipts.runtime_status import (
    load_broker_mutation_runtime_status,
)
from tests.execution.test_broker_mutation_linked_receipts_postgres import (
    LinkedSubmitFixture,
)
from tests.execution.test_broker_mutation_receipts_postgres import _force_recovery_due


from tests.execution.test_linked_submission_terminal_postgres import (
    _TerminalHarness,
    _enter_linked_io,
    _insert_execution,
    terminal_harness,
)

__all__ = ("terminal_harness",)


def _recovery_firewall() -> OrderFirewall:
    return cast(
        OrderFirewall,
        SimpleNamespace(
            broker_endpoint_url="https://paper-api.alpaca.markets",
        ),
    )


class _ObservedOrderExecutor:
    def __init__(self, *, fail_after_insert: bool = False) -> None:
        self.calls = 0
        self._fail_after_insert = fail_after_insert

    def recover_linked_order_submission(
        self,
        *,
        session: Session,
        execution_client: object,
        claim_handle: DecisionSubmissionClaimHandle,
        order_response: Mapping[str, object],
    ) -> Execution:
        _ = execution_client
        self.calls += 1
        execution_id = uuid.uuid4()
        session.execute(
            text(
                """
                INSERT INTO executions (
                    id, trade_decision_id, alpaca_account_label,
                    client_order_id, alpaca_order_id, status
                ) VALUES (
                    :execution_id, :decision_id, 'paper',
                    :client_order_id, :broker_order_id, :status
                )
                """
            ),
            {
                "execution_id": execution_id,
                "decision_id": claim_handle.decision_id,
                "client_order_id": claim_handle.client_order_id,
                "broker_order_id": order_response["id"],
                "status": str(order_response.get("status") or "accepted"),
            },
        )
        if self._fail_after_insert:
            raise RuntimeError("injected_after_execution_insert")
        return cast(Execution, SimpleNamespace(id=execution_id))


def _observed_order(fixture: LinkedSubmitFixture) -> dict[str, object]:
    return {
        "id": "recovered-existing-order",
        "client_order_id": fixture.claim_handle.client_order_id,
        "symbol": "AAPL",
        "side": "buy",
        "qty": "1",
        "type": "market",
        "time_in_force": "day",
        "limit_price": None,
        "stop_price": None,
        "status": "accepted",
    }


def _recovery_decision(
    session: Session,
    fixture: LinkedSubmitFixture,
) -> TradeDecision:
    decision_row = session.get(TradeDecision, fixture.decision_id)
    assert decision_row is not None
    return decision_row


def _upgrade_to_strict_submit_recovery(harness: _TerminalHarness) -> None:
    # This focused harness starts at the released 0061 receipt lineage and does
    # not create the unrelated options catalog. Follow the established
    # accelerated PostgreSQL test path while still executing 0066-0069.
    command.stamp(harness.alembic, "0065_strategy_capital_compat")
    with harness.engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE torghut_options_contract_catalog ("
                "contract_symbol TEXT PRIMARY KEY, status TEXT NOT NULL)"
            )
        )
    command.upgrade(harness.alembic, "0069_strict_submit_recovery")


def _force_linked_recovery_due(
    harness: _TerminalHarness,
    *,
    fixture: LinkedSubmitFixture,
    receipt_id: uuid.UUID,
) -> None:
    _force_recovery_due(harness.engine, receipt_id)
    with harness.engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "DISABLE TRIGGER trg_guard_td_submission_claim_0061_update"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "DISABLE TRIGGER trg_check_submission_claim_terminal_0069"
            )
        )
        connection.execute(
            text(
                "UPDATE trade_decision_submission_claims "
                "SET recovery_after = clock_timestamp() - interval '1 minute' "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "ENABLE TRIGGER trg_guard_td_submission_claim_0061_update"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE trade_decision_submission_claims "
                "ENABLE TRIGGER trg_check_submission_claim_terminal_0069"
            )
        )


def _acquire_linked_recovery(
    harness: _TerminalHarness,
    *,
    fixture: LinkedSubmitFixture,
    acquired: BrokerMutationReceiptAcquireResult,
):
    _force_linked_recovery_due(
        harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )
    token = uuid.uuid4()
    owner = "strict-recovery-test"
    with harness.sessions() as session:
        receipt_recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=acquired.receipt.receipt_id,
            recovery_owner=owner,
            writer_generation=2,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=token,
                lease_seconds=60,
            ),
        )
    assert receipt_recovery.acquired
    assert receipt_recovery.receipt is not None
    assert receipt_recovery.receipt.recovery_handle is not None
    with harness.sessions() as session:
        claim_recovery = acquire_decision_submission_recovery_claim(
            session,
            decision_id=fixture.decision_id,
            recovery_owner=owner,
            recovery_token=token,
            lease_seconds=60,
        )
    assert claim_recovery.acquired
    assert claim_recovery.claim is not None
    assert claim_recovery.claim.recovery_handle is not None
    return (
        receipt_recovery.receipt.recovery_handle,
        claim_recovery.claim.recovery_handle,
    )


def _strict_recovery_settlement(
    fixture: LinkedSubmitFixture,
    *,
    resolution_state: str,
    execution_id: uuid.UUID | None = None,
    broker_order_id: str | None = None,
) -> BrokerMutationSettlement:
    reconciled = resolution_state == "acknowledged"
    return build_linked_submission_terminal_settlement(
        BrokerMutationLinkedSubmissionSettlementRequest(
            source="recovery",
            outcome="reconciled" if reconciled else "rejected",
            claim_handle=fixture.claim_handle,
            broker_status="accepted" if reconciled else "rejected",
            rejection_code=None if reconciled else "broker_rejected",
            broker_reference=broker_order_id,
            execution_id=execution_id,
            recovery_evidence_payload={
                "schema_version": "torghut.test-strict-submit-recovery.v1",
                "resolution_state": resolution_state,
                "automatic_resubmission_attempted": False,
            },
        )
    )


def _assert_recovery_in_flight_without_terminal(
    harness: _TerminalHarness,
    *,
    fixture: LinkedSubmitFixture,
    acquired: BrokerMutationReceiptAcquireResult,
) -> None:
    with harness.engine.connect() as connection:
        claim = connection.execute(
            text(
                "SELECT state, completed_at, terminal_receipt_event_id "
                "FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).one()
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
        terminal_count = connection.execute(
            text(
                "SELECT count(*) FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id AND event_type = 'settled'"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).scalar_one()
    assert tuple(claim) == ("broker_io", None, None)
    assert execution_count == 0
    assert terminal_count == 0


def test_postgres_0069_upgrades_nonempty_0061_state_in_place(
    terminal_harness: _TerminalHarness,
) -> None:
    fixture, acquired = _enter_linked_io(terminal_harness)

    _upgrade_to_strict_submit_recovery(terminal_harness)

    with terminal_harness.engine.connect() as connection:
        revision = connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one()
        state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
        event_count = connection.execute(
            text(
                "SELECT count(*) FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).scalar_one()
        trigger_names = set(
            connection.execute(
                text("SELECT tgname FROM pg_trigger WHERE tgname LIKE '%0069%'")
            )
            .scalars()
            .all()
        )
    assert revision == "0069_strict_submit_recovery"
    assert state == "broker_io"
    assert event_count == 2
    assert trigger_names == {
        "trg_guard_td_submission_claim_0069_rejected",
        "trg_guard_bm_receipt_event_b_linked_terminal_0069",
        "trg_guard_bm_receipt_event_c_settlement_0069",
        "trg_check_submission_claim_terminal_0069",
        "trg_check_bm_event_terminal_0069",
        "trg_check_execution_terminal_0069",
    }


def test_postgres_0069_recovery_ack_commits_one_symmetric_terminal(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, claim_handle = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    execution_id = uuid.uuid4()
    broker_order_id = "recovered-order-ack"
    settlement = _strict_recovery_settlement(
        fixture,
        resolution_state="acknowledged",
        execution_id=execution_id,
        broker_order_id=broker_order_id,
    )

    with terminal_harness.sessions() as session:
        _insert_execution(
            session,
            fixture=fixture,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
        )
        terminal = settle_linked_submission_recovery(
            session,
            handle=receipt_handle,
            submission_recovery_handle=claim_handle,
            settlement=settlement,
        )

    assert terminal.runtime_result == "reconciled"
    assert terminal.submission_claim.state == "submitted"
    assert terminal.submission_claim.recovery_outcome == "found"
    assert terminal.submission_claim.execution_id == execution_id
    assert terminal.receipt.settlement is not None
    assert terminal.receipt.settlement.source == "recovery"
    assert terminal.receipt.settlement.broker_reference == broker_order_id
    with terminal_harness.engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT claim.state, claim.recovery_outcome, event.settlement_source, "
                "event.recovery_epoch, event.recovery_writer_generation, "
                "event.event_writer_generation "
                "FROM trade_decision_submission_claims AS claim "
                "JOIN broker_mutation_receipt_events AS event "
                "ON event.id = claim.terminal_receipt_event_id "
                "WHERE claim.trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).one()
    assert tuple(row) == ("submitted", "found", "recovery", 1, 2, 2)


def test_postgres_0069_observed_recovery_rejection_records_found(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, claim_handle = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    settlement = _strict_recovery_settlement(
        fixture,
        resolution_state="rejected",
    )

    with terminal_harness.sessions() as session:
        terminal = settle_linked_submission_recovery(
            session,
            handle=receipt_handle,
            submission_recovery_handle=claim_handle,
            settlement=settlement,
        )

    assert terminal.runtime_result == "rejected"
    assert terminal.submission_claim.state == "rejected"
    assert terminal.submission_claim.recovery_outcome == "found"
    assert terminal.submission_claim.execution_id is None
    assert terminal.receipt.settlement is not None
    assert terminal.receipt.settlement.source == "recovery"
    with terminal_harness.engine.connect() as connection:
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert execution_count == 0


def test_postgres_0069_negative_observation_commits_and_releases_pair(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, claim_handle = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=fixture.claim_handle.client_order_id,
            checked_target_key=fixture.claim_handle.client_order_id,
            outcome="not_found",
            evidence_payload={
                "schema_version": "torghut.test-strict-submit-recovery.v1",
                "route": "alpaca",
                "absence_proof_complete": True,
                "automatic_resubmission_attempted": False,
                "resolution_state": "manual_review",
            },
        )
    )

    with terminal_harness.sessions() as session:
        result = record_linked_submission_recovery_observation(
            session,
            handle=receipt_handle,
            submission_recovery_handle=claim_handle,
            observation=observation,
            retry_seconds=30,
        )

    assert result.receipt.state == "broker_io"
    assert result.receipt.lifecycle.event_type == "recovery_released"
    assert result.receipt.recovery.outcome == "not_found"
    assert result.submission_claim.state == "broker_io"
    assert result.submission_claim.recovery_outcome == "not_found"
    with terminal_harness.sessions() as session:
        runtime_status = load_broker_mutation_runtime_status(session)
    assert runtime_status["recovery_resolution_state_counts"] == {
        "claimed": 0,
        "submitted_unknown": 0,
        "acknowledged": 0,
        "rejected": 0,
        "expired": 0,
        "manual_review": 1,
        "validation_quarantine_closed": 0,
    }
    with terminal_harness.engine.connect() as connection:
        event_types = tuple(
            connection.execute(
                text(
                    "SELECT event_type FROM broker_mutation_receipt_events "
                    "WHERE receipt_id = :receipt_id ORDER BY sequence_no"
                ),
                {"receipt_id": acquired.receipt.receipt_id},
            ).scalars()
        )
        leases_released = connection.execute(
            text(
                "SELECT event.recovery_lease_expires_at <= clock_timestamp(), "
                "claim.recovery_lease_expires_at <= clock_timestamp() "
                "FROM broker_mutation_receipt_events AS event "
                "JOIN broker_mutation_receipts AS receipt "
                "ON receipt.id = event.receipt_id "
                "JOIN trade_decision_submission_claims AS claim "
                "ON claim.trade_decision_id = receipt.submission_claim_id "
                "WHERE event.receipt_id = :receipt_id "
                "ORDER BY event.sequence_no DESC LIMIT 1"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).one()
        paired_observation = connection.execute(
            text(
                "SELECT event.recovery_checked_at = claim.recovery_checked_at, "
                "event.recovery_after = claim.recovery_after, "
                "event.recovery_outcome = claim.recovery_outcome, "
                "event.recovery_lease_expires_at = "
                "claim.recovery_lease_expires_at "
                "FROM broker_mutation_receipt_events AS event "
                "JOIN broker_mutation_receipts AS receipt "
                "ON receipt.id = event.receipt_id "
                "JOIN trade_decision_submission_claims AS claim "
                "ON claim.trade_decision_id = receipt.submission_claim_id "
                "WHERE event.receipt_id = :receipt_id "
                "ORDER BY event.sequence_no DESC LIMIT 1"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).one()
    assert event_types[-2:] == ("recovery_observed", "recovery_released")
    assert tuple(leases_released) == (True, True)
    assert tuple(paired_observation) == (True, True, True, True)


def test_postgres_0069_rejects_asymmetric_recovery_observation(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, _ = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=fixture.claim_handle.client_order_id,
            checked_target_key=fixture.claim_handle.client_order_id,
            outcome="not_found",
            evidence_payload={
                "schema_version": "torghut.test-strict-submit-recovery.v1",
                "route": "alpaca",
                "absence_proof_complete": True,
                "automatic_resubmission_attempted": False,
            },
        )
    )

    with terminal_harness.sessions() as session:
        current = load_latest_receipt_event(
            session,
            acquired.receipt.receipt_id,
        )
        assert current is not None
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="recovery_observed",
            event_writer_generation=receipt_handle.recovery_writer_generation,
            recovery_after=current.recorded_at + timedelta(seconds=30),
            recovery_checked_at=current.recorded_at,
            recovery_observation_epoch=receipt_handle.recovery_epoch,
            recovery_outcome=observation.outcome,
            recovery_evidence_json=observation.evidence_json,
            recovery_evidence_sha256=observation.evidence_sha256,
        )
        append_full_state_event(
            session,
            receipt_id=acquired.receipt.receipt_id,
            values=values,
        )
        with pytest.raises(
            DBAPIError, match="linked recovery observation is asymmetric"
        ):
            session.commit()
        session.rollback()

    _assert_recovery_in_flight_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


@pytest.mark.parametrize(
    ("forgery", "error"),
    [
        ("epoch", "invalid broker mutation settlement"),
        ("evidence", "linked recovery evidence semantics invalid"),
    ],
)
def test_postgres_0069_rejects_forged_recovery_terminals(
    terminal_harness: _TerminalHarness,
    forgery: str,
    error: str,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, _ = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    evidence = {
        "schema_version": "torghut.linked-submission-recovery-terminal.v1",
        "decision_id": str(fixture.decision_id),
        "account_label": fixture.claim_handle.account_label,
        "client_order_id": fixture.claim_handle.client_order_id,
        "broker_status": "not_found",
        "rejection_code": "recovery_absence_proven",
        "recovery": {
            "schema_version": "torghut.test-strict-submit-recovery.v1",
            "resolution_state": "expired",
            "automatic_resubmission_attempted": forgery == "evidence",
        },
    }
    forged = build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="recovery",
            outcome="rejected",
            broker_reference=None,
            execution_id=None,
            evidence_payload=evidence,
        )
    )
    with terminal_harness.sessions() as session:
        current = load_latest_receipt_event(
            session,
            acquired.receipt.receipt_id,
        )
        assert current is not None
        values = full_state_values_from_event(current)
        values.update(
            sequence_no=current.sequence_no + 1,
            event_type="settled",
            state="settled",
            event_writer_generation=receipt_handle.recovery_writer_generation,
            recovery_epoch=(
                receipt_handle.recovery_epoch + 1
                if forgery == "epoch"
                else receipt_handle.recovery_epoch
            ),
            settlement_source=forged.source,
            settlement_outcome=forged.outcome,
            broker_reference=None,
            execution_id=None,
            settlement_evidence_json=forged.evidence_json,
            settlement_evidence_sha256=forged.evidence_sha256,
            settled_at=current.recorded_at,
        )
        with pytest.raises(DBAPIError, match=error):
            append_full_state_event(
                session,
                receipt_id=acquired.receipt.receipt_id,
                values=values,
            )
        session.rollback()
    _assert_recovery_in_flight_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


def test_postgres_0069_stale_application_handle_is_fenced(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, claim_handle = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    settlement = _strict_recovery_settlement(
        fixture,
        resolution_state="rejected",
    )

    with terminal_harness.sessions() as session:
        with pytest.raises(
            BrokerMutationReceiptFenceError,
            match="linked_submission_recovery_fenced",
        ):
            settle_linked_submission_recovery(
                session,
                handle=receipt_handle,
                submission_recovery_handle=replace(
                    claim_handle,
                    recovery_fencing_epoch=claim_handle.recovery_fencing_epoch + 1,
                ),
                settlement=settlement,
            )
    _assert_recovery_in_flight_without_terminal(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )


def test_postgres_0069_independent_recovery_epochs_remain_fenced(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    _force_linked_recovery_due(
        terminal_harness,
        fixture=fixture,
        receipt_id=acquired.receipt.receipt_id,
    )
    with terminal_harness.sessions() as session:
        receipt_only = acquire_broker_mutation_recovery(
            session,
            receipt_id=acquired.receipt.receipt_id,
            recovery_owner="receipt-only-attempt",
            writer_generation=2,
            options=BrokerMutationRecoveryAcquireOptions(
                recovery_token=uuid.uuid4(),
                lease_seconds=60,
            ),
        )
    assert receipt_only.receipt is not None
    assert receipt_only.receipt.recovery_handle is not None
    with terminal_harness.sessions() as session:
        release_broker_mutation_recovery(
            session,
            handle=receipt_only.receipt.recovery_handle,
        )

    receipt_handle, claim_handle = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    assert receipt_handle.recovery_epoch == 2
    assert claim_handle.recovery_fencing_epoch == 1
    settlement = _strict_recovery_settlement(
        fixture,
        resolution_state="rejected",
    )

    with terminal_harness.sessions() as session:
        terminal = settle_linked_submission_recovery(
            session,
            handle=receipt_handle,
            submission_recovery_handle=claim_handle,
            settlement=settlement,
        )

    assert terminal.runtime_result == "rejected"
    assert terminal.submission_claim.recovery_outcome == "found"


def test_postgres_0069_refuses_downgrade_after_recovery_terminal(
    terminal_harness: _TerminalHarness,
) -> None:
    _upgrade_to_strict_submit_recovery(terminal_harness)
    fixture, acquired = _enter_linked_io(terminal_harness)
    receipt_handle, claim_handle = _acquire_linked_recovery(
        terminal_harness,
        fixture=fixture,
        acquired=acquired,
    )
    settlement = _strict_recovery_settlement(
        fixture,
        resolution_state="rejected",
    )
    with terminal_harness.sessions() as session:
        settle_linked_submission_recovery(
            session,
            handle=receipt_handle,
            submission_recovery_handle=claim_handle,
            settlement=settlement,
        )

    with pytest.raises(DBAPIError) as refusal:
        command.downgrade(terminal_harness.alembic, "0068_validation_submit")

    assert getattr(refusal.value.orig, "sqlstate", None) == "55000"
    with terminal_harness.engine.connect() as connection:
        revision = connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one()
        state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert revision == "0069_strict_submit_recovery"
    assert state == "rejected"


def test_order_executor_existing_order_recovery_settles_linked_records_once(
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
    assert result.execution.status == "accepted"
    assert executor.calls == 1
    with terminal_harness.engine.connect() as connection:
        claim = connection.execute(
            text(
                "SELECT state, recovery_outcome, execution_id "
                "FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).one()
        receipt = connection.execute(
            text(
                "SELECT state, settlement_source, settlement_outcome, execution_id "
                "FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id "
                "ORDER BY sequence_no DESC LIMIT 1"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).one()
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert claim.state == "submitted"
    assert claim.recovery_outcome == "found"
    assert claim.execution_id is not None
    assert tuple(receipt[:3]) == ("settled", "recovery", "reconciled")
    assert receipt.execution_id == claim.execution_id
    assert execution_count == 1
    with terminal_harness.sessions() as session:
        repeated = recover_durable_linked_existing_order(
            DurableExistingOrderRecoveryRequest(
                executor=cast(LinkedSubmissionRecoveryExecutor, executor),
                session=session,
                firewall=_recovery_firewall(),
                decision_row=_recovery_decision(session, fixture),
                account_label="paper",
                existing_orders=(order,),
            )
        )
    assert repeated.handled
    assert repeated.execution is not None
    assert repeated.execution.id == result.execution.id
    assert executor.calls == 1
    with terminal_harness.engine.connect() as connection:
        repeated_execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert repeated_execution_count == 1


def test_order_executor_existing_order_recovery_preserves_rejection_state(
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
    order["status"] = "rejected"
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
    assert result.execution is None
    assert executor.calls == 0
    with terminal_harness.engine.connect() as connection:
        decision = connection.execute(
            text(
                "SELECT status, decision_json FROM trade_decisions "
                "WHERE id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).one()
        claim_state = connection.execute(
            text(
                "SELECT state FROM trade_decision_submission_claims "
                "WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
        receipt = connection.execute(
            text(
                "SELECT state, settlement_source, settlement_outcome, execution_id "
                "FROM broker_mutation_receipt_events "
                "WHERE receipt_id = :receipt_id "
                "ORDER BY sequence_no DESC LIMIT 1"
            ),
            {"receipt_id": acquired.receipt.receipt_id},
        ).one()
        execution_count = connection.execute(
            text(
                "SELECT count(*) FROM executions WHERE trade_decision_id = :decision_id"
            ),
            {"decision_id": fixture.decision_id},
        ).scalar_one()
    assert decision.status == "rejected"
    assert decision.decision_json["submission_stage"] == "rejected"
    assert decision.decision_json["risk_reasons"] == ["broker_rejected"]
    assert decision.decision_json["reject_reason_atomic"] == ["broker_rejected"]
    assert decision.decision_json["reject_class"] == "runtime"
    assert decision.decision_json["reject_origin"] == "scheduler"
    assert claim_state == "rejected"
    assert tuple(receipt[:3]) == ("settled", "recovery", "rejected")
    assert receipt.execution_id is None
    assert execution_count == 0
