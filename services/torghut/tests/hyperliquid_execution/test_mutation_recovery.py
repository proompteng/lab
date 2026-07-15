from __future__ import annotations

import json
import uuid
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import cast
from unittest.mock import Mock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.hyperliquid_execution import mutation_recovery
from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.exchange import (
    HyperliquidExecutionExchange,
    HyperliquidOrderRecoveryLookup,
)
from app.hyperliquid_execution.models import OrderIntent, OrderResult
from app.hyperliquid_execution.order_policy import CloidIdentity, deterministic_cloid
from app.hyperliquid_execution.mutation_recovery import HyperliquidMutationRecoveryRoute
from app.models import Base
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptSnapshot,
    BrokerMutationTarget,
    BrokerMutationTargetKind,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
)
from app.trading.broker_mutation_recovery_worker import (
    BrokerMutationRecoveryRouteError,
)
from app.trading.risk_reduction import (
    BrokerOrderObservation,
    BrokerPositionObservation,
    BrokerReductionSnapshot,
    CancelOrderPlan,
    ClosePositionPlan,
    PositionCloseLeg,
    authorize_risk_reduction,
)


_CLOID = "0x" + "c" * 32
_ENDPOINT = "https://api.hyperliquid-testnet.xyz"


class _Exchange:
    def __init__(
        self,
        lookup: HyperliquidOrderRecoveryLookup,
        *,
        observed_order: BrokerOrderObservation | None = None,
        positions: tuple[BrokerPositionObservation, ...] = (),
    ) -> None:
        self.lookup = lookup
        self.observed_order = observed_order
        self.positions = positions
        self.calls: list[tuple[str, datetime, datetime]] = []

    def recover_order_by_cloid(
        self,
        cloid: str,
        *,
        after: datetime,
        until: datetime,
    ) -> HyperliquidOrderRecoveryLookup:
        self.calls.append((cloid, after, until))
        return self.lookup

    def observe_open_order(self, _order: object) -> BrokerOrderObservation | None:
        return self.observed_order

    def observe_reduction_positions(
        self,
    ) -> tuple[datetime, tuple[BrokerPositionObservation, ...]]:
        return datetime.now(timezone.utc), self.positions


def _sessions(database_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite+pysqlite:///{database_path}", future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )


def _receipt(
    sessions: sessionmaker[Session],
    *,
    cloid: str = _CLOID,
    include_order_metadata: bool = True,
) -> BrokerMutationReceiptSnapshot:
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=1)
    request_payload: dict[str, object] = {
        "market_id": "hl:perp:BTC",
        "coin": "BTC",
        "dex": "",
        "side": "buy",
        "size": Decimal("1"),
        "limit_price": Decimal("100"),
        "notional_usd": Decimal("100"),
        "cloid": cloid,
        "tif": "Ioc",
        "reduce_only": False,
        "slippage": Decimal("0"),
    }
    if include_order_metadata:
        request_payload.update(
            {
                "signal_id": "signal-1",
                "expires_at": expires_at.isoformat(),
            }
        )
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint=fingerprint_broker_endpoint(_ENDPOINT),
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id=f"hyperliquid-mutation/{cloid}",
            client_request_id=cloid,
            target=BrokerMutationTarget(kind="order", key=cloid),
            request_payload=request_payload,
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="hyperliquid-route-test",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    with sessions() as session:
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            recovery_seconds=30,
        )
    assert started.authorized
    return started.receipt


def _reduction_receipt(
    sessions: sessionmaker[Session],
    *,
    operation: str,
    target_kind: str,
    target_key: str,
    broker_request: dict[str, object],
    risk_reduction: dict[str, object],
) -> BrokerMutationReceiptSnapshot:
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint=fingerprint_broker_endpoint(_ENDPOINT),
            operation=operation,
            risk_class=(
                "risk_reducing" if operation == "close_position" else "risk_neutral"
            ),
            purpose="closeout" if operation == "close_position" else "operator",
            workflow_id=f"recovery-test/{uuid.uuid4().hex}",
            client_request_id=f"rr-{uuid.uuid4().hex}",
            target=BrokerMutationTarget(
                kind=cast(BrokerMutationTargetKind, target_kind),
                key=target_key,
            ),
            request_payload={
                **broker_request,
                "risk_reduction": risk_reduction,
                "schema_version": "torghut.hyperliquid-reduction-request.v1",
            },
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="hyperliquid-reduction-recovery-test",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    with sessions() as session:
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            recovery_seconds=30,
        )
    assert started.authorized
    return started.receipt


