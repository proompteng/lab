from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models import Execution, TradeDecision
from app.trading.broker_mutation_receipts import BrokerMutationReceiptSnapshot
from app.trading.broker_mutation_coordinator import BrokerMutationDeferred
from app.trading.execution import OrderExecutor
from app.trading.execution import durable_existing_order_recovery as durable_recovery
from app.trading.execution.durable_existing_order_recovery import (
    DurableExistingOrderRecoveryRequest,
    DurableExistingOrderRecoveryResult,
    recover_durable_linked_existing_order,
)
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision


class _ExistingOrderClient:
    def __init__(self, client_order_id: str) -> None:
        self.lookup_calls = 0
        self._order = {
            "id": "existing-linked-order",
            "client_order_id": client_order_id,
            "symbol": "AAPL",
            "side": "buy",
            "qty": "1",
            "type": "market",
            "time_in_force": "day",
            "limit_price": None,
            "stop_price": None,
            "status": "accepted",
        }

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, object] | None:
        self.lookup_calls += 1
        if client_order_id != self._order["client_order_id"]:
            return None
        return dict(self._order)


def _recovery_firewall() -> OrderFirewall:
    return cast(
        OrderFirewall,
        SimpleNamespace(
            broker_endpoint_url="https://paper-api.alpaca.markets",
        ),
    )


def _durable_recovery_request(
    session: Session,
    decision_row: TradeDecision,
    *,
    existing_orders: tuple[dict[str, object], ...],
) -> DurableExistingOrderRecoveryRequest:
    return DurableExistingOrderRecoveryRequest(
        executor=OrderExecutor(),
        session=session,
        firewall=_recovery_firewall(),
        decision_row=decision_row,
        account_label="paper",
        existing_orders=existing_orders,
    )


def test_existing_order_without_durable_receipt_uses_legacy_fallback() -> None:
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="a" * 64,
            alpaca_account_label="paper",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.return_value.scalar_one_or_none.return_value = None

    result = recover_durable_linked_existing_order(
        _durable_recovery_request(
            session,
            decision_row,
            existing_orders=({"id": "legacy-order"},),
        )
    )

    assert not result.handled
    assert result.execution is None
    assert session.rollback.call_count == 2


def test_durable_recovery_rejects_ambiguous_existing_order_count() -> None:
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="b" * 64,
            alpaca_account_label="paper",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.return_value.scalar_one_or_none.return_value = uuid.uuid4()

    with pytest.raises(
        RuntimeError,
        match="linked_submission_recovery_existing_order_count_invalid:.*:0",
    ):
        recover_durable_linked_existing_order(
            _durable_recovery_request(session, decision_row, existing_orders=())
        )

    session.rollback.assert_called_once_with()


def test_existing_order_path_uses_durable_recovery_before_legacy_backfill() -> None:
    client_order_id = "d" * 64
    decision = StrategyDecision(
        strategy_id=str(uuid.uuid4()),
        symbol="AAPL",
        event_ts=datetime(2026, 7, 15, 6, 0, tzinfo=timezone.utc),
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
    )
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash=client_order_id,
            alpaca_account_label="paper",
        ),
    )
    session = MagicMock(spec=Session)
    client = _ExistingOrderClient(client_order_id)
    firewall = OrderFirewall(cast(object, client), account_label="paper")
    executor = OrderExecutor()
    recovered_execution = cast(
        Execution,
        SimpleNamespace(id=uuid.uuid4(), status="accepted"),
    )

    with (
        patch(
            "app.trading.execution.order_executor_core_methods.durable_recovery."
            "recover_durable_linked_existing_order",
            return_value=DurableExistingOrderRecoveryResult(
                handled=True,
                execution=recovered_execution,
            ),
        ) as recover,
        patch.object(executor, "_sync_execution_payload") as legacy_backfill,
    ):
        handled, execution = executor._sync_existing_order_if_present(
            session=session,
            execution_client=firewall,
            decision=decision,
            decision_row=decision_row,
            account_label="paper",
            execution_expected_adapter="alpaca",
            execution_policy_context={},
        )

    assert handled
    assert execution is recovered_execution
    assert client.lookup_calls == 1
    recover.assert_called_once()
    assert recover.call_args.args == (
        DurableExistingOrderRecoveryRequest(
            executor=executor,
            session=session,
            firewall=firewall,
            decision_row=decision_row,
            account_label="paper",
            existing_orders=[client._order],
        ),
    )
    legacy_backfill.assert_not_called()


