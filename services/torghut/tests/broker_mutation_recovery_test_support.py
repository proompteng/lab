from __future__ import annotations

import uuid
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Base,
    BrokerMutationReceiptEvent,
    Execution,
    Strategy,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationReceiptError,
    BrokerMutationIntentRequest,
    BrokerMutationLinkedSubmissionSettlementRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    build_linked_submission_terminal_settlement,
    mark_broker_mutation_io_started,
)
from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryPolicy,
    BrokerMutationRecoveryWorker,
    BrokerSubmitRecoveryRead,
)
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimAcquireOptions,
    acquire_decision_submission_claim,
)


def _sessions(database_path: Path) -> sessionmaker[Session]:
    engine = create_engine(
        f"sqlite+pysqlite:///{database_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        future=True,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )


def _recovery_policy(
    *,
    manual_review_after_seconds: int = 1800,
    batch_size: int = 50,
) -> BrokerMutationRecoveryPolicy:
    return BrokerMutationRecoveryPolicy(
        batch_size=batch_size,
        lease_seconds=60,
        retry_seconds=30,
        absence_grace_seconds=0,
        absence_observation_spacing_seconds=0,
        manual_review_after_seconds=manual_review_after_seconds,
        manual_review_retry_seconds=3600,
    )


def _complete_not_found(route: str) -> BrokerSubmitRecoveryRead:
    return BrokerSubmitRecoveryRead(
        outcome="not_found",
        evidence={
            "schema_version": f"torghut.test-{route}-read.v1",
            "route": route,
            "absence_proof_complete": True,
        },
    )


def _found(route: str, broker_order_id: str) -> BrokerSubmitRecoveryRead:
    return BrokerSubmitRecoveryRead(
        outcome="found",
        evidence={
            "schema_version": f"torghut.test-{route}-read.v1",
            "route": route,
            "absence_proof_complete": False,
        },
        broker_order={"id": broker_order_id, "status": "accepted"},
    )


@dataclass
class _ObservationOnlyRoute:
    broker_route: str
    account_label: str
    endpoint_fingerprint: str
    reads: deque[BrokerSubmitRecoveryRead]
    activity: tuple[str, ...] = ()
    independent_activity_error: Exception | None = None
    fail_found_persistence_once: bool = False
    found_rejected: bool = False
    observe_calls: int = 0
    persisted_broker_ids: list[str] = field(default_factory=list)

    def observe(
        self,
        _receipt: BrokerMutationReceiptSnapshot,
        *,
        observed_at: datetime,
    ) -> BrokerSubmitRecoveryRead:
        assert observed_at.tzinfo is not None
        self.observe_calls += 1
        if not self.reads:
            raise AssertionError("unexpected recovery observation")
        return self.reads.popleft()

    def independent_activity(
        self,
        _session: Session,
        _receipt: BrokerMutationReceiptSnapshot,
    ) -> tuple[str, ...]:
        if self.independent_activity_error is not None:
            raise self.independent_activity_error
        return self.activity

    def build_found_settlement(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
        read: BrokerSubmitRecoveryRead,
    ) -> BrokerMutationSettlement:
        order = read.broker_order
        assert isinstance(order, Mapping)
        broker_order_id = str(order["id"])
        if self.fail_found_persistence_once:
            self.fail_found_persistence_once = False
            session.add(
                _execution(
                    receipt,
                    broker_order_id=f"rolled-back-{broker_order_id}",
                )
            )
            session.flush()
            raise BrokerMutationReceiptError("injected terminal persistence failure")
        self.persisted_broker_ids.append(broker_order_id)
        claim_handle = receipt.submission_claim_handle
        if claim_handle is None:
            return build_broker_mutation_settlement(
                BrokerMutationSettlementRequest(
                    source="recovery",
                    outcome="rejected" if self.found_rejected else "reconciled",
                    broker_reference=broker_order_id,
                    execution_id=None,
                    evidence_payload={
                        "resolution_state": (
                            "rejected" if self.found_rejected else "acknowledged"
                        ),
                        "automatic_resubmission_attempted": False,
                    },
                )
            )
        if self.found_rejected:
            return build_linked_submission_terminal_settlement(
                BrokerMutationLinkedSubmissionSettlementRequest(
                    source="recovery",
                    outcome="rejected",
                    claim_handle=claim_handle,
                    broker_status="rejected",
                    rejection_code="broker_rejected",
                    broker_reference=None,
                    execution_id=None,
                    recovery_evidence_payload={
                        "schema_version": "torghut.test-linked-recovery.v1",
                        "resolution_state": "rejected",
                        "automatic_resubmission_attempted": False,
                    },
                )
            )
        execution = _execution(receipt, broker_order_id=broker_order_id)
        session.add(execution)
        session.flush()
        return build_linked_submission_terminal_settlement(
            BrokerMutationLinkedSubmissionSettlementRequest(
                source="recovery",
                outcome="reconciled",
                claim_handle=claim_handle,
                broker_status="accepted",
                rejection_code=None,
                broker_reference=broker_order_id,
                execution_id=execution.id,
                recovery_evidence_payload={
                    "schema_version": "torghut.test-linked-recovery.v1",
                    "resolution_state": "acknowledged",
                    "automatic_resubmission_attempted": False,
                },
            )
        )


def _execution(
    receipt: BrokerMutationReceiptSnapshot,
    *,
    broker_order_id: str,
) -> Execution:
    claim_handle = receipt.submission_claim_handle
    assert claim_handle is not None
    return Execution(
        id=uuid.uuid4(),
        trade_decision_id=claim_handle.decision_id,
        alpaca_account_label=receipt.intent.account_label,
        alpaca_order_id=broker_order_id,
        client_order_id=receipt.intent.client_request_id,
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("0"),
        status="accepted",
        raw_order={"id": broker_order_id},
    )


def _create_unlinked_submit(
    sessions: sessionmaker[Session],
    *,
    client_order_id: str,
    endpoint_fingerprint: str,
) -> uuid.UUID:
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint=endpoint_fingerprint,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id=f"signal/{client_order_id}",
            client_request_id=client_order_id,
            target=BrokerMutationTarget(kind="order", key=client_order_id),
            request_payload={
                "coin": "BTC",
                "side": "buy",
                "size": Decimal("0.001"),
            },
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="test-writer",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    with sessions() as session:
        io_start = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            recovery_seconds=30,
        )
    assert io_start.authorized
    _force_due(sessions, io_start.receipt.receipt_id)
    return io_start.receipt.receipt_id


