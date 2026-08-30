from __future__ import annotations

import json
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Execution,
    TradeDecisionSubmissionClaim,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    get_broker_mutation_receipt,
    get_broker_mutation_receipt_history,
)
from app.trading.broker_mutation_receipts.runtime_status import (
    load_broker_mutation_runtime_status,
)
from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryPolicy,
    BrokerMutationRecoveryWorker,
    BrokerMutationRecoveryRead,
)


from tests.broker_mutation_recovery_test_support import (
    _ObservationOnlyRoute,
    _complete_not_found,
    _create_linked_submit,
    _create_unlinked_cancel,
    _create_unlinked_submit,
    _force_due,
    _found,
    _sessions,
    _worker,
)


def test_claimed_receipt_is_reported_before_any_broker_io(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "claimed.sqlite")
    client_order_id = "0x" + "0" * 32
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint="0" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id=f"signal/{client_order_id}",
            client_request_id=client_order_id,
            target=BrokerMutationTarget(kind="order", key=client_order_id),
            request_payload={"coin": "BTC", "side": "buy", "size": "0.001"},
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="claimed-status-test",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    assert acquired.outcome == "acquired"

    with sessions() as session:
        status = load_broker_mutation_runtime_status(session)

    assert status["pre_io_receipt_count"] == 1
    assert status["recovery_resolution_state_counts"]["claimed"] == 1
    assert status["recovery_degraded"] is False


def test_lost_response_accepted_order_is_recovered_without_submit_surface(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "accepted.sqlite")
    endpoint = "a" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "1" * 32,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("hyperliquid", "broker-order-1")]),
    )
    assert not hasattr(route, "submit_order")

    result = _worker(sessions, route, component="accepted-test").run_once()

    assert result.outcomes == {"reconciled": 1}
    assert result.unresolved == 0
    assert result.degraded is False
    assert route.observe_calls == 1
    assert route.persisted_broker_ids == ["broker-order-1"]
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
        status = load_broker_mutation_runtime_status(session)
    assert receipt is not None
    assert receipt.state == "settled"
    assert receipt.settlement is not None
    assert receipt.settlement.source == "recovery"
    assert receipt.settlement.broker_reference == "broker-order-1"
    assert status["recovery_resolution_state_counts"]["acknowledged"] == 1


def test_worker_recovers_non_submit_mutation_receipts(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "cancel-recovery.sqlite")
    endpoint = "c" * 64
    receipt_id = _create_unlinked_cancel(
        sessions,
        order_id="order-1",
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("hyperliquid", "order-1")]),
    )

    result = _worker(sessions, route, component="cancel-test").run_once()

    assert result.outcomes == {"reconciled": 1}
    assert result.unresolved == 0
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
    assert receipt is not None
    assert receipt.intent.operation == "cancel_order"
    assert receipt.state == "settled"


def test_confirmed_broker_order_does_not_depend_on_absence_activity_read(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "found-skips-activity.sqlite")
    endpoint = "9" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "9" * 32,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("hyperliquid", "confirmed-order")]),
        independent_activity_error=AssertionError(
            "confirmed broker truth must skip absence-only reads"
        ),
    )

    result = _worker(sessions, route, component="found-skip-activity").run_once()

    assert result.outcomes == {"reconciled": 1}
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
    assert receipt is not None
    assert receipt.state == "settled"
    assert receipt.settlement.broker_reference == "confirmed-order"


