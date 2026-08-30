from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.models import Base, BrokerMutationReceipt, BrokerMutationReceiptEvent
from app.trading.broker_mutation_coordinator import (
    BrokerMutationCoordinator,
    BrokerMutationDeferred,
    BrokerMutationUnresolved,
    InfrastructureValidationOrderSubmission,
    UnlinkedMutationCallbacks,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationReceiptValidationError,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
)
from app.trading.alpaca_reduction_mutations import AlpacaReductionMutationExecutor
from app.trading.execution_adapters import AlpacaExecutionAdapter, OrderSubmission
from app.trading.firewall import OrderFirewall
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_client_order_id,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_records import (
    load_infrastructure_validation_evidence,
)


class _CloseoutBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.close_calls = 0
        self.close_targets: list[str] = []
        self.positions: list[dict[str, object]] = [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": "100",
            }
        ]

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def close_position(
        self,
        symbol_or_asset_id: str,
        **_kwargs: object,
    ) -> dict[str, object]:
        self.close_calls += 1
        self.close_targets.append(symbol_or_asset_id)
        self.positions = []
        return {"id": "closeout-order-1", "status": "accepted"}


class _CloseAllBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self, responses: list[dict[str, object]]) -> None:
        self.close_calls = 0
        self.responses = responses
        self.positions: list[dict[str, object]] = [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": "100",
            },
            {
                "symbol": "MSFT",
                "qty": "2",
                "side": "short",
                "market_value": "-200",
            },
        ]

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def close_all_positions(self, **_kwargs: object) -> list[dict[str, object]]:
        self.close_calls += 1
        return list(self.responses)


class _UnchangedCloseBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.close_calls = 0
        self.market_value = Decimal("100")

    def list_positions(self) -> list[dict[str, object]]:
        return [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": str(self.market_value),
            }
        ]

    def close_position(self, *_args: object, **_kwargs: object) -> dict[str, object]:
        self.close_calls += 1
        return {"id": "closeout-order-1", "status": "accepted"}


class _ReplaceBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(
        self,
        *,
        side: str = "buy",
        symbol: str = "AAPL",
        client_order_id: str = "client-order-1",
        order_id: str = "order-1",
    ) -> None:
        self.side = side
        self.symbol = symbol
        self.client_order_id = client_order_id
        self.order_id = order_id
        self.replace_calls: list[tuple[str, float]] = []
        self.positions: list[dict[str, object]] = []

    def get_order_by_id_strict(self, order_id: str) -> dict[str, object]:
        return {
            "id": order_id,
            "client_order_id": self.client_order_id,
            "symbol": self.symbol,
            "side": self.side,
            "qty": "10",
            "filled_qty": "4",
            "status": "partially_filled",
            "limit_price": "200",
        }

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def replace_order(
        self,
        order_id: str,
        *,
        limit_price: float,
        **_kwargs: object,
    ) -> dict[str, object]:
        self.replace_calls.append((order_id, limit_price))
        return {"id": "replacement-1", "status": "accepted"}


class _ReferenceLessReplaceBroker(_ReplaceBroker):
    def replace_order(
        self,
        order_id: str,
        *,
        limit_price: float,
        **_kwargs: object,
    ) -> dict[str, object]:
        self.replace_calls.append((order_id, limit_price))
        return {"status": "accepted"}


class _CancelBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self, *, client_order_id: str, order_id: str) -> None:
        self.client_order_id = client_order_id
        self.order_id = order_id
        self.cancel_calls: list[str] = []

    def get_order_by_id_strict(self, order_id: str) -> dict[str, object]:
        return {
            "id": order_id,
            "client_order_id": self.client_order_id,
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "1",
            "filled_qty": "0",
            "status": "new",
            "limit_price": "1",
        }

    def cancel_order(self, order_id: str, **_kwargs: object) -> bool:
        self.cancel_calls.append(order_id)
        return True


class _CancelAllBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(
        self,
        orders: list[dict[str, object]],
        *,
        responses: list[dict[str, object]] | None = None,
    ) -> None:
        self.orders = orders
        self.responses = list(responses or [])
        self.cancel_all_calls = 0

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        del status, limit
        return list(self.orders)

    def cancel_all_orders(self, **_kwargs: object) -> list[dict[str, object]]:
        self.cancel_all_calls += 1
        return list(self.responses)


class _CryptoCloseOrderBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.submit_calls: list[dict[str, object]] = []
        self.positions = [
            {
                "symbol": "BTC/USD",
                "qty": "0.00004",
                "side": "long",
                "market_value": "4",
            }
        ]

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        del status, limit
        return []

    def submit_order(self, **kwargs: object) -> dict[str, object]:
        kwargs.pop("firewall_token", None)
        self.submit_calls.append(dict(kwargs))
        return {
            "client_order_id": kwargs["extra_params"]["client_order_id"],
            "id": "crypto-close-order-1",
            "status": "accepted",
        }


