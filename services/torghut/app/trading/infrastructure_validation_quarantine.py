"""Close only paper-IOC validation quarantines without inventing broker truth."""

from __future__ import annotations

import argparse
import json
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol, cast

from sqlalchemy.orm import Session

from ..alpaca_client import AlpacaRecoveryOrderHistoryPage, TorghutAlpacaClient
from ..db import SessionLocal
from .broker_mutation_receipts import (
    BrokerMutationReceiptSnapshot,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
    fingerprint_broker_endpoint,
    get_broker_mutation_receipt,
    settle_broker_mutation_operator_confirmation,
)


VALIDATION_QUARANTINE_CONFIRMATION = "CLOSE_PAPER_IOC_VALIDATION_QUARANTINE"
VALIDATION_QUARANTINE_SCHEMA_VERSION = (
    "torghut.infrastructure-validation-quarantine-closure.v1"
)
_PAPER_ENDPOINT = "https://paper-api.alpaca.markets"
_PAPER_ENDPOINT_FINGERPRINT = fingerprint_broker_endpoint(_PAPER_ENDPOINT)
_HISTORY_LIMIT = 500
_HISTORY_MARGIN = timedelta(minutes=5)
_MINIMUM_IO_AGE = timedelta(minutes=1)
_WRITER_GENERATION = max(1, time.time_ns())


class InfrastructureValidationQuarantineError(RuntimeError):
    """A validation receipt or fresh broker read is not safe to close."""


class _ValidationBrokerReader(Protocol):
    endpoint_url: str
    endpoint_class: str

    def get_account(self) -> dict[str, object]: ...

    def get_order_by_client_order_id_strict(
        self, client_order_id: str
    ) -> dict[str, object] | None: ...

    def list_orders_recovery_window(
        self,
        *,
        after: datetime,
        until: datetime,
        limit: int = _HISTORY_LIMIT,
    ) -> AlpacaRecoveryOrderHistoryPage: ...

    def list_open_orders(self) -> list[dict[str, object]]: ...

    def list_positions(self) -> list[dict[str, object]]: ...


SessionFactory = Callable[[], Session]


@dataclass(frozen=True, slots=True)
class InfrastructureValidationQuarantineRequest:
    receipt_id: uuid.UUID | str
    expected_intent_sha256: str
    operator_id: str
    support_confirmation_reference: str | None = None


@dataclass(frozen=True, slots=True)
class InfrastructureValidationQuarantineContext:
    client: _ValidationBrokerReader
    session_factory: SessionFactory
    evaluated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class InfrastructureValidationQuarantineReport:
    receipt_id: uuid.UUID
    client_order_id: str
    intent_sha256: str
    applied: bool
    receipt_state: str
    settlement_outcome: str | None
    evidence_sha256: str

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": VALIDATION_QUARANTINE_SCHEMA_VERSION,
            "receipt_id": str(self.receipt_id),
            "client_order_id": self.client_order_id,
            "intent_sha256": self.intent_sha256,
            "applied": self.applied,
            "receipt_state": self.receipt_state,
            "settlement_outcome": self.settlement_outcome,
            "evidence_sha256": self.evidence_sha256,
        }


@dataclass(frozen=True, slots=True)
class _NormalizedRequest:
    receipt_id: uuid.UUID
    expected_intent_sha256: str
    operator_id: str
    support_confirmation_reference: str | None


@dataclass(frozen=True, slots=True)
class _BrokerProof:
    observed_at: datetime
    account_number: str
    account_status: str
    history_count: int


