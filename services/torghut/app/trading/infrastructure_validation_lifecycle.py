"""Coordinate one bounded Alpaca-paper broker lifecycle proof."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import cast

from ..alpaca_client import TorghutAlpacaClient
from ..config import settings
from ..db import SessionLocal
from .broker_mutation_coordinator import (
    BrokerMutationAlreadyProcessed,
    InfrastructureValidationOrderSubmission,
    UnlinkedMutationCallbacks,
)
from .broker_mutation_receipts import (
    BrokerMutationIoPermit,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
)
from .infrastructure_validation import (
    InfrastructureValidationLifecyclePlan,
    InfrastructureValidationPermit,
    infrastructure_validation_client_order_id,
    infrastructure_validation_permit_sha256,
)
from .infrastructure_validation_lifecycle_broker import (
    AlpacaPaperLifecycleBroker,
    InfrastructureValidationLifecycleContext,
    LifecycleOrderExpectation,
    decimal_text,
    order_id,
    single_order_id,
)
from .infrastructure_validation_lifecycle_proof import (
    InfrastructureValidationLifecycleProof,
    InfrastructureValidationLifecycleReceiptReport,
    LifecycleOrderIds,
)
from .infrastructure_validation_records import InfrastructureValidationEvidence


@dataclass(frozen=True, slots=True)
class InfrastructureValidationLifecycleReport:
    schema_version: str
    observed_at: str
    permit_id: str
    permit_sha256: str
    broker_account_number: str
    symbol: str
    entry_quantity: str
    partial_close_quantity: str
    residual_quantity: str
    root_client_order_id: str
    root_order_id: str
    resting_close_order_id: str
    replacement_close_order_id: str
    partial_close_order_id: str
    final_flatten_order_id: str
    replay_outcome: str
    root_submit_broker_call_count: int
    receipts: tuple[InfrastructureValidationLifecycleReceiptReport, ...]
    receipt_count: int
    order_event_count: int
    linked_order_event_count: int
    untagged_order_event_count: int
    submission_claim_count: int
    execution_count: int
    trade_decision_count: int
    tigerbeetle_transfer_ref_count: int
    preflight_position_count: int
    preflight_open_order_count: int
    terminal_position_count: int
    terminal_open_order_count: int
    evidence_tag: str
    promotable: bool

    def to_payload(self) -> dict[str, object]:
        return asdict(self)


@dataclass(slots=True)
class _LifecycleState:
    root_call_count: int = 0
    latest_evidence: InfrastructureValidationEvidence | None = None
    completed: bool = False


@dataclass(frozen=True, slots=True)
class _EntryResult:
    client_order_id: str
    order_id: str
    evidence: InfrastructureValidationEvidence
    replay_outcome: str


@dataclass(frozen=True, slots=True)
class _RepricingResult:
    resting_order_id: str
    replacement_order_id: str
    replacement_evidence: InfrastructureValidationEvidence


@dataclass(frozen=True, slots=True)
class _CloseoutResult:
    partial_order_id: str
    final_order_id: str
    final_evidence: InfrastructureValidationEvidence
    residual_quantity: Decimal


def run_infrastructure_validation_lifecycle(
    *,
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationLifecyclePlan,
    context: InfrastructureValidationLifecycleContext,
) -> InfrastructureValidationLifecycleReport:
    """Exercise one entry and five independently fenced reductions."""

    broker = AlpacaPaperLifecycleBroker.prepare(
        permit=permit,
        plan=plan,
        context=context,
    )
    proof = InfrastructureValidationLifecycleProof(context)
    state = _LifecycleState()
    try:
        entry = _enter_position(permit, plan, broker, proof, state)
        repricing = _exercise_repricing(plan, broker, proof, entry.evidence)
        closeout = _exercise_closeout(
            plan,
            broker,
            proof,
            repricing.replacement_evidence,
            state,
        )
        orders = LifecycleOrderIds(
            root=entry.order_id,
            resting_close=repricing.resting_order_id,
            replacement_close=repricing.replacement_order_id,
            partial_close=closeout.partial_order_id,
            final_flatten=closeout.final_order_id,
        )
        database = proof.load_database(
            root_evidence=entry.evidence,
            final_evidence=closeout.final_evidence,
            orders=orders,
        )
        terminal = broker.known_null_snapshot()
        report = InfrastructureValidationLifecycleReport(
            schema_version="torghut.infrastructure-validation-lifecycle-report.v1",
            observed_at=datetime.now(timezone.utc).isoformat(),
            permit_id=permit.permit_id,
            permit_sha256=infrastructure_validation_permit_sha256(permit),
            broker_account_number=broker.broker_account_number,
            symbol=plan.symbol,
            entry_quantity=decimal_text(plan.qty),
            partial_close_quantity=decimal_text(plan.partial_close_qty),
            residual_quantity=decimal_text(closeout.residual_quantity),
            root_client_order_id=entry.client_order_id,
            root_order_id=orders.root,
            resting_close_order_id=orders.resting_close,
            replacement_close_order_id=orders.replacement_close,
            partial_close_order_id=orders.partial_close,
            final_flatten_order_id=orders.final_flatten,
            replay_outcome=entry.replay_outcome,
            root_submit_broker_call_count=state.root_call_count,
            receipts=database.receipts,
            receipt_count=len(database.receipts),
            order_event_count=database.order_event_count,
            linked_order_event_count=database.linked_order_event_count,
            untagged_order_event_count=database.untagged_order_event_count,
            submission_claim_count=database.submission_claim_count,
            execution_count=database.execution_count,
            trade_decision_count=database.trade_decision_count,
            tigerbeetle_transfer_ref_count=(database.tigerbeetle_transfer_ref_count),
            preflight_position_count=0,
            preflight_open_order_count=0,
            terminal_position_count=len(terminal[0]),
            terminal_open_order_count=len(terminal[1]),
            evidence_tag="non_promotable_validation",
            promotable=False,
        )
        state.completed = True
        return report
    finally:
        if not state.completed and state.root_call_count:
            broker.cleanup(latest_evidence=state.latest_evidence)


def _enter_position(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationLifecyclePlan,
    broker: AlpacaPaperLifecycleBroker,
    proof: InfrastructureValidationLifecycleProof,
    state: _LifecycleState,
) -> _EntryResult:
    root_response, replay_outcome = _submit_root_order(permit, plan, broker, state)
    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    order_id_value = broker.require_filled_order(
        broker.wait_order_by_client_id(client_order_id, terminal=True),
        LifecycleOrderExpectation(
            symbol=plan.symbol,
            side="buy",
            quantity=plan.qty,
            client_order_id=client_order_id,
            price_bound=plan.limit_price,
        ),
    )
    if order_id(root_response) != order_id_value:
        raise RuntimeError("infrastructure_validation_root_response_mismatch")
    broker.wait_position(symbol=plan.symbol, quantity=plan.qty)
    evidence = proof.wait_lineage(
        client_order_id=client_order_id,
        order_id=order_id_value,
    )
    state.latest_evidence = evidence
    proof.wait_position(
        evidence=evidence,
        symbol=plan.symbol,
        quantity=plan.qty,
        expected_order_id=order_id_value,
    )
    return _EntryResult(
        client_order_id=client_order_id,
        order_id=order_id_value,
        evidence=evidence,
        replay_outcome=replay_outcome,
    )


def _exercise_repricing(
    plan: InfrastructureValidationLifecyclePlan,
    broker: AlpacaPaperLifecycleBroker,
    proof: InfrastructureValidationLifecycleProof,
    root_evidence: InfrastructureValidationEvidence,
) -> _RepricingResult:
    executor = broker.reduction_executor()
    resting_order_id = order_id(
        executor.submit_crypto_close_order(
            plan.symbol,
            plan.qty,
            limit_price=plan.resting_close_limit_price,
            validation_evidence=root_evidence,
        )
    )
    broker.require_open_zero_fill_order(
        broker.wait_order_by_id(resting_order_id, terminal=False),
        LifecycleOrderExpectation(
            symbol=plan.symbol,
            side="sell",
            quantity=plan.qty,
            order_id=resting_order_id,
            price_bound=plan.resting_close_limit_price,
        ),
    )
    resting_evidence = proof.wait_lineage(
        client_order_id=None,
        order_id=resting_order_id,
    )
    replacement_order_id = order_id(
        executor.replace_order(
            resting_order_id,
            limit_price=plan.replacement_close_limit_price,
        )
    )
    if replacement_order_id == resting_order_id:
        raise RuntimeError("infrastructure_validation_replace_identity_not_rotated")
    broker.wait_replaced_order(resting_order_id)
    broker.require_open_zero_fill_order(
        broker.wait_order_by_id(replacement_order_id, terminal=False),
        LifecycleOrderExpectation(
            symbol=plan.symbol,
            side="sell",
            quantity=plan.qty,
            order_id=replacement_order_id,
            price_bound=plan.replacement_close_limit_price,
        ),
    )
    replacement_evidence = proof.wait_lineage(
        client_order_id=None,
        order_id=replacement_order_id,
    )
    if replacement_evidence.receipt_id == resting_evidence.receipt_id:
        raise RuntimeError("infrastructure_validation_replace_receipt_missing")
    if executor.cancel_order(replacement_order_id) is not True:
        raise RuntimeError("infrastructure_validation_cancel_not_submitted")
    broker.wait_canceled_order(replacement_order_id)
    broker.wait_no_open_orders()
    return _RepricingResult(
        resting_order_id=resting_order_id,
        replacement_order_id=replacement_order_id,
        replacement_evidence=replacement_evidence,
    )


def _exercise_closeout(
    plan: InfrastructureValidationLifecyclePlan,
    broker: AlpacaPaperLifecycleBroker,
    proof: InfrastructureValidationLifecycleProof,
    replacement_evidence: InfrastructureValidationEvidence,
    state: _LifecycleState,
) -> _CloseoutResult:
    executor = broker.reduction_executor()
    partial_order_id = order_id(
        executor.close_position(
            plan.symbol,
            plan.partial_close_qty,
            validation_evidence=replacement_evidence,
        )
    )
    broker.require_filled_order(
        broker.wait_order_by_id(partial_order_id, terminal=True),
        LifecycleOrderExpectation(
            symbol=plan.symbol,
            side="sell",
            quantity=plan.partial_close_qty,
            order_id=partial_order_id,
        ),
    )
    residual_quantity = plan.qty - plan.partial_close_qty
    broker.wait_position(symbol=plan.symbol, quantity=residual_quantity)
    partial_evidence = proof.wait_lineage(
        client_order_id=None,
        order_id=partial_order_id,
    )
    state.latest_evidence = partial_evidence
    proof.wait_position(
        evidence=partial_evidence,
        symbol=plan.symbol,
        quantity=residual_quantity,
        expected_order_id=partial_order_id,
    )
    final_order_id = single_order_id(
        executor.close_all_positions(validation_evidence=partial_evidence)
    )
    broker.require_filled_order(
        broker.wait_order_by_id(final_order_id, terminal=True),
        LifecycleOrderExpectation(
            symbol=plan.symbol,
            side="sell",
            quantity=residual_quantity,
            order_id=final_order_id,
        ),
    )
    broker.wait_known_null_account(broker.context.order_timeout_seconds)
    final_evidence = proof.wait_lineage(
        client_order_id=None,
        order_id=final_order_id,
    )
    proof.wait_flat_position(
        evidence=final_evidence,
        symbol=plan.symbol,
        expected_order_id=final_order_id,
    )
    return _CloseoutResult(
        partial_order_id=partial_order_id,
        final_order_id=final_order_id,
        final_evidence=final_evidence,
        residual_quantity=residual_quantity,
    )


def _submit_root_order(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationLifecyclePlan,
    broker: AlpacaPaperLifecycleBroker,
    state: _LifecycleState,
) -> tuple[Mapping[str, object], str]:
    request = InfrastructureValidationOrderSubmission(
        permit=permit,
        plan=plan,
        account_label=broker.account_label,
        endpoint_url=broker.context.client.endpoint_url,
    )

    def broker_call(mutation_permit: BrokerMutationIoPermit) -> Mapping[str, object]:
        state.root_call_count += 1
        return broker.firewall.submit_verified_infrastructure_validation_order(
            permit,
            plan,
            mutation_permit=mutation_permit,
            now=broker.evaluated_at,
        )

    callbacks = UnlinkedMutationCallbacks(
        broker_call=broker_call,
        persist_terminal=lambda _result: None,
        build_settlement=lambda result: build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="primary",
                outcome="acknowledged",
                broker_reference=order_id(result),
                execution_id=None,
                evidence_payload={
                    "schema_version": (
                        "torghut.infrastructure-validation-lifecycle-root-terminal.v1"
                    ),
                    "client_order_id": infrastructure_validation_client_order_id(
                        permit,
                        plan,
                    ),
                    "evidence_tag": "non_promotable_validation",
                    "permit_id": permit.permit_id,
                    "permit_sha256": infrastructure_validation_permit_sha256(permit),
                    "promotable": False,
                    "status": str(result.get("status") or "unknown").lower(),
                },
            )
        ),
    )
    with broker.context.session_factory() as session:
        response = broker.coordinator.submit_infrastructure_validation_order(
            session,
            request=request,
            callbacks=callbacks,
            now=broker.evaluated_at,
        )
    try:
        with broker.context.session_factory() as session:
            broker.coordinator.submit_infrastructure_validation_order(
                session,
                request=request,
                callbacks=callbacks,
                now=broker.evaluated_at,
            )
    except BrokerMutationAlreadyProcessed:
        replay_outcome = "already_processed"
    else:
        raise RuntimeError("infrastructure_validation_lifecycle_replay_not_fenced")
    if state.root_call_count != 1:
        raise RuntimeError("infrastructure_validation_root_broker_call_count_invalid")
    return response, replay_outcome


def _load_input(
    path: str,
) -> tuple[InfrastructureValidationPermit, InfrastructureValidationLifecyclePlan]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise ValueError("infrastructure_validation_input_must_be_object")
    values = cast(Mapping[str, object], payload)
    return (
        InfrastructureValidationPermit.model_validate(values.get("permit")),
        InfrastructureValidationLifecyclePlan.model_validate(values.get("plan")),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run one bounded Alpaca-paper broker lifecycle proof."
    )
    parser.add_argument(
        "--input-file",
        required=True,
        help="JSON file containing permit and lifecycle plan, or - for stdin.",
    )
    args = parser.parse_args(argv)
    permit, plan = _load_input(args.input_file)
    report = run_infrastructure_validation_lifecycle(
        permit=permit,
        plan=plan,
        context=InfrastructureValidationLifecycleContext(
            client=TorghutAlpacaClient(),
            session_factory=SessionLocal,
            configured_account_label=settings.trading_account_label,
        ),
    )
    print(json.dumps(report.to_payload(), sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - deployed-image entrypoint
    raise SystemExit(main())


__all__ = [
    "InfrastructureValidationLifecycleContext",
    "InfrastructureValidationLifecycleReceiptReport",
    "InfrastructureValidationLifecycleReport",
    "main",
    "run_infrastructure_validation_lifecycle",
]