def test_foreign_due_receipt_cannot_starve_owned_route_batch(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "route-filter.sqlite")
    foreign_endpoint = "8" * 64
    owned_endpoint = "9" * 64
    foreign_receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "8" * 32,
        endpoint_fingerprint=foreign_endpoint,
    )
    owned_receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "7" * 32,
        endpoint_fingerprint=owned_endpoint,
    )
    _force_due(
        sessions,
        foreign_receipt_id,
        due_at=datetime(1999, 1, 1, tzinfo=timezone.utc),
    )
    _force_due(
        sessions,
        owned_receipt_id,
        due_at=datetime(2000, 1, 1, tzinfo=timezone.utc),
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=owned_endpoint,
        reads=deque([_found("hyperliquid", "owned-order")]),
    )

    result = _worker(
        sessions,
        route,
        component="route-filter",
        batch_size=1,
    ).run_once()

    assert result.outcomes == {"reconciled": 1}
    assert route.observe_calls == 1
    with sessions() as session:
        foreign = get_broker_mutation_receipt(session, foreign_receipt_id)
        owned = get_broker_mutation_receipt(session, owned_receipt_id)
    assert foreign is not None and foreign.state == "broker_io"
    assert owned is not None and owned.state == "settled"


def test_two_complete_absence_observations_expire_into_operator_review(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "absent.sqlite")
    endpoint = "b" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "2" * 32,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque(
            [_complete_not_found("hyperliquid"), _complete_not_found("hyperliquid")]
        ),
    )
    worker = _worker(sessions, route, component="absence-test")

    first = worker.run_once()
    assert first.outcomes == {"not_found": 1}
    with sessions() as session:
        unresolved = get_broker_mutation_receipt(session, receipt_id)
        submitted_unknown = load_broker_mutation_runtime_status(session)
    assert unresolved is not None
    assert unresolved.state == "broker_io"
    assert unresolved.recovery.outcome == "not_found"
    assert submitted_unknown["recovery_degraded"] is True
    assert (
        submitted_unknown["recovery_resolution_state_counts"]["submitted_unknown"] == 1
    )

    _force_due(sessions, receipt_id)
    second = worker.run_once()
    assert second.outcomes == {"expired": 1}
    assert second.settled == 0
    with sessions() as session:
        expired = get_broker_mutation_receipt(session, receipt_id)
        status = load_broker_mutation_runtime_status(session)
    assert expired is not None
    assert expired.state == "broker_io"
    assert expired.settlement.source is None
    assert expired.recovery.outcome == "not_found"
    evidence = json.loads(expired.recovery.evidence_json or "{}")
    observation = evidence["observation"]
    assert observation["schema_version"] == (
        "torghut.broker-submit-recovery-observation.v1"
    )
    assert observation["resolution_state"] == "expired"
    assert observation["automatic_resubmission_attempted"] is False
    assert observation["operator_confirmation_required"] is True
    assert route.observe_calls == 2
    assert status["recovery_resolution_state_counts"]["expired"] == 1
    assert status["unresolved_receipt_count"] == 1
    assert status["recovery_degraded"] is True


def test_reduction_absence_never_inherits_submission_expiry(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "cancel-absence.sqlite")
    endpoint = "7" * 64
    receipt_id = _create_unlinked_cancel(
        sessions,
        order_id="order-absence",
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque(
            [_complete_not_found("hyperliquid"), _complete_not_found("hyperliquid")]
        ),
        independent_activity_error=AssertionError(
            "reduction recovery must not run submission activity checks"
        ),
    )
    worker = _worker(sessions, route, component="cancel-absence-test")

    assert worker.run_once().outcomes == {"not_found": 1}
    _force_due(sessions, receipt_id)
    assert worker.run_once().outcomes == {"not_found": 1}

    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
    assert receipt is not None
    assert receipt.state == "broker_io"
    evidence = json.loads(receipt.recovery.evidence_json or "{}")
    observation = evidence["observation"]
    assert observation["schema_version"] == (
        "torghut.broker-mutation-recovery-observation.v1"
    )
    assert observation["resolution_state"] == "submitted_unknown"
    assert observation["operator_confirmation_required"] is False
    assert observation["automatic_broker_mutation_attempted"] is False
    assert "automatic_resubmission_attempted" not in observation