def run_infrastructure_validation_quarantine_close(
    *,
    request: InfrastructureValidationQuarantineRequest,
    context: InfrastructureValidationQuarantineContext,
    apply: bool = False,
) -> InfrastructureValidationQuarantineReport:
    """Inspect or close one exact non-promotable paper-IOC quarantine."""

    normalized = _normalize_request(request)
    observed_at = _evaluated_at(context.evaluated_at)
    with context.session_factory() as session:
        receipt = get_broker_mutation_receipt(session, normalized.receipt_id)
    if receipt is None:
        raise InfrastructureValidationQuarantineError(
            f"validation_quarantine_receipt_not_found:{normalized.receipt_id}"
        )
    document = _require_eligible_receipt(
        receipt,
        expected_intent_sha256=normalized.expected_intent_sha256,
        observed_at=observed_at,
    )
    proof = _read_broker_proof(
        context.client,
        receipt=receipt,
        observed_at=observed_at,
    )
    settlement = _build_quarantine_settlement(
        receipt,
        document=document,
        request=normalized,
        proof=proof,
    )
    if not apply:
        return _report(
            receipt,
            settlement=settlement,
            applied=False,
        )
    with context.session_factory() as session:
        settled = settle_broker_mutation_operator_confirmation(
            session,
            receipt_id=receipt.receipt_id,
            writer_generation=_WRITER_GENERATION,
            settlement=settlement,
        )
    return _report(settled, settlement=settlement, applied=True)


def _normalize_request(
    request: InfrastructureValidationQuarantineRequest,
) -> _NormalizedRequest:
    try:
        receipt_id = uuid.UUID(str(request.receipt_id))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("validation_quarantine_receipt_id_invalid") from exc
    intent_sha256 = _sha256(request.expected_intent_sha256, field="intent_sha256")
    operator_id = _required_text(request.operator_id, field="operator_id", maximum=128)
    support_reference = _optional_text(
        request.support_confirmation_reference,
        field="support_confirmation_reference",
        maximum=256,
    )
    return _NormalizedRequest(
        receipt_id=receipt_id,
        expected_intent_sha256=intent_sha256,
        operator_id=operator_id,
        support_confirmation_reference=support_reference,
    )


def _evaluated_at(value: datetime | None) -> datetime:
    observed_at = value or datetime.now(timezone.utc)
    if observed_at.tzinfo is None:
        raise ValueError("validation_quarantine_evaluated_at_timezone_required")
    return observed_at.astimezone(timezone.utc)


def _require_eligible_receipt(
    receipt: BrokerMutationReceiptSnapshot,
    *,
    expected_intent_sha256: str,
    observed_at: datetime,
) -> dict[str, object]:
    intent = receipt.intent
    started_at = receipt.lifecycle.broker_io_started_at
    if (
        intent.canonical_intent_sha256 != expected_intent_sha256
        or receipt.state != "broker_io"
        or intent.broker_route != "alpaca"
        or intent.endpoint_fingerprint != _PAPER_ENDPOINT_FINGERPRINT
        or intent.operation != "submit_order"
        or intent.risk_class != "risk_neutral"
        or intent.purpose != "control_plane_validation"
        or intent.submission_claim_id is not None
        or started_at is None
        or observed_at - started_at < _MINIMUM_IO_AGE
    ):
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_receipt_ineligible"
        )
    document = _json_object(
        intent.canonical_intent_json,
        error="validation_quarantine_intent_invalid",
    )
    request = _mapping(
        document.get("request"), error="validation_quarantine_intent_invalid"
    )
    broker_request = _mapping(
        request.get("broker_request"),
        error="validation_quarantine_intent_invalid",
    )
    validation = _mapping(
        request.get("infrastructure_validation"),
        error="validation_quarantine_intent_invalid",
    )
    permit = _mapping(
        validation.get("permit"),
        error="validation_quarantine_intent_invalid",
    )
    if (
        _text(broker_request.get("time_in_force")).lower() != "ioc"
        or _text(permit.get("account_mode")).lower() != "paper"
        or permit.get("promotable") is not False
        or permit.get("evidence_tag") != "non_promotable_validation"
        or broker_request.get("extra_params")
        != {"client_order_id": intent.client_request_id}
    ):
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_intent_ineligible"
        )
    _require_expired_absence_evidence(receipt)
    return document


