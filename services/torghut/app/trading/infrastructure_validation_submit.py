"""Bounded runtime proof for one permit-fenced Alpaca paper submission."""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Protocol, cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from ..db import SessionLocal
from ..models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    Execution,
    ExecutionOrderEvent,
    TigerBeetleTransferRef,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from .broker_mutation_receipts import (
    BrokerMutationIoPermit,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
)
from .broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionAlreadyProcessed,
    BrokerMutationSubmissionDeferred,
    BrokerMutationSubmitCoordinator,
    InfrastructureValidationOrderSubmission,
    UnlinkedOrderSubmissionCallbacks,
)
from .firewall import OrderFirewall, OrderFirewallBrokerClient
from .infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    authorize_infrastructure_validation_order,
    infrastructure_validation_client_order_id,
    infrastructure_validation_permit_sha256,
)
from .infrastructure_validation_records import (
    is_non_promotable_validation_event,
)


_TERMINAL_ORDER_STATUSES = frozenset(
    {"canceled", "cancelled", "done_for_day", "expired", "filled", "rejected"}
)
_KNOWN_NULL_ORDER_STATUSES = frozenset({"canceled", "cancelled", "expired", "rejected"})


class _ValidationAlpacaClient(Protocol):
    endpoint_class: str
    endpoint_url: str

    def get_account(self) -> dict[str, object]: ...

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, object] | None: ...

    def get_order_by_client_order_id_strict(
        self,
        client_order_id: str,
    ) -> dict[str, object] | None: ...

    def list_open_orders(self) -> list[dict[str, object]]: ...

    def list_positions(self) -> list[dict[str, object]]: ...