def test_changed_broker_read_contract_restarts_absence_confirmation(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "absence-schema-change.sqlite")
    endpoint = "3" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "3" * 32,
        endpoint_fingerprint=endpoint,
    )
    first_read = _complete_not_found("hyperliquid")
    second_read = BrokerMutationRecoveryRead(
        outcome="not_found",
        evidence={
            **dict(_complete_not_found("hyperliquid").evidence),
            "schema_version": "torghut.test-hyperliquid-read.v2",
        },
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([first_read, second_read]),
    )
    worker = _worker(sessions, route, component="absence-schema-change")

    assert worker.run_once().outcomes == {"not_found": 1}
    _force_due(sessions, receipt_id)
    second = worker.run_once()

    assert second.outcomes == {"not_found": 1}
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
    assert receipt is not None
    evidence = json.loads(receipt.recovery.evidence_json or "{}")
    observation = evidence["observation"]
    assert observation["resolution_state"] == "submitted_unknown"
    assert observation["broker_read_schema_version"] == (
        "torghut.test-hyperliquid-read.v2"
    )


def test_delayed_broker_activity_wins_over_prior_absence_after_restart(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "restart.sqlite")
    endpoint = "c" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "3" * 32,
        endpoint_fingerprint=endpoint,
    )
    first_route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_complete_not_found("hyperliquid")]),
    )
    first = _worker(sessions, first_route, component="restart-a").run_once()
    assert first.outcomes == {"not_found": 1}

    _force_due(sessions, receipt_id)
    second_route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("hyperliquid", "delayed-order")]),
    )
    second = _worker(sessions, second_route, component="restart-b").run_once()

    assert second.outcomes == {"reconciled": 1}
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
        status = load_broker_mutation_runtime_status(session)
        history = get_broker_mutation_receipt_history(session, receipt_id)
    assert receipt is not None
    assert receipt.state == "settled"
    assert receipt.recovery_handle is not None
    assert receipt.recovery_handle.recovery_epoch == 2
    assert [event.snapshot.settlement for event in history].count(
        receipt.settlement
    ) == 1
    assert status["recovery_resolution_state_counts"]["acknowledged"] == 1


def test_conflicting_durable_activity_forces_manual_review(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "conflict.sqlite")
    endpoint = "d" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "4" * 32,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_complete_not_found("hyperliquid")]),
        activity=("execution_order",),
    )

    result = _worker(
        sessions,
        route,
        component="conflict-test",
        manual_review_after_seconds=0,
    ).run_once()

    assert result.outcomes == {"manual_review": 1}
    assert result.unresolved == 1
    assert result.degraded is True
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
        status = load_broker_mutation_runtime_status(session)
    assert receipt is not None
    assert receipt.state == "broker_io"
    assert receipt.recovery.outcome == "indeterminate"
    evidence = json.loads(receipt.recovery.evidence_json or "{}")
    observation = evidence["observation"]
    assert observation["resolution_state"] == "manual_review"
    assert observation["conflict"] == "broker_absence_with_durable_activity"
    assert observation["independent_activity"] == ["execution_order"]
    assert status["recovery_degraded"] is True
    assert status["recovery_resolution_state_counts"]["manual_review"] == 1
    assert status["reason_codes"][0] == "broker_mutation_recovery_manual_review"


def test_activity_query_failure_is_durable_indeterminate_not_false_absence(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "activity-error.sqlite")
    endpoint = "e" * 64
    receipt_id = _create_unlinked_submit(
        sessions,
        client_order_id="0x" + "5" * 32,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=endpoint,
        reads=deque([_complete_not_found("hyperliquid")]),
        independent_activity_error=TimeoutError("database read deadline"),
    )

    result = _worker(
        sessions,
        route,
        component="activity-error",
        manual_review_after_seconds=10**10,
    ).run_once()

    assert result.outcomes == {"indeterminate": 1}
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
    assert receipt is not None
    assert receipt.recovery.outcome == "indeterminate"
    evidence = json.loads(receipt.recovery.evidence_json or "{}")
    assert evidence["observation"]["independent_activity_error_class"] == "TimeoutError"
    assert evidence["observation"]["absence_proof_complete"] is False


