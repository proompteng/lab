"""Bounded runtime proof for one permit-fenced Alpaca paper submission."""

from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from multiprocessing import TimeoutError as MultiprocessingTimeoutError
from multiprocessing.pool import ThreadPool
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
class InfrastructureValidationSubmitContext:
    """Runtime dependencies and bounded waits for one validation exercise."""

    client: _ValidationAlpacaClient
    session_factory: Callable[[], Session]
    configured_account_label: str
    evaluated_at: datetime | None = None
    race_timeout_seconds: float = 10.0
    terminal_timeout_seconds: float = 30.0


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
class _ValidationPreflight:
    account_label: str
    broker_account_number: str
    position_count: int
    open_order_count: int
    firewall: OrderFirewall
    request: InfrastructureValidationOrderSubmission


@dataclass(frozen=True, slots=True)
class _SubmissionRaceState:
    broker_started: threading.Event
    contender_resolved: threading.Event
    contender_fenced: threading.Event
    call_counter: _BrokerCallCounter


@dataclass(frozen=True, slots=True)
class _SubmissionRaceProof:
    outcomes: tuple[str, ...]
    replay_outcome: str
    broker_call_count: int


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


@dataclass(frozen=True, slots=True)
class _ReceiptProof:
    receipt_id: object
    receipt_state: str
    settlement_outcome: str
    broker_reference: str
    receipt_count: int


@dataclass(frozen=True, slots=True)
class _CandidateEvidenceProof:
    submission_claim_count: int
    execution_count: int
    trade_decision_count: int


@dataclass(frozen=True, slots=True)
class _OrderEventProof:
    order_event_count: int
    linked_order_event_count: int
    untagged_order_event_count: int
    tigerbeetle_transfer_ref_count: int


@dataclass(frozen=True, slots=True)
class _TerminalProof:
    client_order_id: str
    broker_order_id: str
    broker_order_status: str
    position_count: int
    open_order_count: int
    database: _DatabaseProof


def run_infrastructure_validation_submit(
    *,
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
    context: InfrastructureValidationSubmitContext,
) -> InfrastructureValidationSubmitReport:
    """Race one duplicate intent and prove one broker call plus one receipt."""

    account_label, evaluated_at = _validate_submit_context(permit, context)
    preflight = _prepare_validation_preflight(
        permit,
        plan,
        context,
        account_label,
        evaluated_at,
    )
    race = _run_submission_race(permit, plan, preflight, context)
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    terminal = _collect_terminal_proof(
        context,
        client_order_id=client_order_id,
    )
    return _build_submit_report(permit, preflight, race, terminal)


def _validate_submit_context(
    permit: InfrastructureValidationPermit,
    context: InfrastructureValidationSubmitContext,
) -> tuple[str, datetime]:
    account_label = context.configured_account_label.strip()
    if not account_label or account_label != permit.account_label:
        raise RuntimeError("infrastructure_validation_configured_account_mismatch")
    evaluated_at = context.evaluated_at or datetime.now(timezone.utc)
    if evaluated_at.tzinfo is None:
        raise ValueError("infrastructure_validation_now_must_be_timezone_aware")
    for timeout in (context.race_timeout_seconds, context.terminal_timeout_seconds):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("infrastructure_validation_timeout_must_be_positive")
    return account_label, evaluated_at


def _prepare_validation_preflight(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
    context: InfrastructureValidationSubmitContext,
    account_label: str,
    evaluated_at: datetime,
) -> _ValidationPreflight:
    client = context.client
    if client.endpoint_class != "paper":
        raise RuntimeError("infrastructure_validation_client_not_paper")
    authorize_infrastructure_validation_order(
        permit,
        plan,
        account_label=account_label,
        broker_base_url=client.endpoint_url,
        now=evaluated_at,
    )
    account = client.get_account()
    broker_account_number = _validate_broker_account(
        account,
        permit=permit,
    )
    _validate_broker_asset(client.get_asset(plan.symbol))
    positions = client.list_positions()
    open_orders = client.list_open_orders()
    if positions or open_orders:
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
        endpoint_url=client.endpoint_url,
    )
    return _ValidationPreflight(
        account_label=account_label,
        broker_account_number=broker_account_number,
        position_count=len(positions),
        open_order_count=len(open_orders),
        firewall=firewall,
        request=request,
    )


