from __future__ import annotations

import hashlib
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    Base,
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    ExecutionOrderEvent,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationLifecyclePlan,
    InfrastructureValidationPermit,
    infrastructure_validation_lifecycle_plan_sha256,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_lifecycle import (
    InfrastructureValidationLifecycleContext,
    run_infrastructure_validation_lifecycle,
)
from app.trading.infrastructure_validation_lifecycle_broker import single_order_id
from app.trading.infrastructure_validation_records import (
    load_infrastructure_validation_evidence,
    tag_infrastructure_validation_event,
)


class _LifecycleBroker:
    endpoint_class = "paper"
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(
        self,
        session_factory: Callable[[], Session],
        *,
        broker_position_symbol: str = "BTCUSD",
        entry_fee_quantity: Decimal = Decimal("0"),
        fail_mutation: str | None = None,
        nested_close_all_response: bool = False,
    ) -> None:
        self._session_factory = session_factory
        self._broker_position_symbol = broker_position_symbol
        self._entry_fee_quantity = entry_fee_quantity
        self._fail_mutation = fail_mutation
        self._nested_close_all_response = nested_close_all_response
        self._orders: dict[str, dict[str, object]] = {}
        self._position_quantity = Decimal("0")
        self._position_after_order: dict[str, Decimal] = {}
        self._sequence = 0
        self.mutations: list[str] = []

    def get_account(self) -> dict[str, object]:
        return {
            "account_number": "paper",
            "status": "ACTIVE",
            "crypto_status": "ACTIVE",
            "account_blocked": False,
            "trading_blocked": False,
            "trade_suspended_by_user": False,
        }

    def get_asset(self, _symbol: str) -> dict[str, object]:
        return {
            "asset_class": "crypto",
            "min_order_size": 1.548e-05,
            "min_trade_increment": 1e-09,
            "price_increment": 1e-09,
            "status": "active",
            "tradable": True,
        }

    def get_order_by_client_order_id_strict(
        self,
        client_order_id: str,
    ) -> dict[str, object] | None:
        self._sync_order_events()
        return next(
            (
                dict(order)
                for order in self._orders.values()
                if order["client_order_id"] == client_order_id
            ),
            None,
        )

    def get_order_by_id_strict(
        self,
        order_id: str,
    ) -> dict[str, object] | None:
        self._sync_order_events()
        order = self._orders.get(order_id)
        return dict(order) if order is not None else None

    def get_order(self, order_id: str) -> dict[str, object]:
        order = self.get_order_by_id_strict(order_id)
        if order is None:
            raise RuntimeError("order_missing")
        return order

    def list_positions(self) -> list[dict[str, object]]:
        self._sync_order_events()
        if self._position_quantity == 0:
            return []
        return [
            {
                "asset_class": "crypto",
                "symbol": self._broker_position_symbol,
                "qty": str(self._position_quantity),
                "side": "long",
                "market_value": str(self._position_quantity * Decimal("100000")),
            }
        ]

    def list_open_orders(self) -> list[dict[str, object]]:
        self._sync_order_events()
        return [
            dict(order)
            for order in self._orders.values()
            if str(order["status"]) in {"new", "accepted"}
        ]

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        del limit
        return (
            self.list_open_orders()
            if status == "open"
            else [dict(order) for order in self._orders.values()]
        )

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
        **_kwargs: object,
    ) -> dict[str, object]:
        del stop_price
        quantity = Decimal(str(qty))
        client_order_id = str((extra_params or {})["client_order_id"])
        if side == "buy":
            self._begin_mutation("root_submit")
            self._position_quantity = quantity - self._entry_fee_quantity
            return self._add_order(
                order_id="root-order-1",
                client_order_id=client_order_id,
                symbol=symbol,
                side=side,
                quantity=quantity,
                order_type=order_type,
                time_in_force=time_in_force,
                limit_price=Decimal(str(limit_price)),
                status="filled",
                filled_quantity=quantity,
            )
        self._begin_mutation("resting_close_submit")
        return self._add_order(
            order_id="resting-close-order-1",
            client_order_id=client_order_id,
            symbol=symbol,
            side=side,
            quantity=quantity,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=Decimal(str(limit_price)),
            status="new",
            filled_quantity=Decimal("0"),
        )

    def replace_order(
        self,
        order_id: str,
        *,
        limit_price: float,
        **_kwargs: object,
    ) -> dict[str, object]:
        self._begin_mutation("replace_order")
        original = self._orders[order_id]
        original["status"] = "replaced"
        return self._add_order(
            order_id="replacement-close-order-1",
            client_order_id="replacement-client-1",
            symbol=str(original["symbol"]),
            side=str(original["side"]),
            quantity=Decimal(str(original["qty"])),
            order_type="limit",
            time_in_force="gtc",
            limit_price=Decimal(str(limit_price)),
            status="new",
            filled_quantity=Decimal("0"),
        )

    def cancel_order(self, order_id: str, **_kwargs: object) -> bool:
        self._begin_mutation("cancel_order")
        self._orders[order_id]["status"] = "canceled"
        return True

    def cancel_all_orders(self, **_kwargs: object) -> list[dict[str, object]]:
        self._begin_mutation("cancel_all_orders")
        responses: list[dict[str, object]] = []
        for order in self._orders.values():
            if str(order["status"]) in {"new", "accepted"}:
                order["status"] = "canceled"
                responses.append({"id": order["id"], "status": 204})
        return responses

    def close_position(
        self,
        symbol: str,
        *,
        qty: Decimal,
        **_kwargs: object,
    ) -> dict[str, object]:
        assert symbol == self._broker_position_symbol
        self._begin_mutation("close_position")
        self._position_quantity -= qty
        return self._add_order(
            order_id="partial-close-order-1",
            client_order_id="partial-close-client-1",
            symbol="BTC/USD",
            side="sell",
            quantity=qty,
            order_type="market",
            time_in_force="gtc",
            limit_price=None,
            status="filled",
            filled_quantity=qty,
        )

    def close_all_positions(self, **_kwargs: object) -> list[dict[str, object]]:
        self._begin_mutation("close_all_positions")
        quantity = self._position_quantity
        self._position_quantity = Decimal("0")
        order = self._add_order(
            order_id="final-flatten-order-1",
            client_order_id="final-flatten-client-1",
            symbol="BTC/USD",
            side="sell",
            quantity=quantity,
            order_type="market",
            time_in_force="gtc",
            limit_price=None,
            status="filled",
            filled_quantity=quantity,
        )
        if self._nested_close_all_response:
            return [
                {
                    "body": order,
                    "order_id": None,
                    "status": 200,
                    "symbol": "BTC/USD",
                }
            ]
        return [order]

    def _begin_mutation(self, name: str) -> None:
        self.mutations.append(name)
        if self._fail_mutation == name:
            raise RuntimeError(f"injected_{name}_failure")

    def _add_order(
        self,
        *,
        order_id: str,
        client_order_id: str,
        symbol: str,
        side: str,
        quantity: Decimal,
        order_type: str,
        time_in_force: str,
        limit_price: Decimal | None,
        status: str,
        filled_quantity: Decimal,
    ) -> dict[str, object]:
        fill_price = (
            limit_price - Decimal("1") if limit_price is not None else Decimal("65000")
        )
        order = {
            "id": order_id,
            "client_order_id": client_order_id,
            "symbol": symbol,
            "side": side,
            "qty": str(quantity),
            "type": order_type,
            "time_in_force": time_in_force,
            "limit_price": str(limit_price) if limit_price is not None else None,
            "status": status,
            "filled_qty": str(filled_quantity),
            "filled_avg_price": str(fill_price) if filled_quantity else None,
        }
        self._orders[order_id] = order
        self._position_after_order[order_id] = self._position_quantity
        return dict(order)

    def _sync_order_events(self) -> None:
        with self._session_factory() as session:
            receipts = session.execute(
                select(BrokerMutationReceipt).where(
                    BrokerMutationReceipt.operation.in_(
                        (
                            "submit_order",
                            "replace_order",
                            "close_position",
                            "close_all_positions",
                        )
                    )
                )
            ).scalars()
            for receipt in receipts:
                latest = session.execute(
                    select(BrokerMutationReceiptEvent)
                    .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
                    .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                    .limit(1)
                ).scalar_one_or_none()
                if latest is None or latest.state != "settled":
                    continue
                broker_order_id = str(latest.broker_reference or "")
                order = self._orders.get(broker_order_id)
                if order is None:
                    continue
                already_persisted = session.scalar(
                    select(ExecutionOrderEvent.id).where(
                        ExecutionOrderEvent.alpaca_order_id == broker_order_id
                    )
                )
                if already_persisted is not None:
                    continue
                evidence = load_infrastructure_validation_evidence(
                    session,
                    account_label="paper",
                    client_order_id=receipt.client_request_id,
                    alpaca_order_id=broker_order_id,
                )
                if evidence is None:
                    continue
                self._sequence += 1
                event_type = "fill" if order["status"] == "filled" else "new"
                fingerprint = hashlib.sha256(
                    f"{broker_order_id}:{event_type}".encode()
                ).hexdigest()
                session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=fingerprint,
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=self._sequence,
                        alpaca_account_label="paper",
                        feed_seq=self._sequence,
                        event_ts=datetime.now(timezone.utc)
                        + timedelta(microseconds=self._sequence),
                        symbol="BTC/USD",
                        alpaca_order_id=broker_order_id,
                        client_order_id=str(order["client_order_id"]),
                        event_type=event_type,
                        status=str(order["status"]),
                        qty=Decimal(str(order["qty"])),
                        filled_qty=Decimal(str(order["filled_qty"])),
                        position_qty=self._position_after_order[broker_order_id],
                        avg_fill_price=(
                            Decimal(str(order["filled_avg_price"]))
                            if order["filled_avg_price"] is not None
                            else None
                        ),
                        raw_event=tag_infrastructure_validation_event(
                            {"event": event_type},
                            evidence,
                        ),
                    )
                )
            session.commit()