def _require_expired_absence_evidence(
    receipt: BrokerMutationReceiptSnapshot,
) -> None:
    if receipt.recovery.outcome != "not_found" or not receipt.recovery.evidence_json:
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_absence_evidence_required"
        )
    evidence = _json_object(
        receipt.recovery.evidence_json,
        error="validation_quarantine_absence_evidence_invalid",
    )
    observation = _mapping(
        evidence.get("observation"),
        error="validation_quarantine_absence_evidence_invalid",
    )
    if (
        observation.get("resolution_state") != "expired"
        or observation.get("absence_proof_complete") is not True
        or observation.get("operator_confirmation_required") is not True
        or observation.get("automatic_resubmission_attempted") is not False
    ):
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_absence_evidence_ineligible"
        )


def _read_broker_proof(
    client: _ValidationBrokerReader,
    *,
    receipt: BrokerMutationReceiptSnapshot,
    observed_at: datetime,
) -> _BrokerProof:
    if (
        client.endpoint_class != "paper"
        or fingerprint_broker_endpoint(client.endpoint_url)
        != receipt.intent.endpoint_fingerprint
    ):
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_broker_endpoint_mismatch"
        )
    account = client.get_account()
    account_number = _text(account.get("account_number"))
    account_status = _text(account.get("status")).upper()
    if account_number != receipt.intent.account_label or account_status != "ACTIVE":
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_broker_account_mismatch"
        )
    if any(
        account.get(field) is True
        for field in (
            "account_blocked",
            "trading_blocked",
            "trade_suspended_by_user",
            "transfers_blocked",
        )
    ):
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_broker_account_blocked"
        )
    if (
        client.get_order_by_client_order_id_strict(receipt.intent.client_request_id)
        is not None
    ):
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_exact_order_found"
        )
    started_at = receipt.lifecycle.broker_io_started_at
    if started_at is None:  # pragma: no cover - eligibility checked above
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_broker_io_timestamp_missing"
        )
    history = client.list_orders_recovery_window(
        after=started_at - _HISTORY_MARGIN,
        until=observed_at,
        limit=_HISTORY_LIMIT,
    )
    matches = tuple(
        order
        for order in history.orders
        if _text(order.get("client_order_id")) == receipt.intent.client_request_id
    )
    if not history.complete or matches:
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_order_history_incomplete_or_matched"
        )
    open_orders = client.list_open_orders()
    positions = client.list_positions()
    if open_orders or positions:
        raise InfrastructureValidationQuarantineError(
            "validation_quarantine_account_not_flat"
        )
    return _BrokerProof(
        observed_at=observed_at,
        account_number=account_number,
        account_status=account_status,
        history_count=len(history.orders),
    )


def _build_quarantine_settlement(
    receipt: BrokerMutationReceiptSnapshot,
    *,
    document: Mapping[str, object],
    request: _NormalizedRequest,
    proof: _BrokerProof,
) -> BrokerMutationSettlement:
    intent_request = _mapping(
        document.get("request"),
        error="validation_quarantine_intent_invalid",
    )
    validation = _mapping(
        intent_request.get("infrastructure_validation"),
        error="validation_quarantine_intent_invalid",
    )
    permit = _mapping(
        validation.get("permit"),
        error="validation_quarantine_intent_invalid",
    )
    evidence_payload: dict[str, object] = {
        "schema_version": VALIDATION_QUARANTINE_SCHEMA_VERSION,
        "receipt_id": str(receipt.receipt_id),
        "client_order_id": receipt.intent.client_request_id,
        "intent_sha256": receipt.intent.canonical_intent_sha256,
        "account_label": receipt.intent.account_label,
        "endpoint_fingerprint": receipt.intent.endpoint_fingerprint,
        "operator_id": request.operator_id,
        "support_confirmation_reference": request.support_confirmation_reference,
        "confirmation_reason": "paper_ioc_future_exposure_impossible",
        "order_existence_resolution": "unresolved",
        "prior_recovery_evidence_sha256": receipt.recovery.evidence_sha256,
        "exact_client_order_lookup": "not_found",
        "history_complete": True,
        "history_count": proof.history_count,
        "history_match_count": 0,
        "open_order_count": 0,
        "position_count": 0,
        "account_number": proof.account_number,
        "account_status": proof.account_status,
        "account_blocked": False,
        "trading_blocked": False,
        "transfers_blocked": False,
        "time_in_force": "ioc",
        "evidence_tag": permit.get("evidence_tag"),
        "promotable": False,
        "automatic_resubmission_attempted": False,
        "broker_mutation_attempted": False,
        "observed_at": proof.observed_at.isoformat().replace("+00:00", "Z"),
    }
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="operator_confirmation",
            outcome="validation_quarantine_closed",
            broker_reference=None,
            execution_id=None,
            evidence_payload=evidence_payload,
        )
    )