def test_legacy_backfill_prefers_filled_attempt_over_later_terminal_retry() -> None:
    decision = StrategyDecision(
        strategy_id=str(uuid.uuid4()),
        symbol="AAPL",
        event_ts=datetime(2026, 7, 15, 6, 10, tzinfo=timezone.utc),
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
    )
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="5" * 64,
            alpaca_account_label="paper",
        ),
    )
    partial_execution = cast(
        Execution,
        SimpleNamespace(
            id=uuid.uuid4(), status="partially_filled", filled_qty=Decimal("0.4")
        ),
    )
    canceled_execution = cast(
        Execution,
        SimpleNamespace(id=uuid.uuid4(), status="canceled", filled_qty=Decimal("0")),
    )
    session = MagicMock(spec=Session)
    executor = OrderExecutor()
    existing_orders = [
        {"id": "base-order", "filled_qty": "0.4", "status": "partially_filled"},
        {"id": "retry-order", "filled_qty": "0", "status": "canceled"},
    ]

    with (
        patch(
            "app.trading.execution.order_executor_core_methods.fetch_existing_orders",
            return_value=existing_orders,
        ),
        patch.object(
            executor,
            "_sync_execution_payload",
            side_effect=(partial_execution, canceled_execution),
        ),
        patch(
            "app.trading.execution.order_executor_core_methods."
            "_order_payload_with_execution_metadata",
            side_effect=lambda order, *_args, **_kwargs: order,
        ),
        patch(
            "app.trading.execution.order_executor_core_methods."
            "_attach_execution_policy_context"
        ),
        patch(
            "app.trading.execution.order_executor_core_methods."
            "upsert_execution_tca_metric"
        ),
        patch(
            "app.trading.execution.order_executor_core_methods._apply_execution_status"
        ),
    ):
        handled, execution = executor._sync_existing_order_if_present(
            session=session,
            execution_client=object(),
            decision=decision,
            decision_row=decision_row,
            account_label="paper",
            execution_expected_adapter="alpaca",
            execution_policy_context={},
        )

    assert handled
    assert execution is partial_execution
    session.commit.assert_called_once_with()


def test_submit_order_returns_recovered_terminal_execution() -> None:
    decision = StrategyDecision(
        strategy_id=str(uuid.uuid4()),
        symbol="AAPL",
        event_ts=datetime(2026, 7, 15, 6, 15, tzinfo=timezone.utc),
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
    )
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="e" * 64,
            alpaca_account_label="paper",
            decision_json={},
            status="planned",
        ),
    )
    terminal_execution = cast(
        Execution,
        SimpleNamespace(id=uuid.uuid4(), status="canceled", filled_qty=Decimal("0")),
    )
    session = MagicMock(spec=Session)
    executor = OrderExecutor()

    with (
        patch.object(executor, "_fetch_execution", return_value=None),
        patch.object(
            executor,
            "_sync_existing_order_if_present",
            return_value=(True, terminal_execution),
        ),
    ):
        result = executor.submit_order(
            session,
            object(),
            decision,
            decision_row,
            "paper",
        )

    assert result is terminal_execution


def test_settled_rejected_receipt_restores_rejected_decision_state() -> None:
    decision_id = uuid.uuid4()
    client_order_id = "e" * 64
    receipt_id = uuid.uuid4()
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=decision_id,
            decision_hash=client_order_id,
            alpaca_account_label="paper",
            decision_json={},
            status="planned",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.return_value.scalar_one_or_none.return_value = receipt_id
    settled_receipt = cast(
        BrokerMutationReceiptSnapshot,
        SimpleNamespace(
            state="settled",
            settlement=SimpleNamespace(outcome="rejected"),
        ),
    )

    with patch(
        "app.trading.execution.durable_existing_order_recovery."
        "get_broker_mutation_receipt",
        return_value=settled_receipt,
    ):
        result = recover_durable_linked_existing_order(
            DurableExistingOrderRecoveryRequest(
                executor=OrderExecutor(),
                session=session,
                firewall=_recovery_firewall(),
                decision_row=decision_row,
                account_label="paper",
                existing_orders=({"id": "rejected-order"},),
            )
        )

    assert result.handled
    assert result.execution is None
    assert decision_row.status == "rejected"
    assert decision_row.decision_json["submission_stage"] == "rejected"
    assert decision_row.decision_json["risk_reasons"] == ["broker_rejected"]
    assert decision_row.decision_json["reject_reason_atomic"] == ["broker_rejected"]
    assert decision_row.decision_json["reject_class"] == "runtime"
    assert decision_row.decision_json["reject_origin"] == "scheduler"
    session.add.assert_called_once_with(decision_row)
    session.commit.assert_called_once_with()


def test_existing_order_path_propagates_deferred_recovery_lease() -> None:
    client_order_id = "f" * 64
    receipt_id = uuid.uuid4()
    decision = StrategyDecision(
        strategy_id=str(uuid.uuid4()),
        symbol="AAPL",
        event_ts=datetime(2026, 7, 15, 6, 30, tzinfo=timezone.utc),
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
    )
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash=client_order_id,
            alpaca_account_label="paper",
            decision_json={},
            status="planned",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.return_value.scalar_one_or_none.return_value = receipt_id
    client = _ExistingOrderClient(client_order_id)
    firewall = OrderFirewall(cast(object, client), account_label="paper")
    executor = OrderExecutor()
    broker_io_receipt = cast(
        BrokerMutationReceiptSnapshot,
        SimpleNamespace(state="broker_io"),
    )

    with (
        patch(
            "app.trading.execution.durable_existing_order_recovery."
            "get_broker_mutation_receipt",
            return_value=broker_io_receipt,
        ),
        patch(
            "app.trading.execution.durable_existing_order_recovery."
            "acquire_broker_mutation_recovery",
            return_value=SimpleNamespace(
                acquired=False,
                receipt=None,
                outcome="busy",
            ),
        ),
        patch.object(executor, "_sync_execution_payload") as legacy_backfill,
        pytest.raises(
            BrokerMutationDeferred,
            match="linked_submission_existing_order_recovery_deferred:.*:receipt:busy",
        ),
    ):
        executor._sync_existing_order_if_present(
            session=session,
            execution_client=firewall,
            decision=decision,
            decision_row=decision_row,
            account_label="paper",
            execution_expected_adapter="alpaca",
            execution_policy_context={},
        )

    assert client.lookup_calls == 1
    legacy_backfill.assert_not_called()


