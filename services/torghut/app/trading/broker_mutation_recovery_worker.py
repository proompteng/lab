"""Observation-only recovery for ambiguous durable broker submissions."""

from __future__ import annotations

import json
import logging
import os
import socket
import time
import uuid
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Protocol, cast

from sqlalchemy.orm import Session

from .broker_mutation_receipts import (
    BrokerMutationReceiptSnapshot,
    BrokerMutationRecoveryAcquireOptions,
    BrokerMutationRecoveryHandle,
    BrokerMutationRecoveryObservationRequest,
    BrokerMutationSettlement,
    acquire_broker_mutation_recovery,
    build_broker_mutation_recovery_observation,
    count_unresolved_broker_mutation_receipts,
    get_broker_mutation_receipt,
    list_due_broker_mutation_receipt_ids,
    record_broker_mutation_recovery_observation,
    record_linked_submission_recovery_observation,
    release_broker_mutation_recovery,
    settle_broker_mutation_recovery,
    settle_linked_submission_recovery,
)
from .decision_submission_claims import (
    DecisionSubmissionRecoveryHandle,
    acquire_decision_submission_recovery_claim,
)

logger = logging.getLogger(__name__)


BROKER_MUTATION_RECOVERY_OBSERVATION_SCHEMA_VERSION = (
    "torghut.broker-submit-recovery-observation.v1"
)
BrokerSubmitRecoveryReadOutcome = Literal["found", "not_found", "indeterminate"]
BrokerSubmitRecoveryResolutionState = Literal[
    "submitted_unknown",
    "expired",
    "manual_review",
]
BrokerMutationRecoveryRouteKey = tuple[str, str, str]
SessionFactory = Callable[[], Session]


@dataclass(frozen=True, slots=True)
class BrokerSubmitRecoveryRead:
    """One broker observation with no authority to submit or mutate an order."""

    outcome: BrokerSubmitRecoveryReadOutcome
    evidence: Mapping[str, object]
    broker_order: Mapping[str, object] | None = None