@pytest.fixture
def lifecycle_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[
    sessionmaker[Session],
    InfrastructureValidationPermit,
    InfrastructureValidationLifecyclePlan,
]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    monkeypatch.setattr(settings, "trading_kill_switch_enabled", False)
    plan = InfrastructureValidationLifecyclePlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-lifecycle-plan.v2",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "0.0004",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "70000",
            "stop_price": None,
            "resting_close_limit_price": "130000",
            "replacement_close_limit_price": "140000",
            "partial_close_qty": "0.0002",
        }
    )
    now = datetime.now(timezone.utc)
    permit = InfrastructureValidationPermit.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-permit.v2",
            "permit_id": "ivp-lifecycle-runner-test",
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
            "max_notional_usd": "30",
            "max_loss_usd": "30",
            "issued_by": "infrastructure-owner",
            "approved_by": "independent-infrastructure-owner",
            "issued_at": now - timedelta(seconds=1),
            "expires_at": now + timedelta(minutes=5),
            "test_plan_digest": infrastructure_validation_lifecycle_plan_sha256(plan),
            "expected_terminal_state": (
                "no_open_orders_no_positions_no_unsettled_claims"
            ),
            "expected_terminal_state_digest": (
                infrastructure_validation_terminal_state_sha256()
            ),
            "evidence_tag": "non_promotable_validation",
            "promotable": False,
        }
    )
    return sessions, permit, plan