@pytest.fixture
def sessions() -> Iterator[sessionmaker[Session]]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        yield factory
    finally:
        engine.dispose()


def _seed_validation_root(
    sessions: sessionmaker[Session],
    *,
    broker_order_id: str = "validation-order-1",
    settlement_outcome: str = "acknowledged",
) -> tuple[str, BrokerMutationReceipt]:
    now = datetime.now(timezone.utc)
    plan = InfrastructureValidationOrderPlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-order-plan.v1",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "1",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "1",
            "stop_price": None,
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-permit.v2",
            "permit_id": f"ivp-lineage-{broker_order_id}",
            "purpose": "control_plane_validation",
            "venue": "alpaca",
            "asset_class": "crypto",
            "account_mode": "paper",
            "market_session": "continuous",
            "account_label": "paper",
            "broker_base_url": "https://paper-api.alpaca.markets",
            "symbols": ["BTC/USD"],
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
    )
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    with sessions() as session:
        BrokerMutationCoordinator(
            "validation-lineage-test"
        ).submit_infrastructure_validation_order(
            session,
            request=InfrastructureValidationOrderSubmission(
                permit=permit,
                plan=plan,
                account_label="paper",
                endpoint_url="https://paper-api.alpaca.markets",
            ),
            callbacks=UnlinkedMutationCallbacks(
                broker_call=lambda _permit: {
                    "id": broker_order_id,
                    "status": "accepted",
                },
                persist_terminal=lambda _result: None,
                build_settlement=lambda result: build_broker_mutation_settlement(
                    BrokerMutationSettlementRequest(
                        source="primary",
                        outcome=settlement_outcome,
                        broker_reference=str(result["id"]),
                        execution_id=None,
                        evidence_payload={
                            "evidence_tag": "non_promotable_validation",
                            "promotable": False,
                            "status": result["status"],
                        },
                    )
                ),
            ),
            now=now,
        )
        root = session.execute(
            select(BrokerMutationReceipt).where(
                BrokerMutationReceipt.client_request_id == client_order_id
            )
        ).scalar_one()
        session.expunge(root)
    return client_order_id, root


def test_broker_enforced_close_is_receipted_and_preflight_deduplicated(
    sessions: sessionmaker[Session],
) -> None:
    broker = _CloseoutBroker()
    broker.positions = [
        {
            "asset_class": "crypto",
            "market_value": "28",
            "qty": "0.00044",
            "side": "long",
            "symbol": "BTCUSD",
        }
    ]
    firewall = OrderFirewall(broker, account_label="paper")
    adapter = AlpacaExecutionAdapter(
        firewall=firewall,
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )
    with patch.object(settings, "trading_kill_switch_enabled", False):
        with pytest.raises(RuntimeError, match="requires_durable_order_firewall"):
            adapter.submit_order(
                OrderSubmission("AAPL", "sell", 1.0, "limit", "day", 100.0, None, None)
            )
        result = adapter.close_position("BTC/USD", Decimal("0.00022"))
        duplicate = adapter.close_position("BTC/USD", Decimal("0.00022"))

    assert result["id"] == "closeout-order-1"
    assert duplicate["status"] == "already_satisfied"
    assert broker.close_calls == 1
    assert broker.close_targets == ["BTCUSD"]
    with sessions() as session:
        receipts = (
            session.execute(
                select(BrokerMutationReceipt).order_by(BrokerMutationReceipt.created_at)
            )
            .scalars()
            .all()
        )
        assert len(receipts) == 2
        receipt = receipts[0]
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        assert receipt.broker_route == "alpaca"
        assert receipt.operation == "close_position"
        assert receipt.risk_class == "risk_reducing"
        assert receipt.purpose == "closeout"
        assert receipt.submission_claim_id is None
        assert receipt.target_key == "BTC/USD"
        request = json.loads(receipt.canonical_intent_json)["request"]
        assert request["symbol"] == "BTC/USD"
        assert request["broker_symbol"] == "BTCUSD"
        assert latest.state == "settled"
        assert latest.settlement_outcome == "acknowledged"


def test_mark_price_change_cannot_create_a_second_identical_close(
    sessions: sessionmaker[Session],
) -> None:
    broker = _UnchangedCloseBroker()
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    adapter.close_position("AAPL", Decimal("1"))
    broker.market_value = Decimal("101")
    with pytest.raises(BrokerMutationDeferred, match="receipt_unavailable"):
        adapter.close_position("AAPL", Decimal("1"))

    assert broker.close_calls == 1
    with sessions() as session:
        assert len(session.execute(select(BrokerMutationReceipt.id)).all()) == 1