def _report(
    receipt: BrokerMutationReceiptSnapshot,
    *,
    settlement: BrokerMutationSettlement,
    applied: bool,
) -> InfrastructureValidationQuarantineReport:
    return InfrastructureValidationQuarantineReport(
        receipt_id=receipt.receipt_id,
        client_order_id=receipt.intent.client_request_id,
        intent_sha256=receipt.intent.canonical_intent_sha256,
        applied=applied,
        receipt_state=receipt.state,
        settlement_outcome=(
            receipt.settlement.outcome if applied else settlement.outcome
        ),
        evidence_sha256=settlement.evidence_sha256,
    )


def _json_object(value: str, *, error: str) -> dict[str, object]:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError) as exc:
        raise InfrastructureValidationQuarantineError(error) from exc
    if not isinstance(parsed, dict):
        raise InfrastructureValidationQuarantineError(error)
    return cast(dict[str, object], parsed)


def _mapping(value: object, *, error: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise InfrastructureValidationQuarantineError(error)
    raw = cast(Mapping[object, object], value)
    if any(not isinstance(key, str) for key in raw):
        raise InfrastructureValidationQuarantineError(error)
    return {cast(str, key): item for key, item in raw.items()}


def _required_text(value: object, *, field: str, maximum: int) -> str:
    normalized = _text(value)
    if not normalized or len(normalized) > maximum:
        raise ValueError(f"validation_quarantine_{field}_invalid")
    return normalized


def _optional_text(value: object, *, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    return _required_text(value, field=field, maximum=maximum)


def _sha256(value: object, *, field: str) -> str:
    normalized = _required_text(value, field=field, maximum=64).lower()
    if len(normalized) != 64 or any(
        character not in "0123456789abcdef" for character in normalized
    ):
        raise ValueError(f"validation_quarantine_{field}_invalid")
    return normalized


def _text(value: object) -> str:
    enum_value = getattr(value, "value", value)
    return "" if enum_value is None else str(enum_value).strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect or close one exact paper-IOC validation quarantine."
    )
    parser.add_argument("--receipt-id", required=True)
    parser.add_argument("--expected-intent-sha256", required=True)
    parser.add_argument("--operator-id", required=True)
    parser.add_argument("--support-confirmation-reference")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args(argv)
    if args.apply and args.confirm != VALIDATION_QUARANTINE_CONFIRMATION:
        raise SystemExit(
            "--apply requires --confirm " + VALIDATION_QUARANTINE_CONFIRMATION
        )
    report = run_infrastructure_validation_quarantine_close(
        request=InfrastructureValidationQuarantineRequest(
            receipt_id=args.receipt_id,
            expected_intent_sha256=args.expected_intent_sha256,
            operator_id=args.operator_id,
            support_confirmation_reference=args.support_confirmation_reference,
        ),
        context=InfrastructureValidationQuarantineContext(
            client=TorghutAlpacaClient(),
            session_factory=SessionLocal,
        ),
        apply=bool(args.apply),
    )
    print(json.dumps(report.to_payload(), sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised from the deployed image
    raise SystemExit(main())


__all__ = [
    "VALIDATION_QUARANTINE_CONFIRMATION",
    "VALIDATION_QUARANTINE_SCHEMA_VERSION",
    "InfrastructureValidationQuarantineContext",
    "InfrastructureValidationQuarantineError",
    "InfrastructureValidationQuarantineReport",
    "InfrastructureValidationQuarantineRequest",
    "main",
    "run_infrastructure_validation_quarantine_close",
]
