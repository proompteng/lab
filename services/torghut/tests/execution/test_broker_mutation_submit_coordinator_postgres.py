from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from threading import Barrier, Event, Lock
from typing import cast

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

import app.trading.broker_mutation_submit_coordinator as submit_coordinator_module
import app.trading.firewall as firewall_module
import app.trading.infrastructure_validation_submit as validation_submit_module
from app.config import settings
from app.models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    Execution,
    TradeDecisionSubmissionClaim,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    consume_broker_mutation_io_permit,
    fingerprint_broker_endpoint,
    validate_broker_mutation_io_permit,
)
from app.trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionAlreadyProcessed,
    BrokerMutationSubmissionDeferred,
    BrokerMutationSubmissionRejected,
    BrokerMutationSubmitCoordinator,
    InfrastructureValidationOrderSubmission,
    LinkedOrderSubmission,
    LinkedOrderSubmissionCallbacks,
    UnlinkedOrderSubmissionCallbacks,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_request_payload,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_submit import (
    InfrastructureValidationSubmitContext,
    run_infrastructure_validation_submit,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
    insert_decision,
)


def _upgrade_validation_submit_schema(
    alembic: AlembicConfig,
    schema_engine: Engine,
) -> None:
    """Apply the accelerated receipt lineage with its historical catalog prerequisite."""

    command.stamp(alembic, "0057_generic_multifactor_machine")
    command.upgrade(alembic, "0061_linked_submission_terminal")
    command.stamp(alembic, "0065_strategy_capital_compat")
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE torghut_options_contract_catalog (
                    contract_symbol TEXT PRIMARY KEY,
                    status TEXT NOT NULL
                )
                """
            )
        )
    command.upgrade(alembic, "0068_validation_submit")


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the coordinator race test",
)
def test_postgres_two_leaders_make_exactly_one_broker_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "submit_coordinator"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0061_linked_submission_terminal")
        command.stamp(alembic, "0065_strategy_capital_compat")
        command.upgrade(alembic, "0066_broker_submit_coordinator")

        with schema_engine.connect() as connection:
            check_constraints = connection.execute(
                text(
                    """
                    SELECT conname, pg_get_constraintdef(oid)
                      FROM pg_constraint
                     WHERE conrelid = 'broker_mutation_receipts'::regclass
                       AND contype = 'c'
                    """
                )
            ).all()
        operation_contract = next(
            definition
            for _name, definition in check_constraints
            if "submit_order" in definition and "hyperliquid" in definition
        )
        assert "alpaca" in operation_contract
        assert "hyperliquid" in operation_contract

        decision_id = uuid.uuid4()
        client_order_id = uuid.uuid4().hex + uuid.uuid4().hex
        with schema_engine.begin() as connection:
            insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id=client_order_id,
            )

        request = LinkedOrderSubmission(
            decision_id=decision_id,
            account_label="paper",
            client_order_id=client_order_id,
            endpoint_url="https://paper-api.alpaca.markets",
            workflow_id=str(decision_id),
            risk_class="risk_increasing",
            request_payload={
                "symbol": "AAPL",
                "side": "buy",
                "qty": Decimal("1"),
                "order_type": "market",
                "time_in_force": "day",
            },
        )
        entrants = Barrier(2)
        broker_started = Event()
        release_broker = Event()
        broker_call_lock = Lock()
        broker_calls = 0

        def broker_call(permit: BrokerMutationIoPermit) -> Mapping[str, object]:
            nonlocal broker_calls
            validate_broker_mutation_io_permit(permit)
            with broker_call_lock:
                broker_calls += 1
            broker_started.set()
            assert release_broker.wait(timeout=10)
            return {"id": "order-concurrent", "status": "accepted"}

        def run(component: str) -> str:
            entrants.wait(timeout=10)
            with sessions() as session:
                try:
                    BrokerMutationSubmitCoordinator(component).submit_linked_order(
                        session,
                        request=request,
                        callbacks=LinkedOrderSubmissionCallbacks(
                            broker_call=broker_call,
                            persist_execution=lambda response: _persist_execution(
                                session,
                                decision_id=decision_id,
                                client_order_id=client_order_id,
                                response=response,
                            ),
                        ),
                    )
                except BrokerMutationSubmissionAlreadyProcessed:
                    return "already_processed"
                except BrokerMutationSubmissionDeferred:
                    return "deferred"
            return "submitted"

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(run, component)
                for component in ("leader-a", "leader-b")
            ]
            assert broker_started.wait(timeout=10)
            release_broker.set()
            outcomes = [future.result(timeout=15) for future in futures]

        assert broker_calls == 1
        assert outcomes.count("submitted") == 1
        assert set(outcomes).issubset({"submitted", "already_processed", "deferred"})
        with sessions() as session:
            claim_state = session.execute(
                select(TradeDecisionSubmissionClaim.state)
            ).scalar_one()
            receipt_state = session.execute(
                select(BrokerMutationReceiptEvent.state)
                .join(
                    BrokerMutationReceipt,
                    BrokerMutationReceipt.id == BrokerMutationReceiptEvent.receipt_id,
                )
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
            execution_count = len(session.execute(select(Execution.id)).all())
        assert (claim_state, receipt_state, execution_count) == (
            "submitted",
            "settled",
            1,
        )
    finally:
        drop_schema(schema, admin_engine, schema_engine)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the coordinator closeout test",
)
def test_postgres_unlinked_alpaca_closeout_settles_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "submit_closeout"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    request_payload = {
        "symbol": "AAPL",
        "side": "sell",
        "qty": Decimal("1"),
        "order_type": "limit",
        "time_in_force": "day",
        "limit_price": Decimal("100"),
        "stop_price": None,
        "extra_params": {"client_order_id": "closeout-postgres-1"},
    }
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0061_linked_submission_terminal")
        command.stamp(alembic, "0065_strategy_capital_compat")
        command.upgrade(alembic, "0066_broker_submit_coordinator")
        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation="submit_order",
                risk_class="risk_reducing",
                purpose="closeout",
                workflow_id="closeout-postgres-1",
                client_request_id="closeout-postgres-1",
                target=BrokerMutationTarget(
                    kind="order",
                    key="closeout-postgres-1",
                ),
                request_payload=request_payload,
            )
        )
        coordinator = BrokerMutationSubmitCoordinator("alpaca-closeout-pg")
        broker_calls = 0

        def broker_call(permit: BrokerMutationIoPermit) -> Mapping[str, object]:
            nonlocal broker_calls
            consume_broker_mutation_io_permit(
                permit,
                expectation=BrokerMutationIoPermitExpectation(
                    broker_route="alpaca",
                    operation="submit_order",
                    risk_class="risk_reducing",
                    account_label="paper",
                    endpoint_fingerprint="a" * 64,
                    request_payload=request_payload,
                ),
            )
            broker_calls += 1
            return {"id": "closeout-order-postgres-1", "status": "accepted"}

        def settlement(result: Mapping[str, object]) -> BrokerMutationSettlement:
            return build_broker_mutation_settlement(
                BrokerMutationSettlementRequest(
                    source="primary",
                    outcome="acknowledged",
                    broker_reference=str(result["id"]),
                    execution_id=None,
                    evidence_payload={"status": result["status"]},
                )
            )

        with sessions() as session:
            coordinator.submit_unlinked_order(
                session,
                intent=intent,
                callbacks=UnlinkedOrderSubmissionCallbacks(
                    broker_call=broker_call,
                    persist_terminal=lambda _result: None,
                    build_settlement=settlement,
                ),
            )
        with (
            sessions() as session,
            pytest.raises(BrokerMutationSubmissionAlreadyProcessed),
        ):
            coordinator.submit_unlinked_order(
                session,
                intent=intent,
                callbacks=UnlinkedOrderSubmissionCallbacks(
                    broker_call=broker_call,
                    persist_terminal=lambda _result: None,
                    build_settlement=settlement,
                ),
            )

        with sessions() as session:
            receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
            latest = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
        assert broker_calls == 1
        assert receipt.submission_claim_id is None
        assert (receipt.broker_route, receipt.risk_class, receipt.purpose) == (
            "alpaca",
            "risk_reducing",
            "closeout",
        )
        assert (latest.state, latest.settlement_outcome) == (
            "settled",
            "acknowledged",
        )
    finally:
        drop_schema(schema, admin_engine, schema_engine)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the validation-permit race test",
)
def test_postgres_validation_permit_race_makes_one_non_promotable_broker_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_submit"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    now = datetime.now(timezone.utc)
    permit, plan = _validation_fixture(now)
    request = InfrastructureValidationOrderSubmission(
        permit=permit,
        plan=plan,
        account_label=permit.account_label,
        endpoint_url="https://paper-api.alpaca.markets",
    )
    request_payload = infrastructure_validation_request_payload(permit, plan)
    broker_started = Event()
    release_broker = Event()
    broker_call_lock = Lock()
    broker_calls = 0

    def broker_call(permit_to_consume: BrokerMutationIoPermit) -> Mapping[str, object]:
        nonlocal broker_calls
        consume_broker_mutation_io_permit(
            permit_to_consume,
            expectation=BrokerMutationIoPermitExpectation(
                broker_route="alpaca",
                operation="submit_order",
                risk_class="risk_neutral",
                account_label=permit.account_label,
                endpoint_fingerprint=permit_to_consume.endpoint_fingerprint,
                request_payload=request_payload,
            ),
        )
        with broker_call_lock:
            broker_calls += 1
        broker_started.set()
        assert release_broker.wait(timeout=10)
        return {"id": "validation-order-1", "status": "canceled"}

    callbacks = UnlinkedOrderSubmissionCallbacks(
        broker_call=broker_call,
        persist_terminal=lambda _result: None,
        build_settlement=_validation_settlement,
    )

    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        _upgrade_validation_submit_schema(alembic, schema_engine)

        def run(component: str) -> str:
            with sessions() as session:
                try:
                    BrokerMutationSubmitCoordinator(
                        component
                    ).submit_infrastructure_validation_order(
                        session,
                        request=request,
                        callbacks=callbacks,
                        now=now,
                    )
                except BrokerMutationSubmissionAlreadyProcessed:
                    return "already_processed"
                except BrokerMutationSubmissionDeferred:
                    return "deferred"
            return "submitted"

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(run, "validation-a")
            assert broker_started.wait(timeout=10)
            second = executor.submit(run, "validation-b")
            assert second.result(timeout=10) == "deferred"
            release_broker.set()
            assert first.result(timeout=15) == "submitted"

        with (
            sessions() as session,
            pytest.raises(BrokerMutationSubmissionAlreadyProcessed),
        ):
            BrokerMutationSubmitCoordinator(
                "validation-replay"
            ).submit_infrastructure_validation_order(
                session,
                request=request,
                callbacks=callbacks,
                now=now,
            )

        with sessions() as session:
            receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
            latest = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
        intent_payload = json.loads(receipt.canonical_intent_json)
        validation = intent_payload["request"]["infrastructure_validation"]
        assert broker_calls == 1
        assert (
            receipt.risk_class,
            receipt.purpose,
            receipt.submission_claim_id,
        ) == ("risk_neutral", "control_plane_validation", None)
        assert validation["permit"]["evidence_tag"] == "non_promotable_validation"
        assert validation["permit"]["promotable"] is False
        assert (latest.state, latest.settlement_outcome) == (
            "settled",
            "acknowledged",
        )

        reused_permit, reused_plan = _validation_fixture(
            now,
            permit_id=permit.permit_id,
            symbol="ETH/USD",
        )
        with sessions() as session, pytest.raises(BrokerMutationSubmissionDeferred):
            BrokerMutationSubmitCoordinator(
                "validation-reuse"
            ).submit_infrastructure_validation_order(
                session,
                request=InfrastructureValidationOrderSubmission(
                    permit=reused_permit,
                    plan=reused_plan,
                    account_label=reused_permit.account_label,
                    endpoint_url="https://paper-api.alpaca.markets",
                ),
                callbacks=callbacks,
                now=now,
            )
        assert broker_calls == 1
    finally:
        release_broker.set()
        drop_schema(schema, admin_engine, schema_engine)


def test_control_plane_validation_cannot_use_generic_unlinked_entrypoint() -> None:
    now = datetime.now(timezone.utc)
    permit, plan = _validation_fixture(now)
    request_payload = infrastructure_validation_request_payload(permit, plan)
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label=permit.account_label,
            endpoint_fingerprint=fingerprint_broker_endpoint(
                "https://paper-api.alpaca.markets"
            ),
            operation="submit_order",
            risk_class="risk_neutral",
            purpose="control_plane_validation",
            workflow_id="generic-bypass",
            client_request_id="generic-bypass",
            target=BrokerMutationTarget(kind="order", key="generic-bypass"),
            request_payload=request_payload,
        )
    )

    with pytest.raises(
        BrokerMutationSubmissionRejected,
        match="requires_dedicated_submit_authority",
    ):
        BrokerMutationSubmitCoordinator("validation-bypass").submit_unlinked_order(
            cast(Session, object()),
            intent=intent,
            callbacks=UnlinkedOrderSubmissionCallbacks(
                broker_call=lambda _permit: {},
                persist_terminal=lambda _result: None,
                build_settlement=_validation_settlement,
            ),
        )


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for validation authority constraints",
)
def test_postgres_validation_authority_rejects_forged_or_incomplete_intents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_authority"
    )
    now = datetime.now(timezone.utc)
    permit, plan = _validation_fixture(now, permit_id="ivp-authority-test")
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label=permit.account_label,
            endpoint_fingerprint="a" * 64,
            operation="submit_order",
            risk_class="risk_neutral",
            purpose="control_plane_validation",
            workflow_id=client_order_id,
            client_request_id=client_order_id,
            target=BrokerMutationTarget(kind="order", key=client_order_id),
            request_payload=infrastructure_validation_request_payload(permit, plan),
        )
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        _upgrade_validation_submit_schema(alembic, schema_engine)

        base_document = json.loads(intent.canonical_intent_json)
        forged_documents: list[dict[str, object]] = []
        promotable = json.loads(json.dumps(base_document))
        promotable["request"]["infrastructure_validation"]["permit"]["promotable"] = (
            True
        )
        forged_documents.append(promotable)
        wide = json.loads(json.dumps(base_document))
        wide["request"]["infrastructure_validation"]["permit"]["max_notional_usd"] = "2"
        forged_documents.append(wide)
        wrong_side = json.loads(json.dumps(base_document))
        wrong_side["request"]["broker_request"]["side"] = "sell"
        forged_documents.append(wrong_side)
        incomplete = json.loads(json.dumps(base_document))
        del incomplete["request"]["infrastructure_validation"]
        forged_documents.append(incomplete)

        for document in forged_documents:
            canonical_json = json.dumps(
                document,
                sort_keys=True,
                separators=(",", ":"),
            )
            with pytest.raises(IntegrityError) as captured:
                with schema_engine.begin() as connection:
                    connection.execute(
                        text(
                            """
                            INSERT INTO broker_mutation_receipts (
                                id, broker_route, account_label,
                                endpoint_fingerprint, operation, risk_class,
                                purpose, submission_claim_id, workflow_id,
                                client_request_id, target_kind, target_key,
                                intent_schema_version, canonical_intent_json,
                                canonical_intent_sha256, creator_owner,
                                origin_writer_generation
                            ) VALUES (
                                :id, 'alpaca', :account_label,
                                :endpoint_fingerprint, 'submit_order',
                                'risk_neutral', 'control_plane_validation',
                                NULL, :client_order_id, :client_order_id,
                                'order', :client_order_id,
                                'torghut.broker-mutation-intent.v1',
                                :canonical_intent_json,
                                :canonical_intent_sha256,
                                'validation-authority-test', 1
                            )
                            """
                        ),
                        {
                            "id": uuid.uuid4(),
                            "account_label": permit.account_label,
                            "endpoint_fingerprint": intent.endpoint_fingerprint,
                            "client_order_id": client_order_id,
                            "canonical_intent_json": canonical_json,
                            "canonical_intent_sha256": hashlib.sha256(
                                canonical_json.encode("utf-8")
                            ).hexdigest(),
                        },
                    )
            assert (
                captured.value.orig.diag.constraint_name
                == "ck_bm_receipt_validation_authority"
            )

        with schema_engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT count(*) FROM broker_mutation_receipts"))
                == 0
            )
    finally:
        drop_schema(schema, admin_engine, schema_engine)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the deployed validation runner test",
)
def test_postgres_validation_runner_proves_known_null_terminal_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "validation_runner"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    now = datetime.now(timezone.utc)
    permit, plan = _validation_fixture(now, permit_id="ivp-runner-one")
    client = _FakeValidationAlpacaClient()
    observed_authorization_times: list[datetime] = []

    def recording_authorize(
        permit_to_authorize: InfrastructureValidationPermit,
        plan_to_authorize: InfrastructureValidationOrderPlan,
        *,
        account_label: str,
        broker_base_url: str,
        now: datetime,
    ) -> InfrastructureValidationPermit:
        observed_authorization_times.append(now)
        return authorize_infrastructure_validation_order(
            permit_to_authorize,
            plan_to_authorize,
            account_label=account_label,
            broker_base_url=broker_base_url,
            now=now,
        )

    try:
        for module in (
            validation_submit_module,
            submit_coordinator_module,
            firewall_module,
        ):
            monkeypatch.setattr(
                module,
                "authorize_infrastructure_validation_order",
                recording_authorize,
            )
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        monkeypatch.setattr(settings, "trading_kill_switch_enabled", False)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        _upgrade_validation_submit_schema(alembic, schema_engine)
        with schema_engine.begin() as connection:
            connection.execute(
                text(
                    """
                    CREATE TABLE execution_order_events (
                        id UUID PRIMARY KEY,
                        client_order_id VARCHAR(128),
                        execution_id UUID,
                        trade_decision_id UUID,
                        raw_event JSONB NOT NULL
                    );
                    CREATE TABLE tigerbeetle_transfer_refs (
                        execution_order_event_id UUID
                    )
                    """
                )
            )

        report = run_infrastructure_validation_submit(
            permit=permit,
            plan=plan,
            context=InfrastructureValidationSubmitContext(
                client=client,
                session_factory=sessions,
                configured_account_label=permit.account_label,
                evaluated_at=now,
            ),
        )

        assert report.broker_call_count == 1
        assert sorted(report.race_outcomes) == ["deferred", "submitted"]
        assert report.replay_outcome == "already_processed"
        assert report.receipt_count == 1
        assert report.receipt_state == "settled"
        assert report.submission_claim_count == 0
        assert report.execution_count == 0
        assert report.trade_decision_count == 0
        assert report.order_event_count == 0
        assert report.linked_order_event_count == 0
        assert report.tigerbeetle_transfer_ref_count == 0
        assert report.broker_account_number == permit.account_label
        assert report.terminal_position_count == 0
        assert report.terminal_open_order_count == 0
        assert report.evidence_tag == "non_promotable_validation"
        assert report.promotable is False
        assert len(client.submissions) == 1
        assert observed_authorization_times == [now] * 6
    finally:
        drop_schema(schema, admin_engine, schema_engine)


class _FakeValidationAlpacaClient:
    endpoint_class = "paper"
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.submissions: list[dict[str, object]] = []

    def get_account(self) -> dict[str, object]:
        return {
            "account_number": "dedicated-validation-paper",
            "status": "ACTIVE",
            "crypto_status": "ACTIVE",
            "account_blocked": False,
            "trading_blocked": False,
            "trade_suspended_by_user": False,
        }

    def get_asset(self, _symbol: str) -> dict[str, object]:
        return {"asset_class": "crypto", "status": "active", "tradable": True}

    def get_order_by_client_order_id_strict(
        self,
        client_order_id: str,
    ) -> dict[str, object] | None:
        return next(
            (
                order
                for order in self.submissions
                if order.get("client_order_id") == client_order_id
            ),
            None,
        )

    def list_open_orders(self) -> list[dict[str, object]]:
        return []

    def list_positions(self) -> list[dict[str, object]]:
        return []

    def submit_order(
        self,
        *,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, object] | None = None,
        firewall_token: object | None = None,
    ) -> dict[str, object]:
        del qty, limit_price, stop_price, firewall_token
        order = {
            "id": "validation-paper-order-1",
            "client_order_id": str((extra_params or {})["client_order_id"]),
            "status": "canceled",
            "filled_qty": "0",
            "symbol": symbol,
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
        }
        self.submissions.append(order)
        return order


def _validation_fixture(
    now: datetime,
    *,
    permit_id: str = "ivp-postgres-one",
    symbol: str = "BTC/USD",
) -> tuple[InfrastructureValidationPermit, InfrastructureValidationOrderPlan]:
    plan = InfrastructureValidationOrderPlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-order-plan.v1",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": symbol,
            "side": "buy",
            "qty": "1",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "1",
            "stop_price": None,
        }
    )
    return (
        InfrastructureValidationPermit.model_validate(
            {
                "schema_version": "torghut.infrastructure-validation-permit.v2",
                "permit_id": permit_id,
                "purpose": "control_plane_validation",
                "venue": "alpaca",
                "asset_class": "crypto",
                "account_mode": "paper",
                "market_session": "continuous",
                "account_label": "dedicated-validation-paper",
                "broker_base_url": "https://paper-api.alpaca.markets",
                "symbols": [symbol],
                "sides": ["buy"],
                "order_types": ["limit"],
                "max_orders": 1,
                "max_outstanding_intents": 1,
                "max_notional_usd": "1",
                "max_loss_usd": "1",
                "issued_by": "infrastructure-owner",
                "approved_by": "independent-infrastructure-owner",
                "issued_at": now - timedelta(seconds=1),
                "expires_at": now + timedelta(minutes=5),
                "test_plan_digest": infrastructure_validation_order_plan_sha256(plan),
                "expected_terminal_state": "no_open_orders_no_positions_no_unsettled_claims",
                "expected_terminal_state_digest": infrastructure_validation_terminal_state_sha256(),
                "evidence_tag": "non_promotable_validation",
                "promotable": False,
            }
        ),
        plan,
    )


def _validation_settlement(
    result: Mapping[str, object],
) -> BrokerMutationSettlement:
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference=str(result.get("id") or "validation-rejected"),
            execution_id=None,
            evidence_payload={
                "schema_version": "torghut.infrastructure-validation-submit-terminal.v1",
                "evidence_tag": "non_promotable_validation",
                "promotable": False,
                "broker_status": str(result.get("status") or "unknown"),
            },
        )
    )


def _persist_execution(
    session: Session,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    response: Mapping[str, object],
) -> Execution:
    execution_id = uuid.uuid4()
    broker_order_id = str(response["id"])
    session.execute(
        text(
            """
            INSERT INTO executions (
                id, trade_decision_id, alpaca_account_label,
                client_order_id, alpaca_order_id, status
            ) VALUES (
                :id, :decision_id, 'paper',
                :client_order_id, :broker_order_id, 'accepted'
            )
            """
        ),
        {
            "id": execution_id,
            "decision_id": decision_id,
            "client_order_id": client_order_id,
            "broker_order_id": broker_order_id,
        },
    )
    return Execution(
        id=execution_id,
        trade_decision_id=decision_id,
        alpaca_account_label="paper",
        alpaca_order_id=broker_order_id,
        client_order_id=client_order_id,
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("0"),
        status="accepted",
    )