def _run_submission_race(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
    preflight: _ValidationPreflight,
    context: InfrastructureValidationSubmitContext,
) -> _SubmissionRaceProof:
    state = _SubmissionRaceState(
        broker_started=threading.Event(),
        contender_resolved=threading.Event(),
        contender_fenced=threading.Event(),
        call_counter=_BrokerCallCounter(),
    )
    callbacks = _build_submission_callbacks(
        permit,
        plan,
        preflight,
        context,
        state,
    )

    def submit(component: str) -> _WorkerResult:
        return _submit_validation_candidate(
            component,
            session_factory=context.session_factory,
            request=preflight.request,
            callbacks=callbacks,
        )

    race_results = _race_validation_submissions(
        submit,
        state=state,
        timeout_seconds=context.race_timeout_seconds,
    )
    _require_valid_race_results(race_results, state.call_counter.value)
    replay = submit("validation-replay")
    if replay.outcome != "already_processed":
        raise RuntimeError("infrastructure_validation_replay_not_fenced")
    return _SubmissionRaceProof(
        outcomes=tuple(result.outcome for result in race_results),
        replay_outcome=replay.outcome,
        broker_call_count=state.call_counter.value,
    )


def _build_submission_callbacks(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationOrderPlan,
    preflight: _ValidationPreflight,
    context: InfrastructureValidationSubmitContext,
    state: _SubmissionRaceState,
) -> UnlinkedOrderSubmissionCallbacks[Mapping[str, object]]:
    broker_call_lock = threading.Lock()

    def broker_call(mutation_permit: BrokerMutationIoPermit) -> Mapping[str, object]:
        with broker_call_lock:
            state.call_counter.value += 1
        state.broker_started.set()
        if not state.contender_resolved.wait(timeout=context.race_timeout_seconds):
            raise RuntimeError("infrastructure_validation_race_contender_timeout")
        if not state.contender_fenced.is_set():
            raise RuntimeError("infrastructure_validation_race_contender_not_fenced")
        return preflight.firewall.submit_verified_infrastructure_validation_order(
            permit,
            plan,
            mutation_permit=mutation_permit,
        )

    return UnlinkedOrderSubmissionCallbacks(
        broker_call=broker_call,
        persist_terminal=lambda _result: None,
        build_settlement=lambda result: _validation_settlement(
            result,
            permit=permit,
            plan=plan,
        ),
    )


def _submit_validation_candidate(
    component: str,
    *,
    session_factory: Callable[[], Session],
    request: InfrastructureValidationOrderSubmission,
    callbacks: UnlinkedOrderSubmissionCallbacks[Mapping[str, object]],
) -> _WorkerResult:
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


def _race_validation_submissions(
    submit: Callable[[str], _WorkerResult],
    *,
    state: _SubmissionRaceState,
    timeout_seconds: float,
) -> tuple[_WorkerResult, _WorkerResult]:
    deadline = time.monotonic() + timeout_seconds
    pool = ThreadPool(processes=2)
    try:
        winner = pool.apply_async(submit, ("validation-primary",))
        if not state.broker_started.wait(timeout=max(0.0, deadline - time.monotonic())):
            raise RuntimeError("infrastructure_validation_broker_boundary_timeout")
        contender = pool.apply_async(submit, ("validation-contender",))
        contender_result = contender.get(timeout=max(0.0, deadline - time.monotonic()))
        if contender_result.outcome != "deferred":
            raise RuntimeError("infrastructure_validation_race_contender_not_fenced")
        state.contender_fenced.set()
        state.contender_resolved.set()
        winner_result = winner.get(timeout=max(0.0, deadline - time.monotonic()))
    except MultiprocessingTimeoutError as exc:
        raise TimeoutError("infrastructure_validation_race_timeout") from exc
    finally:
        state.contender_resolved.set()
        # ThreadPool workers are daemons and terminate() does not join a hung task.
        # ThreadPoolExecutor workers are joined at interpreter exit even after
        # shutdown(wait=False), which cannot enforce this one-shot CLI deadline.
        pool.terminate()
    return winner_result, contender_result