@dataclass(frozen=True, slots=True)
class InfrastructureValidationSubmitReport:
    schema_version: str
    observed_at: str
    permit_id: str
    permit_sha256: str
    broker_account_number: str
    client_order_id: str
    broker_order_id: str
    broker_order_status: str
    receipt_id: str
    receipt_state: str
    settlement_outcome: str
    race_outcomes: tuple[str, ...]
    replay_outcome: str
    broker_call_count: int
    receipt_count: int
    submission_claim_count: int
    execution_count: int
    trade_decision_count: int
    order_event_count: int
    linked_order_event_count: int
    tigerbeetle_transfer_ref_count: int
    preflight_position_count: int
    preflight_open_order_count: int
    terminal_position_count: int
    terminal_open_order_count: int
    evidence_tag: str
    promotable: bool

    def to_payload(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class _WorkerResult:
    outcome: str
    broker_result: Mapping[str, object] | None = None
    error: str | None = None


@dataclass(slots=True)
class _BrokerCallCounter:
    value: int = 0


@dataclass(frozen=True, slots=True)
class _DatabaseProof:
    receipt_id: object
    receipt_state: str
    settlement_outcome: str
    broker_reference: str
    receipt_count: int
    submission_claim_count: int
    execution_count: int
    trade_decision_count: int
    order_event_count: int
    linked_order_event_count: int
    tigerbeetle_transfer_ref_count: int


def run_infrastructure_validation_submit(
    *,
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
    client: _ValidationAlpacaClient,
    session_factory: Callable[[], Session],
    configured_account_label: str,
    now: datetime | None = None,
    race_timeout_seconds: float = 10.0,
    terminal_timeout_seconds: float = 30.0,
) -> InfrastructureValidationSubmitReport:
    """Race one duplicate intent and prove one broker call plus one receipt."""

    evaluated_at = now or datetime.now(timezone.utc)
    account_label = configured_account_label.strip()
    if not account_label or account_label != permit.account_label:
        raise RuntimeError("infrastructure_validation_configured_account_mismatch")
    if client.endpoint_class != "paper":
        raise RuntimeError("infrastructure_validation_client_not_paper")
    authorize_infrastructure_validation_order(
        permit,
        plan,
        account_label=account_label,
        account_mode="paper",
        broker_base_url=client.endpoint_url,
        now=evaluated_at,
    )
    account = client.get_account()
    broker_account_number = _validate_broker_account(
        account,
        permit=permit,
        plan=plan,
    )
    asset = client.get_asset(plan.symbol)
    _validate_broker_asset(asset, plan=plan)
    preflight_positions = client.list_positions()
    preflight_orders = client.list_open_orders()
    if preflight_positions or preflight_orders:
        raise RuntimeError("infrastructure_validation_account_not_known_null")

    firewall = OrderFirewall(
        cast(OrderFirewallBrokerClient, client),
        account_label=account_label,
    )
    if firewall.status().kill_switch_enabled:
        raise RuntimeError("infrastructure_validation_kill_switch_enabled")
    request = InfrastructureValidationOrderSubmission(
        permit=permit,
        plan=plan,
        account_label=account_label,
        account_mode="paper",
        endpoint_url=client.endpoint_url,
    )
    broker_started = threading.Event()
    contender_finished = threading.Event()
    broker_call_lock = threading.Lock()
    broker_call_counter = _BrokerCallCounter()

    def broker_call(mutation_permit: BrokerMutationIoPermit) -> Mapping[str, object]:
        with broker_call_lock:
            broker_call_counter.value += 1
        broker_started.set()
        if not contender_finished.wait(timeout=race_timeout_seconds):
            raise RuntimeError("infrastructure_validation_race_contender_timeout")
        return firewall.submit_verified_infrastructure_validation_order(
            permit,
            plan,
            mutation_permit=mutation_permit,
        )

    callbacks = UnlinkedOrderSubmissionCallbacks(
        broker_call=broker_call,
        persist_terminal=lambda _result: None,
        build_settlement=lambda result: _validation_settlement(
            result,
            permit=permit,
            plan=plan,
        ),
    )

    def submit(component: str) -> _WorkerResult:
        with session_factory() as session:
            try:
                result = BrokerMutationSubmitCoordinator(
                    component
                ).submit_infrastructure_validation_order(
                    session,
                    request=request,
                    callbacks=callbacks,
                )
            except BrokerMutationSubmissionAlreadyProcessed as exc:
                return _WorkerResult("already_processed", error=str(exc))
            except BrokerMutationSubmissionDeferred as exc:
                return _WorkerResult(
                    "deferred",
                    error=f"{type(exc).__name__}:{exc}",
                )
        return _WorkerResult("submitted", result)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            winner = executor.submit(submit, "validation-primary")
            if not broker_started.wait(timeout=race_timeout_seconds):
                raise RuntimeError("infrastructure_validation_broker_boundary_timeout")
            contender = executor.submit(submit, "validation-contender")
            try:
                contender_result = contender.result(timeout=race_timeout_seconds)
            finally:
                contender_finished.set()
            winner_result = winner.result(timeout=race_timeout_seconds)
    finally:
        contender_finished.set()

    race_results = (winner_result, contender_result)
    if sorted(result.outcome for result in race_results) != ["deferred", "submitted"]:
        reasons = ";".join(
            f"{result.outcome}:{result.error or 'none'}" for result in race_results
        )
        raise RuntimeError(f"infrastructure_validation_race_outcome_invalid:{reasons}")
    if broker_call_counter.value != 1:
        raise RuntimeError("infrastructure_validation_broker_call_count_invalid")
    submitted = next(result for result in race_results if result.outcome == "submitted")
    if submitted.broker_result is None:
        raise RuntimeError("infrastructure_validation_broker_result_missing")

    replay = submit("validation-replay")
    if replay.outcome != "already_processed":
        raise RuntimeError("infrastructure_validation_replay_not_fenced")

    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    broker_order = _wait_for_terminal_order(
        client,
        client_order_id=client_order_id,
        timeout_seconds=terminal_timeout_seconds,
    )
    terminal_positions, terminal_orders = _wait_for_known_null_account(
        client,
        timeout_seconds=terminal_timeout_seconds,
    )

    database = _load_database_proof(
        session_factory,
        client_order_id=client_order_id,
    )
    broker_order_id = str(broker_order.get("id") or "").strip()
    if broker_order_id != database.broker_reference:
        raise RuntimeError("infrastructure_validation_broker_reference_mismatch")
    return InfrastructureValidationSubmitReport(
        schema_version="torghut.infrastructure-validation-submit-report.v1",
        observed_at=datetime.now(timezone.utc).isoformat(),
        permit_id=permit.permit_id,
        permit_sha256=infrastructure_validation_permit_sha256(permit),
        broker_account_number=broker_account_number,
        client_order_id=client_order_id,
        broker_order_id=broker_order_id,
        broker_order_status=str(broker_order.get("status") or "").lower(),
        receipt_id=str(database.receipt_id),
        receipt_state=database.receipt_state,
        settlement_outcome=database.settlement_outcome,
        race_outcomes=tuple(result.outcome for result in race_results),
        replay_outcome=replay.outcome,
        broker_call_count=broker_call_counter.value,
        receipt_count=database.receipt_count,
        submission_claim_count=database.submission_claim_count,
        execution_count=database.execution_count,
        trade_decision_count=database.trade_decision_count,
        order_event_count=database.order_event_count,
        linked_order_event_count=database.linked_order_event_count,
        tigerbeetle_transfer_ref_count=database.tigerbeetle_transfer_ref_count,
        preflight_position_count=len(preflight_positions),
        preflight_open_order_count=len(preflight_orders),
        terminal_position_count=len(terminal_positions),
        terminal_open_order_count=len(terminal_orders),
        evidence_tag="non_promotable_validation",
        promotable=False,
    )


def _validation_settlement(
    result: Mapping[str, object],
    *,
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
) -> BrokerMutationSettlement:
    broker_reference = str(result.get("id") or result.get("order_id") or "").strip()
    if not broker_reference:
        raise ValueError("infrastructure_validation_broker_reference_missing")
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference=broker_reference,
            execution_id=None,
            evidence_payload={
                "schema_version": "torghut.infrastructure-validation-submit-terminal.v1",
                "broker_status": str(result.get("status") or "unknown").lower(),
                "client_order_id": infrastructure_validation_client_order_id(
                    permit,
                    plan,
                ),
                "evidence_tag": "non_promotable_validation",
                "permit_id": permit.permit_id,
                "permit_sha256": infrastructure_validation_permit_sha256(permit),
                "promotable": False,
            },
        )
    )