def test_linked_observation_and_terminal_recovery_fence_claim_and_receipt(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "linked.sqlite")
    endpoint = "f" * 64
    client_order_id = "6" * 64
    receipt_id, decision_id = _create_linked_submit(
        sessions,
        client_order_id=client_order_id,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=endpoint,
        reads=deque([_complete_not_found("alpaca"), _found("alpaca", "order-6")]),
    )
    worker = _worker(sessions, route, component="linked-test")

    first = worker.run_once()
    assert first.outcomes == {"not_found": 1}
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        status = load_broker_mutation_runtime_status(session)
    assert receipt is not None
    assert claim is not None
    assert receipt.state == claim.state == "broker_io"
    assert receipt.recovery.outcome == claim.recovery_outcome == "not_found"
    assert receipt.recovery_handle is not None
    assert claim.recovery_token == receipt.recovery_handle.recovery_token
    assert claim.recovery_fencing_epoch == receipt.recovery_handle.recovery_epoch == 1
    assert status["recovery_resolution_state_counts"]["submitted_unknown"] == 1

    _force_due(sessions, receipt_id, decision_id=decision_id)
    second = worker.run_once()
    assert second.outcomes == {"reconciled": 1}
    with sessions() as session:
        recovered = get_broker_mutation_receipt(session, receipt_id)
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        executions = (
            session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_id)
            )
            .scalars()
            .all()
        )
    assert recovered is not None
    assert recovered.state == "settled"
    assert recovered.settlement is not None
    assert claim is not None
    assert claim.state == "submitted"
    assert claim.broker_order_id == "order-6"
    assert claim.execution_id == recovered.settlement.execution_id
    assert len(executions) == 1
    assert executions[0].alpaca_order_id == "order-6"


def test_linked_absence_expiry_preserves_claim_and_receipt_unresolved_state(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "linked-expired.sqlite")
    endpoint = "0" * 64
    receipt_id, decision_id = _create_linked_submit(
        sessions,
        client_order_id="0" * 64,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=endpoint,
        reads=deque([_complete_not_found("alpaca"), _complete_not_found("alpaca")]),
    )
    worker = _worker(sessions, route, component="linked-expired")

    assert worker.run_once().outcomes == {"not_found": 1}
    _force_due(sessions, receipt_id, decision_id=decision_id)
    assert worker.run_once().outcomes == {"expired": 1}

    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        execution_count = (
            session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_id)
            )
            .scalars()
            .all()
        )
    assert receipt is not None
    assert claim is not None
    assert receipt.state == claim.state == "broker_io"
    assert receipt.recovery.outcome == claim.recovery_outcome == "not_found"
    assert receipt.settlement.source is None
    assert claim.completed_at is None
    assert claim.terminal_receipt_event_id is None
    assert execution_count == []
    evidence = json.loads(receipt.recovery.evidence_json or "{}")
    assert evidence["observation"]["resolution_state"] == "expired"
    assert evidence["observation"]["operator_confirmation_required"] is True


def test_terminal_persistence_fault_rolls_back_and_next_leader_recovers(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "terminal-fault.sqlite")
    endpoint = "1" * 64
    client_order_id = "7" * 64
    receipt_id, decision_id = _create_linked_submit(
        sessions,
        client_order_id=client_order_id,
        endpoint_fingerprint=endpoint,
    )
    failing_route = _ObservationOnlyRoute(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("alpaca", "order-7")]),
        fail_found_persistence_once=True,
    )

    failed = _worker(sessions, failing_route, component="fault-a").run_once()
    assert failed.outcomes == {"failed": 1}
    with sessions() as session:
        assert (
            session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_id)
            )
            .scalars()
            .all()
            == []
        )
        receipt = get_broker_mutation_receipt(session, receipt_id)
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
    assert receipt is not None
    assert receipt.state == "broker_io"
    assert claim is not None
    assert claim.state == "broker_io"

    _force_due(sessions, receipt_id, decision_id=decision_id)
    succeeding_route = _ObservationOnlyRoute(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("alpaca", "order-7")]),
    )
    recovered = _worker(sessions, succeeding_route, component="fault-b").run_once()

    assert recovered.outcomes == {"reconciled": 1}
    with sessions() as session:
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        executions = (
            session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_id)
            )
            .scalars()
            .all()
        )
    assert claim is not None
    assert claim.state == "submitted"
    assert len(executions) == 1
    assert executions[0].alpaca_order_id == "order-7"