def test_runner_executes_one_bounded_lifecycle_and_proves_exclusion(
    lifecycle_runtime: tuple[
        sessionmaker[Session],
        InfrastructureValidationPermit,
        InfrastructureValidationLifecyclePlan,
    ],
) -> None:
    sessions, permit, plan = lifecycle_runtime
    broker = _LifecycleBroker(cast(Callable[[], Session], sessions))

    report = run_infrastructure_validation_lifecycle(
        permit=permit,
        plan=plan,
        context=_context(broker, sessions),
    )

    assert broker.mutations == [
        "root_submit",
        "resting_close_submit",
        "replace_order",
        "cancel_order",
        "close_position",
        "close_all_positions",
    ]
    assert report.replay_outcome == "already_processed"
    assert report.root_submit_broker_call_count == 1
    assert report.receipt_count == 6
    assert tuple(receipt.stage for receipt in report.receipts) == (
        "root_submit",
        "resting_close_submit",
        "replace_order",
        "cancel_order",
        "close_position",
        "close_all_positions",
    )
    assert report.order_event_count == 5
    assert report.linked_order_event_count == 0
    assert report.untagged_order_event_count == 0
    assert report.submission_claim_count == 0
    assert report.execution_count == 0
    assert report.trade_decision_count == 0
    assert report.tigerbeetle_transfer_ref_count == 0
    assert report.terminal_position_count == 0
    assert report.terminal_open_order_count == 0
    assert report.promotable is False
    assert (
        report.schema_version == "torghut.infrastructure-validation-lifecycle-report.v2"
    )
    assert report.net_entry_quantity == "0.0004"
    assert report.entry_fee_quantity == "0"
    assert report.to_payload()["evidence_tag"] == "non_promotable_validation"