def _risk_snapshot(
    *,
    orders: tuple[BrokerOrderObservation, ...] = (),
    positions: tuple[BrokerPositionObservation, ...] = (),
) -> BrokerReductionSnapshot:
    return BrokerReductionSnapshot(
        broker_route="hyperliquid",
        account_label="hyperliquid-testnet",
        endpoint_fingerprint=fingerprint_broker_endpoint(_ENDPOINT),
        observed_at=datetime.now(timezone.utc),
        complete=True,
        orders=orders,
        positions=positions,
    )


def _order(
    *,
    status: str,
    oid: int | None = 123,
    coin: str = "BTC",
    cloid: str = _CLOID,
) -> dict[str, object]:
    order: dict[str, object] = {
        "coin": coin,
        "side": "B",
        "limitPx": "100",
        "sz": "0",
        "origSz": "1",
        "tif": "Ioc",
        "cloid": cloid,
    }
    if oid is not None:
        order["oid"] = oid
    return {"order": order, "status": status}


def _route(
    lookup: HyperliquidOrderRecoveryLookup,
    *,
    observed_order: BrokerOrderObservation | None = None,
    positions: tuple[BrokerPositionObservation, ...] = (),
) -> tuple[HyperliquidMutationRecoveryRoute, _Exchange]:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ACCOUNT_ADDRESS": "0x" + "1" * 40,
            "HYPERLIQUID_EXECUTION_EXCHANGE_API_URL": _ENDPOINT,
        }
    )
    exchange = _Exchange(
        lookup,
        observed_order=observed_order,
        positions=positions,
    )
    return (
        HyperliquidMutationRecoveryRoute(
            config=config,
            exchange=cast(HyperliquidExecutionExchange, exchange),
        ),
        exchange,
    )


@pytest.mark.parametrize(
    ("broker_status", "expected_status"),
    [
        ("open", "accepted"),
        ("triggered", "accepted"),
        ("filled", "filled"),
        ("canceled", "cancelled"),
        ("marginCanceled", "cancelled"),
        ("scheduledCancel", "cancelled"),
        ("rejected", "rejected"),
        ("tickRejected", "rejected"),
        ("perpMarginRejected", "rejected"),
    ],
)
def test_official_order_statuses_normalize_to_local_contract(
    tmp_path: Path,
    broker_status: str,
    expected_status: str,
) -> None:
    sessions = _sessions(tmp_path / f"status-{broker_status}.sqlite")
    receipt = _receipt(sessions)
    route, exchange = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"exact_order_status": "found"},
            order=_order(status=broker_status),
        )
    )
    observed_at = datetime.now(timezone.utc) + timedelta(seconds=1)

    read = route.observe(receipt, observed_at=observed_at)

    assert read.outcome == "found"
    assert read.evidence["broker_status"] == expected_status
    assert receipt.lifecycle.broker_io_started_at is not None
    assert exchange.calls == [
        (_CLOID, receipt.lifecycle.broker_io_started_at, observed_at)
    ]


def test_unknown_status_is_indeterminate(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "unknown-status.sqlite")
    receipt = _receipt(sessions)
    route, _ = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"exact_order_status": "found"},
            order=_order(status="futureUnknownStatus"),
        )
    )

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "hyperliquid_recovery_order_status_invalid"
    assert read.evidence["broker_order_found"] is True
    assert read.evidence["absence_proof_complete"] is False


def test_missing_status_is_indeterminate(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "missing-status.sqlite")
    receipt = _receipt(sessions)
    payload = _order(status="open")
    payload.pop("status")
    route, _ = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"exact_order_status": "found"},
            order=payload,
        )
    )

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "hyperliquid_recovery_order_status_invalid"