def test_broker_observed_rejection_records_found_not_absent(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "linked-rejected.sqlite")
    endpoint = "2" * 64
    receipt_id, decision_id = _create_linked_submit(
        sessions,
        client_order_id="8" * 64,
        endpoint_fingerprint=endpoint,
    )
    route = _ObservationOnlyRoute(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=endpoint,
        reads=deque([_found("alpaca", "rejected-order")]),
        found_rejected=True,
    )

    result = _worker(sessions, route, component="rejected-found").run_once()

    assert result.outcomes == {"rejected": 1}
    with sessions() as session:
        receipt = get_broker_mutation_receipt(session, receipt_id)
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        status = load_broker_mutation_runtime_status(session)
    assert receipt is not None
    assert receipt.state == "settled"
    assert receipt.settlement is not None
    assert receipt.settlement.outcome == "rejected"
    assert claim is not None
    assert claim.state == "rejected"
    assert claim.recovery_outcome == "found"
    assert status["recovery_resolution_state_counts"]["rejected"] == 1


def test_disabled_worker_performs_no_database_or_broker_reads() -> None:
    def forbidden_session() -> Session:
        raise AssertionError("disabled recovery opened the database")

    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint="a" * 64,
        reads=deque([_complete_not_found("hyperliquid")]),
    )
    worker = BrokerMutationRecoveryWorker(
        session_factory=forbidden_session,
        routes=(route,),
        component="disabled-test",
        enabled=False,
    )

    result = worker.run_once()

    assert result.enabled is False
    assert result.scanned == 0
    assert result.outcomes == {"disabled": 1}
    assert result.degraded is True
    assert route.observe_calls == 0


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"batch_size": 0}, "batch_size_outside_bounds"),
        ({"lease_seconds": 4}, "lease_seconds_outside_bounds"),
        ({"retry_seconds": 29}, "retry_seconds_outside_bounds"),
        (
            {
                "absence_grace_seconds": 29,
                "absence_observation_spacing_seconds": 30,
            },
            "absence_spacing_exceeds_grace",
        ),
        (
            {
                "absence_grace_seconds": 300,
                "manual_review_after_seconds": 299,
            },
            "manual_review_precedes_grace",
        ),
    ],
)
def test_invalid_recovery_policy_fails_at_construction(
    overrides: dict[str, int],
    error: str,
) -> None:
    with pytest.raises(ValueError, match=error):
        BrokerMutationRecoveryPolicy(**overrides)


def test_duplicate_or_malformed_routes_fail_at_startup(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "route-validation.sqlite")
    route = _ObservationOnlyRoute(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint="b" * 64,
        reads=deque(),
    )
    with pytest.raises(ValueError, match="route_duplicate"):
        BrokerMutationRecoveryWorker(
            session_factory=sessions,
            routes=(route, route),
            component="duplicate-route",
        )

    malformed = _ObservationOnlyRoute(
        broker_route="unknown",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint="not-a-fingerprint",
        reads=deque(),
    )
    with pytest.raises(ValueError, match="route_invalid"):
        BrokerMutationRecoveryWorker(
            session_factory=sessions,
            routes=(malformed,),
            component="malformed-route",
        )

    overlong_account = _ObservationOnlyRoute(
        broker_route="alpaca",
        account_label="a" * 65,
        endpoint_fingerprint="b" * 64,
        reads=deque(),
    )
    with pytest.raises(ValueError, match="account_label_invalid"):
        BrokerMutationRecoveryWorker(
            session_factory=sessions,
            routes=(overlong_account,),
            component="overlong-account",
        )

    with pytest.raises(ValueError, match="route_required"):
        BrokerMutationRecoveryWorker(
            session_factory=sessions,
            routes=(),
            component="empty-routes",
        )
