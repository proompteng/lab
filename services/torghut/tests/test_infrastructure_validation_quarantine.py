from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.alpaca_client import AlpacaRecoveryOrderHistoryPage
from app.models import Base, BrokerMutationReceiptEvent
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    acquire_broker_mutation_recovery,
    build_broker_mutation_intent,
    build_broker_mutation_recovery_observation,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
    record_broker_mutation_recovery_observation,
    release_broker_mutation_recovery,
)
from app.trading.broker_mutation_receipts.runtime_status import (
    load_broker_mutation_runtime_status,
)
from app.trading.infrastructure_validation_quarantine import (
    VALIDATION_QUARANTINE_CONFIRMATION,
    InfrastructureValidationQuarantineContext,
    InfrastructureValidationQuarantineError,
    InfrastructureValidationQuarantineRequest,
    main,
    run_infrastructure_validation_quarantine_close,
)


_PAPER_ENDPOINT = "https://paper-api.alpaca.markets"


@dataclass
class _FakeClient:
    endpoint_url: str = _PAPER_ENDPOINT
    endpoint_class: str = "paper"
    exact_order: dict[str, object] | None = None
    history_complete: bool = True
    history_orders: tuple[dict[str, object], ...] = ()
    open_orders: tuple[dict[str, object], ...] = ()
    positions: tuple[dict[str, object], ...] = ()

    def get_account(self) -> dict[str, object]:
        return {
            "account_number": "paper-account",
            "status": "ACTIVE",
            "account_blocked": False,
            "trading_blocked": False,
            "trade_suspended_by_user": False,
            "transfers_blocked": False,
        }

    def get_order_by_client_order_id_strict(
        self, client_order_id: str
    ) -> dict[str, object] | None:
        del client_order_id
        return self.exact_order

    def list_orders_recovery_window(
        self,
        *,
        after: datetime,
        until: datetime,
        limit: int = 500,
    ) -> AlpacaRecoveryOrderHistoryPage:
        return AlpacaRecoveryOrderHistoryPage(
            orders=self.history_orders,
            complete=self.history_complete,
            limit=limit,
            after=after,
            until=until,
        )

    def list_open_orders(self) -> list[dict[str, object]]:
        return list(self.open_orders)

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)


def _sessions(path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite+pysqlite:///{path}", future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )


def _validation_intent(client_order_id: str) -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper-account",
            endpoint_fingerprint=fingerprint_broker_endpoint(_PAPER_ENDPOINT),
            operation="submit_order",
            risk_class="risk_neutral",
            purpose="control_plane_validation",
            workflow_id=client_order_id,
            client_request_id=client_order_id,
            target=BrokerMutationTarget(kind="order", key=client_order_id),
            request_payload={
                "broker_request": {
                    "symbol": "BTC/USD",
                    "side": "buy",
                    "qty": "0.00004",
                    "order_type": "limit",
                    "time_in_force": "ioc",
                    "limit_price": "67000",
                    "stop_price": None,
                    "extra_params": {"client_order_id": client_order_id},
                },
                "infrastructure_validation": {
                    "permit": {
                        "account_mode": "paper",
                        "evidence_tag": "non_promotable_validation",
                        "promotable": False,
                    }
                },
            },
        )
    )


def _seed_expired_receipt(
    sessions: sessionmaker[Session],
) -> tuple[uuid.UUID, BrokerMutationIntent]:
    client_order_id = "ivp-" + "a" * 44
    intent = _validation_intent(client_order_id)
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="validation-writer",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(lease_seconds=30),
        )
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            recovery_seconds=30,
        )
    receipt_id = started.receipt.receipt_id
    _force_recovery_due(sessions, receipt_id)
    with sessions() as session:
        recovery = acquire_broker_mutation_recovery(
            session,
            receipt_id=receipt_id,
            recovery_owner="recovery-reader",
            writer_generation=2,
            options=BrokerMutationRecoveryAcquireOptions(lease_seconds=30),
        )
    assert recovery.receipt is not None and recovery.receipt.recovery_handle is not None
    handle = recovery.receipt.recovery_handle
    observation = build_broker_mutation_recovery_observation(
        BrokerMutationRecoveryObservationRequest(
            checked_client_request_id=client_order_id,
            checked_target_key=client_order_id,
            outcome="not_found",
            evidence_payload={
                "schema_version": "torghut.broker-submit-recovery-observation.v1",
                "resolution_state": "expired",
                "absence_proof_complete": True,
                "operator_confirmation_required": True,
                "automatic_resubmission_attempted": False,
            },
        )
    )
    with sessions() as session:
        record_broker_mutation_recovery_observation(
            session,
            handle=handle,
            observation=observation,
            retry_seconds=3600,
        )
    with sessions() as session:
        release_broker_mutation_recovery(session, handle=handle)
    _age_latest_receipt(sessions, receipt_id)
    return receipt_id, intent