class BrokerMutationRecoveryRoute(Protocol):
    """Route-specific reads and terminal persistence used by the generic worker."""

    @property
    def broker_route(self) -> str: ...

    @property
    def account_label(self) -> str: ...

    @property
    def endpoint_fingerprint(self) -> str: ...

    def observe(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        observed_at: datetime,
    ) -> BrokerSubmitRecoveryRead: ...

    def independent_activity(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> tuple[str, ...]: ...

    def build_found_settlement(
        self,
        session: Session,
        receipt: BrokerMutationReceiptSnapshot,
        read: BrokerSubmitRecoveryRead,
    ) -> BrokerMutationSettlement: ...


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryPolicy:
    batch_size: int = 50
    lease_seconds: int = 60
    retry_seconds: int = 30
    absence_grace_seconds: int = 300
    absence_observation_spacing_seconds: int = 30
    manual_review_after_seconds: int = 1800
    manual_review_retry_seconds: int = 3600

    def __post_init__(self) -> None:
        bounded = {
            "batch_size": (self.batch_size, 1, 1000),
            "lease_seconds": (self.lease_seconds, 5, 300),
            "retry_seconds": (self.retry_seconds, 30, 3600),
            "manual_review_retry_seconds": (
                self.manual_review_retry_seconds,
                30,
                3600,
            ),
        }
        for field_name, (value, minimum, maximum) in bounded.items():
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(
                    f"broker_mutation_recovery_{field_name}_outside_bounds"
                )
        nonnegative = {
            "absence_grace_seconds": self.absence_grace_seconds,
            "absence_observation_spacing_seconds": (
                self.absence_observation_spacing_seconds
            ),
            "manual_review_after_seconds": self.manual_review_after_seconds,
        }
        for field_name, value in nonnegative.items():
            if type(value) is not int or value < 0:
                raise ValueError(
                    f"broker_mutation_recovery_{field_name}_outside_bounds"
                )
        if self.absence_observation_spacing_seconds > self.absence_grace_seconds:
            raise ValueError("broker_mutation_recovery_absence_spacing_exceeds_grace")
        if self.manual_review_after_seconds < self.absence_grace_seconds:
            raise ValueError("broker_mutation_recovery_manual_review_precedes_grace")


@dataclass(frozen=True, slots=True)
class BrokerMutationRecoveryRunResult:
    enabled: bool
    scanned: int
    outcomes: Mapping[str, int]
    unresolved: int = 0

    @property
    def failed(self) -> int:
        return int(self.outcomes.get("failed", 0))

    @property
    def settled(self) -> int:
        return int(self.outcomes.get("reconciled", 0)) + int(
            self.outcomes.get("rejected", 0)
        )

    @property
    def degraded(self) -> bool:
        return (
            not self.enabled
            or self.failed > 0
            or self.unresolved > 0
            or self.scanned > self.settled
        )


_PROCESS_ID = uuid.uuid4().hex[:12]
_WRITER_GENERATION = max(1, time.time_ns())


def _recovery_writer_identity(component: str) -> tuple[str, int]:
    normalized = component.strip().lower()
    if not normalized or len(normalized) > 32:
        raise ValueError("broker_mutation_recovery_component_invalid")
    hostname = socket.gethostname().strip().lower()[:32] or "unknown-host"
    return (
        f"{normalized}:{hostname}:{os.getpid()}:{_PROCESS_ID}",
        _WRITER_GENERATION,
    )


class BrokerMutationRecoveryWorker:
    """Recover due submit receipts using reads only; this class cannot resubmit."""

    def __init__(
        self,
        *,
        session_factory: SessionFactory,
        routes: tuple[BrokerMutationRecoveryRoute, ...],
        component: str,
        enabled: bool = True,
        policy: BrokerMutationRecoveryPolicy | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._enabled = enabled
        self._policy = policy or BrokerMutationRecoveryPolicy()
        self._owner, self._writer_generation = _recovery_writer_identity(component)
        route_map: dict[
            BrokerMutationRecoveryRouteKey, BrokerMutationRecoveryRoute
        ] = {}
        for route in routes:
            key = _route_key(
                route.broker_route,
                route.account_label,
                route.endpoint_fingerprint,
            )
            if key in route_map:
                raise ValueError("broker_mutation_recovery_route_duplicate")
            route_map[key] = route
        if not route_map:
            raise ValueError("broker_mutation_recovery_route_required")
        self._routes = route_map

    def run_once(self) -> BrokerMutationRecoveryRunResult:
        if not self._enabled:
            return BrokerMutationRecoveryRunResult(False, 0, {"disabled": 1})
        with self._session_factory() as session:
            receipt_ids = list_due_broker_mutation_receipt_ids(
                session,
                limit=self._policy.batch_size,
                route_identities=tuple(sorted(self._routes)),
                operation="submit_order",
            )
        outcomes: Counter[str] = Counter()
        scanned = 0
        for receipt_id in receipt_ids:
            route_receipt = self._route_receipt(receipt_id)
            if route_receipt is None:
                outcomes["receipt_disappeared"] += 1
                continue
            route, receipt = route_receipt
            if (
                receipt.intent.operation != "submit_order"
            ):  # pragma: no cover - query contract
                outcomes["query_contract_mismatch"] += 1
                continue
            scanned += 1
            try:
                outcome = self._recover_one(route, receipt)
            except Exception as exc:
                outcomes["failed"] += 1
                logger.exception(
                    "Broker mutation recovery failed receipt_id=%s error_class=%s",
                    receipt_id,
                    type(exc).__name__,
                )
            else:
                outcomes[outcome] += 1
        with self._session_factory() as session:
            unresolved = count_unresolved_broker_mutation_receipts(
                session,
                route_identities=tuple(sorted(self._routes)),
                operation="submit_order",
            )
        return BrokerMutationRecoveryRunResult(
            enabled=True,
            scanned=scanned,
            outcomes=dict(sorted(outcomes.items())),
            unresolved=unresolved,
        )

    def _route_receipt(
        self,
        receipt_id: uuid.UUID,
    ) -> tuple[BrokerMutationRecoveryRoute, BrokerMutationReceiptSnapshot] | None:
        with self._session_factory() as session:
            receipt = get_broker_mutation_receipt(session, receipt_id)
        if receipt is None:
            return None
        route = self._routes.get(
            _route_key(
                receipt.intent.broker_route,
                receipt.intent.account_label,
                receipt.intent.endpoint_fingerprint,
            )
        )
        if route is None:
            return None
        return route, receipt

    def _recover_one(
        self,
        route: BrokerMutationRecoveryRoute,
        receipt: BrokerMutationReceiptSnapshot,
    ) -> str:
        recovery_token = uuid.uuid4()
        with self._session_factory() as session:
            acquired = acquire_broker_mutation_recovery(
                session,
                receipt_id=receipt.receipt_id,
                recovery_owner=self._owner,
                writer_generation=self._writer_generation,
                options=BrokerMutationRecoveryAcquireOptions(
                    recovery_token=recovery_token,
                    lease_seconds=self._policy.lease_seconds,
                ),
            )
        if not acquired.acquired or acquired.receipt is None:
            return f"receipt_{acquired.outcome}"
        receipt = acquired.receipt
        receipt_handle = _required_receipt_recovery_handle(receipt)
        claim_handle = self._acquire_linked_claim(receipt, receipt_handle)
        if receipt.intent.submission_claim_id is not None and claim_handle is None:
            self._release_receipt(receipt_handle)
            return "claim_unavailable"

        observed_at = datetime.now(timezone.utc)
        try:
            read = _validated_read(route.observe(receipt, observed_at=observed_at))
        except Exception as exc:
            read = BrokerSubmitRecoveryRead(
                outcome="indeterminate",
                evidence={
                    "schema_version": BROKER_MUTATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
                    "route": receipt.intent.broker_route,
                    "lookup_error_class": type(exc).__name__,
                    "absence_proof_complete": False,
                },
            )

        independent_activity: tuple[str, ...] = ()
        if read.outcome == "not_found":
            try:
                with self._session_factory() as session:
                    independent_activity = route.independent_activity(session, receipt)
            except Exception as exc:
                read = BrokerSubmitRecoveryRead(
                    outcome="indeterminate",
                    evidence={
                        **dict(read.evidence),
                        "absence_proof_complete": False,
                        "independent_activity_error_class": type(exc).__name__,
                    },
                )
            else:
                if independent_activity:
                    read = BrokerSubmitRecoveryRead(
                        outcome="indeterminate",
                        evidence={
                            **dict(read.evidence),
                            "absence_proof_complete": False,
                            "independent_activity": list(independent_activity),
                            "conflict": "broker_absence_with_durable_activity",
                        },
                    )

        if read.outcome == "found":
            return self._settle_found(
                route,
                receipt,
                receipt_handle=receipt_handle,
                claim_handle=claim_handle,
                read=read,
            )
        if self._absence_window_expired(
            receipt,
            read=read,
            observed_at=observed_at,
            independent_activity=independent_activity,
        ):
            return self._record_nonterminal(
                receipt,
                receipt_handle=receipt_handle,
                claim_handle=claim_handle,
                read=read,
                observed_at=observed_at,
                resolution_state="expired",
            )
        return self._record_nonterminal(
            receipt,
            receipt_handle=receipt_handle,
            claim_handle=claim_handle,
            read=read,
            observed_at=observed_at,
        )

    def _acquire_linked_claim(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        receipt_handle: BrokerMutationRecoveryHandle,
    ) -> DecisionSubmissionRecoveryHandle | None:
        decision_id = receipt.intent.submission_claim_id
        if decision_id is None:
            return None
        with self._session_factory() as session:
            acquired = acquire_decision_submission_recovery_claim(
                session,
                decision_id=decision_id,
                recovery_owner=self._owner,
                recovery_token=receipt_handle.recovery_token,
                lease_seconds=self._policy.lease_seconds,
            )
        if not acquired.acquired or acquired.claim is None:
            return None
        return acquired.claim.recovery_handle

    def _settle_found(
        self,
        route: BrokerMutationRecoveryRoute,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        receipt_handle: BrokerMutationRecoveryHandle,
        claim_handle: DecisionSubmissionRecoveryHandle | None,
        read: BrokerSubmitRecoveryRead,
    ) -> str:
        with self._session_factory() as session:
            settlement = route.build_found_settlement(session, receipt, read)
            if settlement.outcome not in {"reconciled", "rejected"}:
                raise ValueError("broker_mutation_recovery_settlement_outcome_invalid")
            if claim_handle is None:
                settle_broker_mutation_recovery(
                    session,
                    handle=receipt_handle,
                    settlement=settlement,
                )
            else:
                settle_linked_submission_recovery(
                    session,
                    handle=receipt_handle,
                    submission_recovery_handle=claim_handle,
                    settlement=settlement,
                )
        return "reconciled" if settlement.outcome == "reconciled" else "rejected"

    def _record_nonterminal(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        receipt_handle: BrokerMutationRecoveryHandle,
        claim_handle: DecisionSubmissionRecoveryHandle | None,
        read: BrokerSubmitRecoveryRead,
        observed_at: datetime,
        resolution_state: BrokerSubmitRecoveryResolutionState | None = None,
    ) -> str:
        age_seconds = _recovery_age_seconds(receipt, observed_at)
        manual_review = (
            read.outcome == "indeterminate"
            and age_seconds >= self._policy.manual_review_after_seconds
        )
        resolved_state: BrokerSubmitRecoveryResolutionState = resolution_state or (
            "manual_review" if manual_review else "submitted_unknown"
        )
        evidence_payload = {
            **dict(read.evidence),
            "schema_version": BROKER_MUTATION_RECOVERY_OBSERVATION_SCHEMA_VERSION,
            "broker_read_schema_version": read.evidence["schema_version"],
            "route": receipt.intent.broker_route,
            "resolution_state": resolved_state,
            "automatic_recovery_age_seconds": age_seconds,
            "automatic_resubmission_attempted": False,
            "operator_confirmation_required": resolved_state
            in {"expired", "manual_review"},
        }
        observation = build_broker_mutation_recovery_observation(
            BrokerMutationRecoveryObservationRequest(
                checked_client_request_id=receipt.intent.client_request_id,
                checked_target_key=receipt.intent.target.key,
                outcome=read.outcome,
                evidence_payload=evidence_payload,
            )
        )
        retry_seconds = (
            self._policy.manual_review_retry_seconds
            if resolved_state in {"expired", "manual_review"}
            else self._policy.retry_seconds
        )
        with self._session_factory() as session:
            if claim_handle is None:
                record_broker_mutation_recovery_observation(
                    session,
                    handle=receipt_handle,
                    observation=observation,
                    retry_seconds=retry_seconds,
                )
            else:
                record_linked_submission_recovery_observation(
                    session,
                    handle=receipt_handle,
                    submission_recovery_handle=claim_handle,
                    observation=observation,
                    retry_seconds=retry_seconds,
                )
        if claim_handle is None:
            self._release_receipt(receipt_handle)
        if resolved_state != "submitted_unknown":
            return resolved_state
        return read.outcome

    def _absence_window_expired(
        self,
        receipt: BrokerMutationReceiptSnapshot,
        *,
        read: BrokerSubmitRecoveryRead,
        observed_at: datetime,
        independent_activity: tuple[str, ...],
    ) -> bool:
        if (
            read.outcome != "not_found"
            or independent_activity
            or read.evidence.get("absence_proof_complete") is not True
            or _recovery_age_seconds(receipt, observed_at)
            < self._policy.absence_grace_seconds
            or receipt.recovery.outcome != "not_found"
            or receipt.recovery.checked_at is None
            or (observed_at - receipt.recovery.checked_at).total_seconds()
            < self._policy.absence_observation_spacing_seconds
        ):
            return False
        return _prior_absence_proof_is_compatible(receipt, read=read)

    def _release_receipt(self, handle: BrokerMutationRecoveryHandle) -> None:
        with self._session_factory() as session:
            release_broker_mutation_recovery(session, handle=handle)


def _validated_read(read: BrokerSubmitRecoveryRead) -> BrokerSubmitRecoveryRead:
    if read.outcome not in {"found", "not_found", "indeterminate"}:
        raise ValueError("broker_mutation_recovery_read_outcome_invalid")
    if read.outcome == "found" and not isinstance(read.broker_order, Mapping):
        raise ValueError("broker_mutation_recovery_found_order_required")
    if read.outcome != "found" and read.broker_order is not None:
        raise ValueError("broker_mutation_recovery_non_found_order_forbidden")
    schema_version = read.evidence.get("schema_version")
    if (
        not isinstance(schema_version, str)
        or not schema_version.startswith("torghut.")
        or len(schema_version) > 128
    ):
        raise ValueError("broker_mutation_recovery_read_schema_invalid")
    return read


def _required_receipt_recovery_handle(
    receipt: BrokerMutationReceiptSnapshot,
) -> BrokerMutationRecoveryHandle:
    handle = receipt.recovery_handle
    if handle is None:
        raise RuntimeError("broker_mutation_recovery_handle_missing")
    return handle


def _route_key(
    broker_route: str,
    account_label: str,
    endpoint_fingerprint: str,
) -> BrokerMutationRecoveryRouteKey:
    normalized_route = broker_route.strip().lower()
    normalized_account = account_label.strip()
    normalized_fingerprint = endpoint_fingerprint.strip().lower()
    if normalized_route not in {"alpaca", "hyperliquid"}:
        raise ValueError("broker_mutation_recovery_route_invalid")
    if not normalized_account or len(normalized_account) > 64:
        raise ValueError("broker_mutation_recovery_account_label_invalid")
    if len(normalized_fingerprint) != 64 or any(
        character not in "0123456789abcdef" for character in normalized_fingerprint
    ):
        raise ValueError("broker_mutation_recovery_endpoint_fingerprint_invalid")
    return normalized_route, normalized_account, normalized_fingerprint


def _recovery_age_seconds(
    receipt: BrokerMutationReceiptSnapshot,
    observed_at: datetime,
) -> int:
    started_at = receipt.lifecycle.broker_io_started_at
    if started_at is None:
        return 0
    return max(0, int((observed_at - started_at).total_seconds()))


def _prior_absence_proof_is_compatible(
    receipt: BrokerMutationReceiptSnapshot,
    *,
    read: BrokerSubmitRecoveryRead,
) -> bool:
    raw = receipt.recovery.evidence_json
    if not isinstance(raw, str):
        return False
    try:
        document = json.loads(raw)
    except (TypeError, ValueError):
        return False
    if not isinstance(document, dict):
        return False
    document_payload = cast(dict[str, object], document)
    observation = document_payload.get("observation")
    if not isinstance(observation, dict):
        return False
    payload = cast(dict[str, object], observation)
    return (
        payload.get("schema_version")
        == BROKER_MUTATION_RECOVERY_OBSERVATION_SCHEMA_VERSION
        and payload.get("broker_read_schema_version")
        == read.evidence.get("schema_version")
        and payload.get("route") == receipt.intent.broker_route
        and payload.get("absence_proof_complete") is True
        and payload.get("automatic_resubmission_attempted") is False
    )


__all__ = [
    "BROKER_MUTATION_RECOVERY_OBSERVATION_SCHEMA_VERSION",
    "BrokerMutationRecoveryPolicy",
    "BrokerMutationRecoveryRoute",
    "BrokerMutationRecoveryRunResult",
    "BrokerMutationRecoveryWorker",
    "BrokerSubmitRecoveryRead",
]