def _require_valid_race_results(
    race_results: tuple[_WorkerResult, _WorkerResult],
    broker_call_count: int,
) -> None:
    if sorted(result.outcome for result in race_results) != ["deferred", "submitted"]:
        reasons = ";".join(
            f"{result.outcome}:{result.error or 'none'}" for result in race_results
        )
        raise RuntimeError(f"infrastructure_validation_race_outcome_invalid:{reasons}")
    if broker_call_count != 1:
        raise RuntimeError("infrastructure_validation_broker_call_count_invalid")
    submitted = next(result for result in race_results if result.outcome == "submitted")
    if submitted.broker_result is None:
        raise RuntimeError("infrastructure_validation_broker_result_missing")


def _collect_terminal_proof(
    context: InfrastructureValidationSubmitContext,
    *,
    client_order_id: str,
) -> _TerminalProof:
    broker_order = _wait_for_terminal_order(
        context.client,
        client_order_id=client_order_id,
        timeout_seconds=context.terminal_timeout_seconds,
    )
    terminal_positions, terminal_orders = _wait_for_known_null_account(
        context.client,
        timeout_seconds=context.terminal_timeout_seconds,
    )
    database = _load_database_proof(
        context.session_factory,
        client_order_id=client_order_id,
    )
    broker_order_id = str(broker_order.get("id") or "").strip()
    if broker_order_id != database.broker_reference:
        raise RuntimeError("infrastructure_validation_broker_reference_mismatch")
    return _TerminalProof(
        client_order_id=client_order_id,
        broker_order_id=broker_order_id,
        broker_order_status=str(broker_order.get("status") or "").lower(),
        position_count=len(terminal_positions),
        open_order_count=len(terminal_orders),
        database=database,
    )