def test_non_rejected_order_without_oid_is_indeterminate(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "missing-oid.sqlite")
    receipt = _receipt(sessions)
    route, _ = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"exact_order_status": "found"},
            order=_order(status="open", oid=None),
        )
    )

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "hyperliquid_recovery_exchange_order_id_missing"


def test_order_identity_mismatch_is_indeterminate(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "identity.sqlite")
    receipt = _receipt(sessions)
    route, _ = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"exact_order_status": "found"},
            order=_order(status="open", coin="ETH"),
        )
    )

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "hyperliquid_recovery_coin_mismatch"


def test_incomplete_exchange_lookup_remains_nonterminal(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "incomplete.sqlite")
    receipt = _receipt(sessions)
    route, _ = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="indeterminate",
            evidence={
                "reason": "bounded_history_incomplete",
                "absence_proof_complete": False,
            },
        )
    )

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "bounded_history_incomplete"
    assert read.evidence["absence_proof_complete"] is False


def test_partial_fill_proves_submission_without_claiming_terminal_fill(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "partial-fill.sqlite")
    receipt = _receipt(sessions)
    route, _ = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"fill_match_count": 1},
            order={
                "cloid": _CLOID,
                "oid": 123,
                "coin": "BTC",
                "side": "B",
                "sz": "0.25",
                "limitPx": "99",
                "tif": "Ioc",
                "status": "accepted",
                "source": "user_fills_by_time",
            },
        )
    )

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "found"
    assert read.evidence["broker_status"] == "accepted"
    assert read.broker_result is not None
    assert read.broker_result["sz"] == "0.25"


def test_legacy_receipt_recovers_signal_metadata_without_resubmission(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions = _sessions(tmp_path / "legacy-receipt.sqlite")
    generated_at = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)
    feature_event_ts = generated_at - timedelta(seconds=1)
    cloid = deterministic_cloid(
        CloidIdentity(
            market_id="hl:perp:BTC",
            side="buy",
            source_event_ts=feature_event_ts,
            size=Decimal("1"),
            limit_price=Decimal("100"),
            tif="Ioc",
            reduce_only=False,
        )
    )
    receipt = _receipt(
        sessions,
        cloid=cloid,
        include_order_metadata=False,
    )
    legacy_document = json.loads(receipt.intent.canonical_intent_json)
    assert "signal_id" not in legacy_document["request"]
    assert "expires_at" not in legacy_document["request"]
    receipt = replace(
        receipt,
        created_at=generated_at + timedelta(seconds=1),
    )
    route, exchange = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="found",
            evidence={"exact_order_status": "found"},
            order=_order(status="open", cloid=cloid),
        )
    )
    observed_at = generated_at + timedelta(minutes=5)

    read = route.observe(receipt, observed_at=observed_at)

    assert read.outcome == "found"
    assert len(exchange.calls) == 1

    signal_id = str(uuid.uuid4())
    session = Mock(spec=Session)
    rows = Mock()
    rows.mappings.return_value = [
        {
            "signal_id": signal_id,
            "generated_at": generated_at,
            "feature_event_ts": feature_event_ts,
        }
    ]
    session.execute.return_value = rows
    persisted: list[tuple[OrderIntent, OrderResult]] = []

    class _Repository:
        def __init__(self, repository_session: Session) -> None:
            assert repository_session is session

        def insert_order(self, intent: OrderIntent, result: OrderResult) -> str:
            persisted.append((intent, result))
            return "order-row"

    monkeypatch.setattr(
        mutation_recovery, "HyperliquidExecutionRepository", _Repository
    )

    settlement = route.build_found_settlement(session, receipt, read)

    assert settlement.outcome == "reconciled"
    assert len(persisted) == 1
    recovered_intent, recovered_result = persisted[0]
    assert recovered_intent.signal_id == signal_id
    assert recovered_intent.expires_at == generated_at + timedelta(seconds=10)
    assert recovered_intent.cloid == cloid
    assert recovered_result.status == "accepted"