def test_repricing_uses_complete_observation_and_exact_broker_request(
    sessions: sessionmaker[Session],
) -> None:
    broker = _ReplaceBroker()
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    result = adapter.replace_order("order-1", limit_price=Decimal("190.2500"))

    assert result == {"id": "replacement-1", "status": "accepted"}
    assert broker.replace_calls == [("order-1", 190.25)]
    with sessions() as session:
        receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    assert receipt.operation == "replace_order"
    assert receipt.risk_class == "risk_neutral"
    assert receipt.purpose == "repricing"
    assert (
        json.loads(receipt.canonical_intent_json)["request"]["limit_price"] == "190.25"
    )
    assert latest.state == "settled"
    assert latest.settlement_outcome == "acknowledged"
    with sessions() as session:
        assert (
            load_infrastructure_validation_evidence(
                session,
                account_label="paper",
                client_order_id="client-order-1",
                alpaca_order_id="replacement-1",
            )
            is None
        )


def test_crypto_close_limit_submit_is_fenced_and_available_under_kill_switch(
    sessions: sessionmaker[Session],
) -> None:
    broker = _CryptoCloseOrderBroker()
    executor = AlpacaReductionMutationExecutor(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
        coordinator=BrokerMutationCoordinator("crypto-close-test"),
    )

    with patch.object(settings, "trading_kill_switch_enabled", True):
        result = executor.submit_crypto_close_order(
            "BTC/USD",
            Decimal("0.00004"),
            limit_price=Decimal("125000"),
        )

    assert result["id"] == "crypto-close-order-1"
    assert len(broker.submit_calls) == 1
    with sessions() as session:
        receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    request = json.loads(receipt.canonical_intent_json)["request"]
    assert receipt.operation == "submit_order"
    assert receipt.risk_class == "risk_reducing"
    assert receipt.purpose == "closeout"
    assert receipt.target_key == "BTC/USD"
    assert receipt.client_request_id.startswith("rr-submit-order-")
    assert request["extra_params"] == {"client_order_id": receipt.client_request_id}
    assert request["risk_reduction"]["action"]["type"] == "submit_close_order"
    assert latest.state == "settled"
    assert latest.broker_reference == "crypto-close-order-1"


def test_repricing_without_a_broker_order_reference_remains_unresolved(
    sessions: sessionmaker[Session],
) -> None:
    broker = _ReferenceLessReplaceBroker()
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    with pytest.raises(BrokerMutationUnresolved, match="terminal_unresolved"):
        adapter.replace_order("order-1", limit_price=Decimal("190.25"))

    assert broker.replace_calls == [("order-1", 190.25)]
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    assert latest.state == "broker_io"
    assert latest.settlement_outcome is None