def _create_linked_submit(
    sessions: sessionmaker[Session],
    *,
    client_order_id: str,
    endpoint_fingerprint: str,
) -> tuple[uuid.UUID, uuid.UUID]:
    with sessions() as session:
        strategy = Strategy(
            name=f"recovery-{client_order_id[:8]}",
            description="strict recovery test",
            enabled=True,
            base_timeframe="1Min",
            universe_type="symbols_list",
            universe_symbols=["AAPL"],
        )
        session.add(strategy)
        session.flush()
        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"action": "buy", "qty": "1"},
            rationale="strict recovery test",
            decision_hash=client_order_id,
            status="planned",
        )
        session.add(decision)
        session.commit()
        decision_id = decision.id
    with sessions() as session:
        claim = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="test-writer",
            options=DecisionSubmissionClaimAcquireOptions(
                claim_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    assert claim.claim is not None
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=endpoint_fingerprint,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id=f"decision/{decision_id}",
            client_request_id=client_order_id,
            target=BrokerMutationTarget(kind="order", key=client_order_id),
            request_payload={
                "symbol": "AAPL",
                "side": "buy",
                "qty": Decimal("1"),
                "order_type": "market",
                "time_in_force": "day",
            },
            submission_claim_id=decision_id,
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="test-writer",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                lease_seconds=30,
                submission_claim_handle=claim.claim.handle,
            ),
        )
    with sessions() as session:
        io_start = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            submission_claim_handle=claim.claim.handle,
            recovery_seconds=30,
        )
    assert io_start.authorized
    receipt_id = io_start.receipt.receipt_id
    _force_due(sessions, receipt_id, decision_id=decision_id)
    return receipt_id, decision_id


def _force_due(
    sessions: sessionmaker[Session],
    receipt_id: uuid.UUID,
    *,
    decision_id: uuid.UUID | None = None,
    due_at: datetime | None = None,
) -> None:
    old = due_at or datetime(2000, 1, 1, tzinfo=timezone.utc)
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        latest.broker_io_started_at = old
        latest.recovery_after = old
        if latest.recovery_lease_expires_at is not None:
            latest.recovery_lease_started_at = old
            latest.recovery_lease_expires_at = old
        if latest.recovery_checked_at is not None:
            latest.recovery_checked_at = old
        if decision_id is not None:
            claim = session.get(TradeDecisionSubmissionClaim, decision_id)
            assert claim is not None
            claim.broker_io_started_at = old
            claim.recovery_after = old
            if claim.recovery_lease_expires_at is not None:
                claim.recovery_lease_started_at = old
                claim.recovery_lease_expires_at = old
            if claim.recovery_checked_at is not None:
                claim.recovery_checked_at = old
        session.commit()


def _worker(
    sessions: sessionmaker[Session],
    route: _ObservationOnlyRoute,
    *,
    component: str,
    manual_review_after_seconds: int = 1800,
    batch_size: int = 50,
) -> BrokerMutationRecoveryWorker:
    return BrokerMutationRecoveryWorker(
        session_factory=sessions,
        routes=(route,),
        component=component,
        policy=_recovery_policy(
            manual_review_after_seconds=manual_review_after_seconds,
            batch_size=batch_size,
        ),
    )