def _wait_for_terminal_order(
    client: _ValidationAlpacaClient,
    *,
    client_order_id: str,
    timeout_seconds: float,
) -> Mapping[str, object]:
    deadline = time.monotonic() + timeout_seconds
    latest: Mapping[str, object] | None = None
    while time.monotonic() < deadline:
        latest = client.get_order_by_client_order_id_strict(client_order_id)
        status = str((latest or {}).get("status") or "").strip().lower()
        if latest is not None and status in _TERMINAL_ORDER_STATUSES:
            _require_known_null_terminal_order(
                latest,
                client_order_id=client_order_id,
            )
            return latest
        time.sleep(0.5)
    raise RuntimeError(
        "infrastructure_validation_broker_order_not_terminal:"
        f"{str((latest or {}).get('status') or 'missing')}"
    )


def _require_known_null_terminal_order(
    order: Mapping[str, object],
    *,
    client_order_id: str,
) -> None:
    if str(order.get("client_order_id") or "").strip() != client_order_id:
        raise RuntimeError("infrastructure_validation_broker_order_identity_mismatch")
    if not str(order.get("id") or "").strip():
        raise RuntimeError("infrastructure_validation_broker_order_identity_missing")
    status = str(order.get("status") or "").strip().lower()
    if status not in _KNOWN_NULL_ORDER_STATUSES:
        raise RuntimeError("infrastructure_validation_broker_order_status_invalid")
    try:
        filled_qty = Decimal(str(order.get("filled_qty")))
    except (InvalidOperation, ValueError) as exc:
        raise RuntimeError(
            "infrastructure_validation_broker_order_filled_qty_invalid"
        ) from exc
    if not filled_qty.is_finite() or filled_qty < 0:
        raise RuntimeError("infrastructure_validation_broker_order_filled_qty_invalid")
    if filled_qty != 0:
        raise RuntimeError("infrastructure_validation_broker_order_fill_observed")