def test_validation_replacement_seals_database_proven_parent_lineage(
    sessions: sessionmaker[Session],
) -> None:
    client_order_id, root = _seed_validation_root(sessions)
    broker = _ReplaceBroker(
        symbol="BTC/USD",
        client_order_id=client_order_id,
        order_id="validation-order-1",
    )
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    result = adapter.replace_order(
        "validation-order-1",
        limit_price=Decimal("0.9"),
    )

    assert result == {"id": "replacement-1", "status": "accepted"}
    with sessions() as session:
        receipt = session.execute(
            select(BrokerMutationReceipt).where(
                BrokerMutationReceipt.operation == "replace_order"
            )
        ).scalar_one()
    lineage = json.loads(receipt.canonical_intent_json)["request"][
        "infrastructure_validation_lineage"
    ]
    assert lineage == {
        "schema_version": "torghut.infrastructure-validation-lineage.v1",
        "root_receipt_id": str(root.id),
        "root_client_order_id": client_order_id,
        "parent_receipt_id": str(root.id),
        "parent_broker_order_id": "validation-order-1",
        "permit_id": "ivp-lineage-validation-order-1",
        "permit_sha256": lineage["permit_sha256"],
        "evidence_tag": "non_promotable_validation",
        "promotable": False,
    }
    assert len(lineage["permit_sha256"]) == 64

    replacement_cancel = _CancelBroker(
        client_order_id="broker-replacement-client",
        order_id="replacement-1",
    )
    replacement_adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(replacement_cancel, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, replacement_cancel),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=replacement_cancel.endpoint_url,
    )
    assert replacement_adapter.cancel_order("replacement-1") is True
    with sessions() as session:
        cancel_receipt = session.execute(
            select(BrokerMutationReceipt).where(
                BrokerMutationReceipt.operation == "cancel_order"
            )
        ).scalar_one()
        cancel_terminal = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == cancel_receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    cancel_lineage = json.loads(cancel_receipt.canonical_intent_json)["request"][
        "infrastructure_validation_lineage"
    ]
    assert cancel_lineage["root_receipt_id"] == str(root.id)
    assert cancel_lineage["parent_receipt_id"] == str(receipt.id)
    assert cancel_lineage["parent_broker_order_id"] == "replacement-1"
    with sessions() as session:
        order_evidence = load_infrastructure_validation_evidence(
            session,
            account_label="paper",
            client_order_id="broker-replacement-client",
            alpaca_order_id="replacement-1",
        )
    assert order_evidence is not None
    assert order_evidence.receipt_id == receipt.id

    cancel_reference = str(cancel_terminal.broker_reference or "")
    assert cancel_reference
    forged_lineage = {
        **cancel_lineage,
        "parent_receipt_id": str(cancel_receipt.id),
        "parent_broker_order_id": cancel_reference,
    }
    forged_intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=receipt.endpoint_fingerprint,
            operation="replace_order",
            risk_class="risk_neutral",
            purpose="repricing",
            workflow_id="forged-cancel-parent",
            client_request_id="forged-cancel-parent",
            target=BrokerMutationTarget(kind="order", key=cancel_reference),
            request_payload={
                "schema_version": "torghut.alpaca-reduction-request.v1",
                "order_id": cancel_reference,
                "limit_price": "0.8",
                "infrastructure_validation_lineage": forged_lineage,
            },
        )
    )
    with sessions() as session:
        BrokerMutationCoordinator("forged-cancel-parent").execute_unlinked_mutation(
            session,
            intent=forged_intent,
            callbacks=UnlinkedMutationCallbacks(
                broker_call=lambda _permit: {
                    "id": "forged-descendant-order",
                    "status": "accepted",
                },
                persist_terminal=lambda _result: None,
                build_settlement=lambda result: build_broker_mutation_settlement(
                    BrokerMutationSettlementRequest(
                        source="primary",
                        outcome="acknowledged",
                        broker_reference=str(result["id"]),
                        execution_id=None,
                        evidence_payload={"status": result["status"]},
                    )
                ),
            ),
        )
    with sessions() as session:
        with pytest.raises(
            RuntimeError,
            match="infrastructure_validation_lineage_parent_mismatch",
        ):
            load_infrastructure_validation_evidence(
                session,
                account_label="paper",
                client_order_id=None,
                alpaca_order_id="forged-descendant-order",
            )


@pytest.mark.parametrize("root_outcome", ("acknowledged", "reconciled"))
def test_validation_cancel_seals_the_same_proven_parent(
    sessions: sessionmaker[Session],
    root_outcome: str,
) -> None:
    client_order_id, root = _seed_validation_root(
        sessions,
        settlement_outcome=root_outcome,
    )
    broker = _CancelBroker(
        client_order_id=client_order_id,
        order_id="validation-order-1",
    )
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    assert adapter.cancel_order("validation-order-1") is True
    assert broker.cancel_calls == ["validation-order-1"]
    with sessions() as session:
        receipt = session.execute(
            select(BrokerMutationReceipt).where(
                BrokerMutationReceipt.operation == "cancel_order"
            )
        ).scalar_one()
    lineage = json.loads(receipt.canonical_intent_json)["request"][
        "infrastructure_validation_lineage"
    ]
    assert lineage["root_receipt_id"] == str(root.id)
    assert lineage["parent_receipt_id"] == str(root.id)
    assert lineage["parent_broker_order_id"] == "validation-order-1"
    assert lineage["promotable"] is False


def test_validation_identity_without_a_terminal_root_fails_before_broker_io(
    sessions: sessionmaker[Session],
) -> None:
    broker = _ReplaceBroker(
        symbol="BTC/USD",
        client_order_id="ivp-" + "a" * 44,
        order_id="validation-order-1",
    )
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_order_lineage_missing",
    ):
        adapter.replace_order("validation-order-1", limit_price=Decimal("0.9"))

    assert broker.replace_calls == []
    with sessions() as session:
        assert (
            session.execute(select(BrokerMutationReceipt)).scalar_one_or_none() is None
        )