def _build_submit_report(
    permit: InfrastructureValidationPermit,
    preflight: _ValidationPreflight,
    race: _SubmissionRaceProof,
    terminal: _TerminalProof,
) -> InfrastructureValidationSubmitReport:
    database = terminal.database
    return InfrastructureValidationSubmitReport(
        schema_version="torghut.infrastructure-validation-submit-report.v1",
        observed_at=datetime.now(timezone.utc).isoformat(),
        permit_id=permit.permit_id,
        permit_sha256=infrastructure_validation_permit_sha256(permit),
        broker_account_number=preflight.broker_account_number,
        client_order_id=terminal.client_order_id,
        broker_order_id=terminal.broker_order_id,
        broker_order_status=terminal.broker_order_status,
        receipt_id=str(database.receipt_id),
        receipt_state=database.receipt_state,
        settlement_outcome=database.settlement_outcome,
        race_outcomes=race.outcomes,
        replay_outcome=race.replay_outcome,
        broker_call_count=race.broker_call_count,
        receipt_count=database.receipt_count,
        submission_claim_count=database.submission_claim_count,
        execution_count=database.execution_count,
        trade_decision_count=database.trade_decision_count,
        order_event_count=database.order_event_count,
        linked_order_event_count=database.linked_order_event_count,
        tigerbeetle_transfer_ref_count=database.tigerbeetle_transfer_ref_count,
        preflight_position_count=preflight.position_count,
        preflight_open_order_count=preflight.open_order_count,
        terminal_position_count=terminal.position_count,
        terminal_open_order_count=terminal.open_order_count,
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
        receipt = _load_receipt_proof(session, client_order_id)
        candidate = _load_candidate_evidence_proof(session, client_order_id)
        order_events = _load_order_event_proof(session, client_order_id)
    if any(
        (
            candidate.submission_claim_count,
            candidate.execution_count,
            candidate.trade_decision_count,
        )
    ):
        raise RuntimeError("infrastructure_validation_candidate_evidence_leak")
    if order_events.linked_order_event_count or order_events.untagged_order_event_count:
        raise RuntimeError("infrastructure_validation_order_event_evidence_leak")
    if order_events.tigerbeetle_transfer_ref_count:
        raise RuntimeError("infrastructure_validation_ledger_evidence_leak")
    return _DatabaseProof(
        receipt_id=receipt.receipt_id,
        receipt_state=receipt.receipt_state,
        settlement_outcome=receipt.settlement_outcome,
        broker_reference=receipt.broker_reference,
        receipt_count=receipt.receipt_count,
        submission_claim_count=candidate.submission_claim_count,
        execution_count=candidate.execution_count,
        trade_decision_count=candidate.trade_decision_count,
        order_event_count=order_events.order_event_count,
        linked_order_event_count=order_events.linked_order_event_count,
        tigerbeetle_transfer_ref_count=order_events.tigerbeetle_transfer_ref_count,
    )


def _load_receipt_proof(session: Session, client_order_id: str) -> _ReceiptProof:
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
    _require_non_promotable_receipt(receipt.canonical_intent_json)
    return _ReceiptProof(
        receipt_id=receipt.id,
        receipt_state=latest.state,
        settlement_outcome=cast(str, latest.settlement_outcome),
        broker_reference=broker_reference,
        receipt_count=len(receipts),
    )


def _require_non_promotable_receipt(canonical_intent_json: str) -> None:
    intent = json.loads(canonical_intent_json)
    validation = intent["request"]["infrastructure_validation"]
    if (
        validation["permit"]["evidence_tag"] != "non_promotable_validation"
        or validation["permit"]["promotable"] is not False
    ):
        raise RuntimeError("infrastructure_validation_evidence_tag_invalid")


def _load_candidate_evidence_proof(
    session: Session,
    client_order_id: str,
) -> _CandidateEvidenceProof:
    submission_claim_count = session.scalar(
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
    return _CandidateEvidenceProof(
        submission_claim_count=int(submission_claim_count or 0),
        execution_count=int(execution_count or 0),
        trade_decision_count=int(trade_decision_count or 0),
    )


def _load_order_event_proof(
    session: Session,
    client_order_id: str,
) -> _OrderEventProof:
    events = session.execute(
        select(
            ExecutionOrderEvent.id,
            ExecutionOrderEvent.execution_id,
            ExecutionOrderEvent.trade_decision_id,
            ExecutionOrderEvent.raw_event,
        ).where(ExecutionOrderEvent.client_order_id == client_order_id)
    ).all()
    linked_count = sum(
        1
        for event in events
        if event.execution_id is not None or event.trade_decision_id is not None
    )
    untagged_count = sum(
        1 for event in events if not is_non_promotable_validation_event(event.raw_event)
    )
    event_ids = [event.id for event in events]
    transfer_ref_count = _load_tigerbeetle_transfer_ref_count(session, event_ids)
    return _OrderEventProof(
        order_event_count=len(events),
        linked_order_event_count=linked_count,
        untagged_order_event_count=untagged_count,
        tigerbeetle_transfer_ref_count=transfer_ref_count,
    )


def _load_tigerbeetle_transfer_ref_count(
    session: Session,
    order_event_ids: list[object],
) -> int:
    if not order_event_ids:
        return 0
    count = session.scalar(
        select(func.count())
        .select_from(TigerBeetleTransferRef)
        .where(TigerBeetleTransferRef.execution_order_event_id.in_(order_event_ids))
    )
    return int(count or 0)


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
        context=InfrastructureValidationSubmitContext(
            client=client,
            session_factory=SessionLocal,
            configured_account_label=settings.trading_account_label,
        ),
    )
    print(json.dumps(report.to_payload(), sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised from the deployed image
    raise SystemExit(main())


__all__ = [
    "InfrastructureValidationSubmitContext",
    "InfrastructureValidationSubmitReport",
    "main",
    "run_infrastructure_validation_submit",
]