def test_durable_recovery_rejects_foreign_endpoint_receipt() -> None:
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="c" * 64,
            alpaca_account_label="paper",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.side_effect = (
        SimpleNamespace(scalar_one_or_none=lambda: None),
        SimpleNamespace(scalar_one_or_none=lambda: uuid.uuid4()),
    )

    with pytest.raises(
        RuntimeError,
        match="linked_submission_recovery_endpoint_mismatch",
    ):
        recover_durable_linked_existing_order(
            _durable_recovery_request(
                session,
                decision_row,
                existing_orders=({"id": "foreign-endpoint-order"},),
            )
        )

    assert session.rollback.call_count == 2
    assert "endpoint_fingerprint" in str(session.execute.call_args_list[0].args[0])


def test_durable_recovery_rejects_nonterminal_non_io_receipt() -> None:
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="3" * 64,
            alpaca_account_label="paper",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.return_value.scalar_one_or_none.return_value = uuid.uuid4()
    claimed_receipt = cast(
        BrokerMutationReceiptSnapshot,
        SimpleNamespace(state="claimed"),
    )

    with (
        patch(
            "app.trading.execution.durable_existing_order_recovery."
            "get_broker_mutation_receipt",
            return_value=claimed_receipt,
        ),
        pytest.raises(
            RuntimeError,
            match="linked_submission_existing_order_without_broker_io",
        ),
    ):
        recover_durable_linked_existing_order(
            _durable_recovery_request(
                session,
                decision_row,
                existing_orders=({"id": "claimed-order"},),
            )
        )


def test_settled_reconciled_receipt_loads_recovered_execution() -> None:
    execution_id = uuid.uuid4()
    recovered_execution = cast(
        Execution,
        SimpleNamespace(id=execution_id, status="accepted"),
    )
    decision_row = cast(
        TradeDecision,
        SimpleNamespace(
            id=uuid.uuid4(),
            decision_hash="4" * 64,
            alpaca_account_label="paper",
        ),
    )
    session = MagicMock(spec=Session)
    session.execute.return_value.scalar_one_or_none.return_value = uuid.uuid4()
    settled_receipt = cast(
        BrokerMutationReceiptSnapshot,
        SimpleNamespace(
            state="settled",
            settlement=SimpleNamespace(
                outcome="reconciled",
                execution_id=execution_id,
            ),
        ),
    )

    with (
        patch(
            "app.trading.execution.durable_existing_order_recovery."
            "get_broker_mutation_receipt",
            return_value=settled_receipt,
        ),
        patch.object(
            durable_recovery,
            "_load_recovered_execution",
            return_value=recovered_execution,
        ) as load_execution,
    ):
        result = recover_durable_linked_existing_order(
            _durable_recovery_request(
                session,
                decision_row,
                existing_orders=({"id": "reconciled-order"},),
            )
        )

    assert result.handled
    assert result.execution is recovered_execution
    load_execution.assert_called_once_with(
        session,
        execution_id=execution_id,
        required=True,
    )


def test_load_recovered_execution_requires_execution_id() -> None:
    session = MagicMock(spec=Session)

    with pytest.raises(
        RuntimeError,
        match="linked_submission_recovery_execution_missing",
    ):
        durable_recovery._load_recovered_execution(
            session,
            execution_id=None,
            required=True,
        )


def test_load_recovered_execution_reuses_identity_map() -> None:
    execution_id = uuid.uuid4()
    recovered_execution = cast(
        Execution,
        SimpleNamespace(id=execution_id, status="expired"),
    )
    session = MagicMock()
    identity_key = (Execution, (execution_id,), None)
    session.identity_key.return_value = identity_key
    session.identity_map.get.return_value = recovered_execution

    result = durable_recovery._load_recovered_execution(
        session,
        execution_id=execution_id,
        required=True,
    )

    assert result is recovered_execution
    session.identity_key.assert_called_once_with(Execution, execution_id)
    session.identity_map.get.assert_called_once_with(identity_key)
    session.execute.assert_not_called()


def test_load_recovered_execution_rejects_missing_execution_schema() -> None:
    session = MagicMock()
    session.identity_map.get.return_value = None
    session.execute.return_value.scalars.return_value = ()

    with pytest.raises(
        RuntimeError,
        match="linked_submission_recovery_execution_schema_missing",
    ):
        durable_recovery._load_recovered_execution(
            session,
            execution_id=uuid.uuid4(),
            required=True,
        )