def test_cancel_recovery_requires_exact_order_absence(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "cancel-recovery.sqlite")
    order = BrokerOrderObservation(
        order_id="123",
        client_order_id=_CLOID,
        symbol="BTC",
        side="buy",
        quantity=Decimal("1"),
        filled_quantity=Decimal("0"),
        status="open",
    )
    snapshot = _risk_snapshot(orders=(order,))
    authorization = authorize_risk_reduction(
        snapshot,
        CancelOrderPlan("123"),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="cancel_order",
        target_kind="order",
        target_key="123",
        broker_request={
            "cloid": _CLOID,
            "coin": "BTC",
            "dex": "",
            "order_id": "123",
        },
        risk_reduction=dict(authorization.evidence_payload),
    )
    lookup = HyperliquidOrderRecoveryLookup(
        outcome="indeterminate",
        evidence={"reason": "submit_lookup_must_not_run"},
    )
    open_route, open_exchange = _route(lookup, observed_order=order)
    absent_route, absent_exchange = _route(lookup, observed_order=None)

    open_read = open_route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc),
    )
    absent_read = absent_route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc),
    )

    assert open_read.outcome == "not_found"
    assert absent_read.outcome == "found"
    assert open_exchange.calls == absent_exchange.calls == []
    settlement = absent_route.build_found_settlement(
        Mock(spec=Session),
        receipt,
        absent_read,
    )
    assert settlement.outcome == "reconciled"
    assert settlement.broker_reference == "123"


@pytest.mark.parametrize(
    ("positions", "outcome", "reason"),
    [
        ((), "found", "target_position_flat"),
        (
            (BrokerPositionObservation("BTC", Decimal("3"), Decimal("100")),),
            "found",
            "target_position_reduced",
        ),
        (
            (BrokerPositionObservation("BTC", Decimal("5"), Decimal("100")),),
            "not_found",
            "target_position_unchanged",
        ),
        (
            (BrokerPositionObservation("BTC", Decimal("-1"), Decimal("100")),),
            "indeterminate",
            "position_side_flipped",
        ),
    ],
)
def test_close_recovery_uses_broker_position_observation(
    tmp_path: Path,
    positions: tuple[BrokerPositionObservation, ...],
    outcome: str,
    reason: str,
) -> None:
    sessions = _sessions(tmp_path / f"close-{outcome}-{reason}.sqlite")
    snapshot = _risk_snapshot(
        positions=(BrokerPositionObservation("BTC", Decimal("5"), Decimal("100")),)
    )
    authorization = authorize_risk_reduction(
        snapshot,
        ClosePositionPlan(PositionCloseLeg("BTC", "sell", Decimal("2"))),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="close_position",
        target_kind="position",
        target_key="BTC",
        broker_request={
            "coin": "BTC",
            "expected_signed_quantity": "5",
            "size": "2",
            "slippage": "0.05",
        },
        risk_reduction=dict(authorization.evidence_payload),
    )
    route, exchange = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="indeterminate",
            evidence={"reason": "submit_lookup_must_not_run"},
        ),
        positions=positions,
    )

    read = route.observe(receipt, observed_at=datetime.now(timezone.utc))

    assert (read.outcome, read.evidence["reason"]) == (outcome, reason)
    assert exchange.calls == []


def test_malformed_broker_numeric_shape_degrades_recovery_instead_of_crashing(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "close-malformed-numeric.sqlite")
    snapshot = _risk_snapshot(
        positions=(BrokerPositionObservation("BTC", Decimal("5"), Decimal("100")),)
    )
    authorization = authorize_risk_reduction(
        snapshot,
        ClosePositionPlan(PositionCloseLeg("BTC", "sell", Decimal("2"))),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="close_position",
        target_kind="position",
        target_key="BTC",
        broker_request={
            "coin": "BTC",
            "expected_signed_quantity": "5",
            "size": "2",
            "slippage": "0.05",
        },
        risk_reduction=dict(authorization.evidence_payload),
    )
    route, exchange = _route(
        HyperliquidOrderRecoveryLookup(
            outcome="indeterminate",
            evidence={"reason": "submit_lookup_must_not_run"},
        )
    )

    with (
        patch.object(
            exchange,
            "observe_reduction_positions",
            side_effect=ArithmeticError("malformed-position"),
        ),
        pytest.raises(BrokerMutationRecoveryRouteError, match="ArithmeticError"),
    ):
        route.observe(receipt, observed_at=datetime.now(timezone.utc))