def test_validation_evidence_cannot_cross_an_endpoint_scope(
    sessions: sessionmaker[Session],
) -> None:
    client_order_id, _root = _seed_validation_root(sessions)
    with sessions() as session:
        evidence = load_infrastructure_validation_evidence(
            session,
            account_label="paper",
            client_order_id=client_order_id,
        )
    assert evidence is not None
    broker = _CloseoutBroker()
    executor = AlpacaReductionMutationExecutor(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url="https://paper-api.alpaca.markets/other",
        coordinator=BrokerMutationCoordinator("validation-scope-test"),
    )

    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_lineage_scope_mismatch",
    ):
        executor.close_position(
            "AAPL",
            Decimal("1"),
            validation_evidence=evidence,
        )

    assert broker.close_calls == 0
    same_scope = AlpacaReductionMutationExecutor(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
        coordinator=BrokerMutationCoordinator("validation-position-test"),
    )
    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_position_ancestry_missing",
    ):
        same_scope.close_position(
            "BTC/USD",
            Decimal("1"),
            validation_evidence=evidence,
        )
    assert broker.close_calls == 0


def test_cancel_all_preserves_liveness_for_mixed_validation_and_ordinary_orders(
    sessions: sessionmaker[Session],
) -> None:
    client_order_id, _root = _seed_validation_root(sessions)
    replacement_broker = _ReplaceBroker(
        symbol="BTC/USD",
        client_order_id=client_order_id,
        order_id="validation-order-1",
    )
    replacement_adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(replacement_broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, replacement_broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=replacement_broker.endpoint_url,
    )
    replacement_adapter.replace_order(
        "validation-order-1",
        limit_price=Decimal("0.9"),
    )
    broker = _CancelAllBroker(
        [
            {
                "id": "replacement-1",
                "client_order_id": "broker-replacement-client",
                "symbol": "BTC/USD",
                "side": "buy",
                "qty": "1",
                "filled_qty": "0",
                "status": "new",
                "limit_price": "0.9",
            },
            {
                "id": "ordinary-order-1",
                "client_order_id": "ordinary-client-1",
                "symbol": "ETH/USD",
                "side": "buy",
                "qty": "1",
                "filled_qty": "0",
                "status": "new",
                "limit_price": "1",
            },
        ],
        responses=[
            {"id": "replacement-1", "status": 200},
            {"id": "ordinary-order-1", "status": 200},
        ],
    )
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    assert adapter.cancel_all_orders() == [
        {"id": "replacement-1", "status": 200},
        {"id": "ordinary-order-1", "status": 200},
    ]

    assert broker.cancel_all_calls == 1
    with sessions() as session:
        receipts = session.execute(select(BrokerMutationReceipt)).scalars().all()
    assert len(receipts) == 3
    cancel_receipt = next(
        receipt for receipt in receipts if receipt.operation == "cancel_all_orders"
    )
    request = json.loads(cancel_receipt.canonical_intent_json)["request"]
    assert "infrastructure_validation_lineage" not in request


def test_repricing_cannot_cross_an_observed_position(
    sessions: sessionmaker[Session],
) -> None:
    broker = _ReplaceBroker(side="sell")
    broker.positions = [
        {
            "symbol": "AAPL",
            "qty": "5",
            "side": "long",
            "market_value": "1000",
        }
    ]
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="replacement_would_cross_position_zero",
    ):
        adapter.replace_order("order-1", limit_price=Decimal("190.25"))

    assert broker.replace_calls == []
    with sessions() as session:
        assert (
            session.execute(select(BrokerMutationReceipt)).scalar_one_or_none() is None
        )


@pytest.mark.parametrize(
    ("responses", "expected_state", "expected_outcome"),
    [
        ([{"status": 422}, {"status": 500}], "settled", "rejected"),
        (
            [
                {"order_id": "close-aapl", "status": 200},
                {"order_id": "close-msft", "status": 200},
            ],
            "settled",
            "acknowledged",
        ),
        (
            [{"order_id": "close-aapl", "status": 200}, {"status": 422}],
            "broker_io",
            None,
        ),
        ([], "broker_io", None),
    ],
)
def test_close_all_settlement_reflects_every_broker_response(
    sessions: sessionmaker[Session],
    responses: list[dict[str, object]],
    expected_state: str,
    expected_outcome: str | None,
) -> None:
    broker = _CloseAllBroker(responses)
    firewall = OrderFirewall(broker, account_label="paper")
    adapter = AlpacaExecutionAdapter(
        firewall=firewall,
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    if expected_state == "settled":
        assert adapter.close_all_positions() == responses
    else:
        with pytest.raises(BrokerMutationUnresolved, match="terminal_unresolved"):
            adapter.close_all_positions()

    assert broker.close_calls == 1
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    assert latest.state == expected_state
    assert latest.settlement_outcome == expected_outcome