def _wait_for_known_null_account(
    client: _ValidationAlpacaClient,
    *,
    timeout_seconds: float,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    deadline = time.monotonic() + timeout_seconds
    positions: list[dict[str, object]] = []
    orders: list[dict[str, object]] = []
    while time.monotonic() < deadline:
        positions = client.list_positions()
        orders = client.list_open_orders()
        if not positions and not orders:
            return positions, orders
        time.sleep(0.5)
    raise RuntimeError(
        "infrastructure_validation_terminal_account_not_null:"
        f"positions={len(positions)}:open_orders={len(orders)}"
    )


def _validate_broker_account(
    account: Mapping[str, object],
    *,
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
) -> str:
    account_number = str(account.get("account_number") or "").strip()
    if not account_number or account_number != permit.account_label:
        raise RuntimeError("infrastructure_validation_broker_account_mismatch")
    if str(account.get("status") or "").strip().upper() != "ACTIVE":
        raise RuntimeError("infrastructure_validation_broker_account_not_active")
    if any(
        account.get(field) is True
        for field in ("account_blocked", "trading_blocked", "trade_suspended_by_user")
    ):
        raise RuntimeError("infrastructure_validation_broker_account_blocked")
    if str(account.get("crypto_status") or "").strip().upper() != "ACTIVE":
        raise RuntimeError("infrastructure_validation_broker_crypto_not_active")
    return account_number


def _validate_broker_asset(
    asset: Mapping[str, object] | None,
    *,
    plan: InfrastructureValidationOrderPlan,
) -> None:
    if not asset or not bool(asset.get("tradable")):
        raise RuntimeError("infrastructure_validation_asset_not_tradable")
    observed_asset_class = str(asset.get("asset_class") or "").strip().lower()
    if observed_asset_class != "crypto":
        raise RuntimeError("infrastructure_validation_broker_asset_class_mismatch")
    if str(asset.get("status") or "").strip().lower() != "active":
        raise RuntimeError("infrastructure_validation_asset_not_active")


def _load_database_proof(
    session_factory: Callable[[], Session],
    *,
    client_order_id: str,
) -> _DatabaseProof:
    with session_factory() as session:
        receipts = (
            session.execute(
                select(BrokerMutationReceipt).where(
                    BrokerMutationReceipt.client_request_id == client_order_id
                )
            )
            .scalars()
            .all()
        )
        if len(receipts) != 1:
            raise RuntimeError("infrastructure_validation_receipt_count_invalid")
        receipt = receipts[0]
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        if latest.state != "settled" or latest.settlement_outcome != "acknowledged":
            raise RuntimeError("infrastructure_validation_receipt_not_terminal")
        broker_reference = str(latest.broker_reference or "").strip()
        if not broker_reference:
            raise RuntimeError("infrastructure_validation_receipt_reference_missing")
        intent = json.loads(receipt.canonical_intent_json)
        validation = intent["request"]["infrastructure_validation"]
        if (
            validation["permit"]["evidence_tag"] != "non_promotable_validation"
            or validation["permit"]["promotable"] is not False
        ):
            raise RuntimeError("infrastructure_validation_evidence_tag_invalid")
        claim_count = session.scalar(
            select(func.count())
            .select_from(TradeDecisionSubmissionClaim)
            .where(TradeDecisionSubmissionClaim.client_order_id == client_order_id)
        )
        execution_count = session.scalar(
            select(func.count())
            .select_from(Execution)
            .where(Execution.client_order_id == client_order_id)
        )
        trade_decision_count = session.scalar(
            select(func.count())
            .select_from(TradeDecision)
            .where(TradeDecision.decision_hash == client_order_id)
        )
        order_events = session.execute(
            select(
                ExecutionOrderEvent.id,
                ExecutionOrderEvent.execution_id,
                ExecutionOrderEvent.trade_decision_id,
                ExecutionOrderEvent.raw_event,
            ).where(ExecutionOrderEvent.client_order_id == client_order_id)
        ).all()
        linked_order_event_count = sum(
            1
            for event in order_events
            if event.execution_id is not None or event.trade_decision_id is not None
        )
        untagged_order_event_count = sum(
            1
            for event in order_events
            if not is_non_promotable_validation_event(event.raw_event)
        )
        order_event_ids = [event.id for event in order_events]
        tigerbeetle_transfer_ref_count = (
            session.scalar(
                select(func.count())
                .select_from(TigerBeetleTransferRef)
                .where(
                    TigerBeetleTransferRef.execution_order_event_id.in_(order_event_ids)
                )
            )
            if order_event_ids
            else 0
        )
    if claim_count or execution_count or trade_decision_count:
        raise RuntimeError("infrastructure_validation_candidate_evidence_leak")
    if linked_order_event_count or untagged_order_event_count:
        raise RuntimeError("infrastructure_validation_order_event_evidence_leak")
    if tigerbeetle_transfer_ref_count:
        raise RuntimeError("infrastructure_validation_ledger_evidence_leak")
    return _DatabaseProof(
        receipt_id=receipt.id,
        receipt_state=latest.state,
        settlement_outcome=cast(str, latest.settlement_outcome),
        broker_reference=broker_reference,
        receipt_count=len(receipts),
        submission_claim_count=int(claim_count or 0),
        execution_count=int(execution_count or 0),
        trade_decision_count=int(trade_decision_count or 0),
        order_event_count=len(order_events),
        linked_order_event_count=linked_order_event_count,
        tigerbeetle_transfer_ref_count=int(tigerbeetle_transfer_ref_count or 0),
    )


def _load_input(
    path: str,
) -> tuple[InfrastructureValidationPermit, InfrastructureValidationOrderPlan]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("infrastructure_validation_input_must_be_object")
    input_payload = cast(Mapping[str, object], payload)
    return (
        InfrastructureValidationPermit.model_validate(input_payload.get("permit")),
        InfrastructureValidationOrderPlan.model_validate(input_payload.get("plan")),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one permit-bound Alpaca-paper durable-submit proof."
    )
    parser.add_argument(
        "--input-file",
        required=True,
        help="JSON file containing permit and plan, or - for one stdin line.",
    )
    args = parser.parse_args(argv)
    permit, plan = _load_input(args.input_file)
    client = TorghutAlpacaClient()
    report = run_infrastructure_validation_submit(
        permit=permit,
        plan=plan,
        client=client,
        session_factory=SessionLocal,
        configured_account_label=settings.trading_account_label,
    )
    print(json.dumps(report.to_payload(), sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised from the deployed image
    raise SystemExit(main())


__all__ = [
    "InfrastructureValidationSubmitReport",
    "main",
    "run_infrastructure_validation_submit",
]