def test_runner_uses_fee_adjusted_position_and_nested_close_all_order(
    lifecycle_runtime: tuple[
        sessionmaker[Session],
        InfrastructureValidationPermit,
        InfrastructureValidationLifecyclePlan,
    ],
) -> None:
    sessions, permit, plan = lifecycle_runtime
    broker = _LifecycleBroker(
        cast(Callable[[], Session], sessions),
        broker_position_symbol="BTCUSD",
        entry_fee_quantity=Decimal("0.000001"),
        nested_close_all_response=True,
    )

    report = run_infrastructure_validation_lifecycle(
        permit=permit,
        plan=plan,
        context=_context(broker, sessions),
    )

    orders = {str(order["id"]): order for order in broker.list_orders()}
    assert report.entry_quantity == "0.0004"
    assert report.net_entry_quantity == "0.000399"
    assert report.entry_fee_quantity == "0.000001"
    assert report.partial_close_quantity == "0.0002"
    assert report.residual_quantity == "0.000199"
    assert orders["resting-close-order-1"]["qty"] == "0.000399"
    assert orders["replacement-close-order-1"]["qty"] == "0.000399"
    assert orders["partial-close-order-1"]["qty"] == "0.0002"
    assert orders["final-flatten-order-1"]["qty"] == "0.000199"
    assert report.terminal_position_count == 0
    assert report.terminal_open_order_count == 0


def test_runner_rejects_position_below_documented_maximum_fee_bound(
    lifecycle_runtime: tuple[
        sessionmaker[Session],
        InfrastructureValidationPermit,
        InfrastructureValidationLifecyclePlan,
    ],
) -> None:
    sessions, permit, plan = lifecycle_runtime
    broker = _LifecycleBroker(
        cast(Callable[[], Session], sessions),
        entry_fee_quantity=Decimal("0.00000101"),
    )

    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_entry_position_wait_timeout",
    ):
        run_infrastructure_validation_lifecycle(
            permit=permit,
            plan=plan,
            context=_context(broker, sessions),
        )

    assert broker.mutations == ["root_submit", "close_all_positions"]
    assert broker.list_positions() == []


def test_flatten_response_rejects_ambiguous_nested_order_identity() -> None:
    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_flatten_response_identity_invalid",
    ):
        single_order_id(
            [
                {
                    "body": {"id": "body-order"},
                    "order_id": "wrapper-order",
                    "status": 200,
                }
            ]
        )


@pytest.mark.parametrize(
    "failed_mutation",
    ("replace_order", "cancel_order", "close_position"),
)
def test_runner_flattens_after_recoverable_failure_without_blind_retry(
    lifecycle_runtime: tuple[
        sessionmaker[Session],
        InfrastructureValidationPermit,
        InfrastructureValidationLifecyclePlan,
    ],
    failed_mutation: str,
) -> None:
    sessions, permit, plan = lifecycle_runtime
    broker = _LifecycleBroker(
        cast(Callable[[], Session], sessions),
        fail_mutation=failed_mutation,
    )

    with pytest.raises(RuntimeError, match=f"unlinked_{failed_mutation}"):
        run_infrastructure_validation_lifecycle(
            permit=permit,
            plan=plan,
            context=_context(broker, sessions),
        )

    assert broker.mutations.count(failed_mutation) == 1
    if failed_mutation in {"replace_order", "cancel_order"}:
        assert "cancel_all_orders" in broker.mutations
    assert "close_all_positions" in broker.mutations
    assert broker.list_open_orders() == []
    assert broker.list_positions() == []


def test_runner_does_not_retry_ambiguous_final_flatten(
    lifecycle_runtime: tuple[
        sessionmaker[Session],
        InfrastructureValidationPermit,
        InfrastructureValidationLifecyclePlan,
    ],
) -> None:
    sessions, permit, plan = lifecycle_runtime
    broker = _LifecycleBroker(
        cast(Callable[[], Session], sessions),
        fail_mutation="close_all_positions",
    )

    with pytest.raises(
        RuntimeError,
        match="infrastructure_validation_lifecycle_cleanup_failed",
    ):
        run_infrastructure_validation_lifecycle(
            permit=permit,
            plan=plan,
            context=_context(broker, sessions),
        )

    assert broker.mutations.count("close_all_positions") == 1
    assert broker.list_open_orders() == []
    assert len(broker.list_positions()) == 1


def _context(
    broker: _LifecycleBroker,
    sessions: sessionmaker[Session],
) -> InfrastructureValidationLifecycleContext:
    return InfrastructureValidationLifecycleContext(
        client=broker,
        session_factory=cast(Callable[[], Session], sessions),
        configured_account_label="paper",
        order_timeout_seconds=1,
        evidence_timeout_seconds=1,
        cleanup_timeout_seconds=1,
        poll_interval_seconds=0.001,
    )