def _force_recovery_due(sessions: sessionmaker[Session], receipt_id: uuid.UUID) -> None:
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        latest.recovery_after = datetime(2000, 1, 1, tzinfo=timezone.utc)
        session.commit()


def _age_latest_receipt(sessions: sessionmaker[Session], receipt_id: uuid.UUID) -> None:
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt_id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        latest.broker_io_started_at = datetime.now(timezone.utc) - timedelta(minutes=2)
        session.commit()


def _request(
    receipt_id: uuid.UUID,
    intent_sha256: str,
) -> InfrastructureValidationQuarantineRequest:
    return InfrastructureValidationQuarantineRequest(
        receipt_id=receipt_id,
        expected_intent_sha256=intent_sha256,
        operator_id="codex-runtime-operator",
    )


def test_dry_run_then_apply_closes_only_the_validation_quarantine(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "quarantine.sqlite")
    receipt_id, intent = _seed_expired_receipt(sessions)
    context = InfrastructureValidationQuarantineContext(
        client=_FakeClient(),
        session_factory=sessions,
        evaluated_at=datetime.now(timezone.utc),
    )

    dry_run = run_infrastructure_validation_quarantine_close(
        request=_request(receipt_id, intent.canonical_intent_sha256),
        context=context,
    )
    assert not dry_run.applied
    assert dry_run.receipt_state == "broker_io"
    assert dry_run.settlement_outcome == "validation_quarantine_closed"

    applied = run_infrastructure_validation_quarantine_close(
        request=_request(receipt_id, intent.canonical_intent_sha256),
        context=context,
        apply=True,
    )
    assert applied.applied
    assert applied.receipt_state == "settled"
    assert applied.settlement_outcome == "validation_quarantine_closed"
    assert applied.evidence_sha256 == dry_run.evidence_sha256

    with sessions() as session:
        status = load_broker_mutation_runtime_status(session)
    assert status["unresolved_receipt_count"] == 0
    assert status["recovery_resolution_state_counts"] == {
        "claimed": 0,
        "submitted_unknown": 0,
        "acknowledged": 0,
        "rejected": 0,
        "expired": 0,
        "manual_review": 0,
        "validation_quarantine_closed": 1,
    }


@pytest.mark.parametrize(
    "client,error",
    [
        (_FakeClient(exact_order={"id": "found"}), "exact_order_found"),
        (_FakeClient(history_complete=False), "history_incomplete_or_matched"),
        (
            _FakeClient(history_orders=({"client_order_id": "ivp-" + "a" * 44},)),
            "history_incomplete_or_matched",
        ),
        (_FakeClient(open_orders=({"id": "open"},)), "account_not_flat"),
        (_FakeClient(positions=({"symbol": "BTC/USD"},)), "account_not_flat"),
        (
            _FakeClient(
                endpoint_url="https://api.alpaca.markets",
                endpoint_class="live",
            ),
            "broker_endpoint_mismatch",
        ),
    ],
)
def test_fresh_broker_evidence_fails_closed(
    tmp_path: Path,
    client: _FakeClient,
    error: str,
) -> None:
    sessions = _sessions(tmp_path / f"{error}.sqlite")
    receipt_id, intent = _seed_expired_receipt(sessions)

    with pytest.raises(InfrastructureValidationQuarantineError, match=error):
        run_infrastructure_validation_quarantine_close(
            request=_request(receipt_id, intent.canonical_intent_sha256),
            context=InfrastructureValidationQuarantineContext(
                client=client,
                session_factory=sessions,
            ),
            apply=True,
        )


def test_wrong_intent_digest_cannot_close_receipt(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "wrong-digest.sqlite")
    receipt_id, _ = _seed_expired_receipt(sessions)

    with pytest.raises(
        InfrastructureValidationQuarantineError,
        match="receipt_ineligible",
    ):
        run_infrastructure_validation_quarantine_close(
            request=_request(receipt_id, "b" * 64),
            context=InfrastructureValidationQuarantineContext(
                client=_FakeClient(),
                session_factory=sessions,
            ),
            apply=True,
        )


def test_apply_requires_explicit_confirmation_before_client_construction() -> None:
    with pytest.raises(SystemExit, match=VALIDATION_QUARANTINE_CONFIRMATION):
        main(
            [
                "--receipt-id",
                str(uuid.uuid4()),
                "--expected-intent-sha256",
                "a" * 64,
                "--operator-id",
                "operator",
                "--apply",
                "--confirm",
                "WRONG",
            ]
        )
