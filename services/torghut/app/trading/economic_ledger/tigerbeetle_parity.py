"""Materialize and audit the broker-economic TigerBeetle projection."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, cast

from app.trading.tigerbeetle_client import TigerBeetleClientProtocol
from app.trading.tigerbeetle_journal.journal_payloads import result_statuses_by_index
from app.trading.tigerbeetle_ledger_model import TigerBeetleTransferSpec

from ..broker_account_activities import as_utc
from . import tigerbeetle_projection as projection
from .types import EconomicLedgerError, LedgerScope

if TYPE_CHECKING:
    from app.models import BrokerEconomicLedgerReconciliation

    from .persistence import (
        BrokerEconomicLedgerReplay,
        PublishedBrokerEconomicLedgerRuns,
    )


TIGERBEETLE_ECONOMIC_PARITY_SCHEMA_VERSION = (
    "torghut.broker-economic-tigerbeetle-parity.v1"
)
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_MISMATCH_SAMPLE_LIMIT = 20
_AUDIT_OPERATION_ERRORS = (
    EconomicLedgerError,
    RuntimeError,
    TypeError,
    ValueError,
    AttributeError,
)

_BLOCKER_ACCOUNT_CREATE = "tigerbeetle_economic_account_create_failed"
_BLOCKER_ACCOUNT_LOOKUP = "tigerbeetle_economic_account_lookup_failed"
_BLOCKER_ACCOUNT_MISSING = "tigerbeetle_economic_account_missing"
_BLOCKER_ACCOUNT_MISMATCH = "tigerbeetle_economic_account_mismatch"
_BLOCKER_TRANSFER_CREATE = "tigerbeetle_economic_transfer_create_failed"
_BLOCKER_TRANSFER_LOOKUP = "tigerbeetle_economic_transfer_lookup_failed"
_BLOCKER_TRANSFER_MISSING = "tigerbeetle_economic_transfer_missing"
_BLOCKER_TRANSFER_MISMATCH = "tigerbeetle_economic_transfer_mismatch"
_BLOCKER_TRANSFER_PARTIAL = "tigerbeetle_economic_transfer_chain_partial"
_BLOCKER_PROJECTION_EMPTY = "tigerbeetle_economic_projection_empty"
_BLOCKER_SOURCE_STALE = "tigerbeetle_economic_source_watermark_stale"


@dataclass(frozen=True, slots=True)
class BrokerEconomicTigerBeetleParityResult:
    payload: dict[str, object]
    parity: bool
    observation: TigerBeetleEconomicParityObservation


@dataclass(frozen=True, slots=True)
class TigerBeetleEconomicParityObservation:
    cluster_id: int
    observed_at: datetime
    max_source_age_seconds: int


def _add_blocker(blockers: list[str], blocker: str) -> None:
    if blocker not in blockers:
        blockers.append(blocker)


@dataclass(slots=True)
class _AuditState:
    blockers: list[str]
    errors: dict[str, int]
    operations: dict[str, int]
    mismatch_samples: list[dict[str, object]]
    exceptions: list[dict[str, str]]


def _record_exception(state: _AuditState, *, stage: str, exc: Exception) -> None:
    if len(state.exceptions) >= _MISMATCH_SAMPLE_LIMIT:
        return
    state.exceptions.append({"stage": stage, "type": type(exc).__name__})


def _sample_id(value: int) -> str:
    return hashlib.sha256(str(value).encode("ascii")).hexdigest()


def _record_mismatch(
    state: _AuditState,
    *,
    kind: str,
    object_id: int,
    fields: Sequence[str],
) -> None:
    if len(state.mismatch_samples) >= _MISMATCH_SAMPLE_LIMIT:
        return
    state.mismatch_samples.append(
        {
            "fields": sorted(set(fields)),
            "id_sha256": _sample_id(object_id),
            "kind": kind,
        }
    )


def _increment(state: _AuditState, key: str, count: int = 1) -> None:
    state.errors[key] += count


def _create_missing_accounts(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> None:
    accounts = [summary.accounts[item] for item in sorted(summary.accounts)]
    for chunk in projection.chunked(accounts, projection.TIGERBEETLE_MAX_BATCH_SIZE):
        ids = [item.spec.account_id for item in chunk]
        try:
            existing = projection.account_objects_by_id(
                client.lookup_accounts(ids),
                requested_ids=ids,
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "account_lookup")
            _add_blocker(state.blockers, _BLOCKER_ACCOUNT_LOOKUP)
            _record_exception(state, stage="account_prewrite_lookup", exc=exc)
            continue
        missing = [item.spec for item in chunk if item.spec.account_id not in existing]
        state.operations["account_existing_count"] += len(existing)
        state.operations["account_create_selected_count"] += len(missing)
        if not missing:
            continue
        try:
            statuses = result_statuses_by_index(
                client.create_accounts(missing),
                count=len(missing),
                default_status="created",
                status_type_names=("CreateAccountStatus",),
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "account_create", len(missing))
            _add_blocker(state.blockers, _BLOCKER_ACCOUNT_CREATE)
            _record_exception(state, stage="account_create", exc=exc)
            continue
        failures = sum(
            status not in {"created", "exists"} for status in statuses.values()
        )
        if failures:
            _increment(state, "account_create", failures)
            _add_blocker(state.blockers, _BLOCKER_ACCOUNT_CREATE)


def _accounts_are_safe_for_transfers(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> bool:
    safe = True
    accounts = [summary.accounts[item] for item in sorted(summary.accounts)]
    for chunk in projection.chunked(accounts, projection.TIGERBEETLE_MAX_BATCH_SIZE):
        ids = [item.spec.account_id for item in chunk]
        try:
            actual_by_id = projection.account_objects_by_id(
                client.lookup_accounts(ids),
                requested_ids=ids,
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "account_lookup")
            _add_blocker(state.blockers, _BLOCKER_ACCOUNT_LOOKUP)
            _record_exception(state, stage="account_identity_lookup", exc=exc)
            safe = False
            continue
        for expected in chunk:
            actual = actual_by_id.get(expected.spec.account_id)
            if actual is None:
                _increment(state, "account_missing")
                _add_blocker(state.blockers, _BLOCKER_ACCOUNT_MISSING)
                _record_mismatch(
                    state,
                    kind="account",
                    object_id=expected.spec.account_id,
                    fields=("missing_before_transfer",),
                )
                safe = False
                continue
            try:
                actual_payload = projection.actual_account_payload(actual)
            except (AttributeError, TypeError, ValueError) as exc:
                _increment(state, "account_mismatch")
                _add_blocker(state.blockers, _BLOCKER_ACCOUNT_MISMATCH)
                _record_exception(state, stage="account_identity_payload", exc=exc)
                safe = False
                continue
            expected_identity = projection.account_identity_payload(expected)
            actual_identity = {
                key: actual_payload.get(key) for key in expected_identity
            }
            mismatches = projection.mismatch_fields(expected_identity, actual_identity)
            if mismatches:
                _increment(state, "account_mismatch")
                _add_blocker(state.blockers, _BLOCKER_ACCOUNT_MISMATCH)
                _record_mismatch(
                    state,
                    kind="account",
                    object_id=expected.spec.account_id,
                    fields=mismatches,
                )
                safe = False
    return safe


def _create_missing_transfer_chains(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> None:
    for groups in projection.iter_group_batches(summary):
        specs = tuple(spec for group in groups for spec in group)
        ids = [spec.transfer_id for spec in specs]
        try:
            existing = projection.transfer_objects_by_id(
                client.lookup_transfers(ids),
                requested_ids=ids,
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "transfer_lookup")
            _add_blocker(state.blockers, _BLOCKER_TRANSFER_LOOKUP)
            _record_exception(state, stage="transfer_prewrite_lookup", exc=exc)
            continue

        missing_groups: list[tuple[TigerBeetleTransferSpec, ...]] = []
        for group in groups:
            existing_count = sum(spec.transfer_id in existing for spec in group)
            if existing_count == len(group):
                state.operations["transfer_existing_chain_count"] += 1
            elif existing_count == 0:
                missing_groups.append(group)
            else:
                _increment(state, "transfer_chain_partial")
                _add_blocker(state.blockers, _BLOCKER_TRANSFER_PARTIAL)
                _record_mismatch(
                    state,
                    kind="transfer_chain",
                    object_id=group[0].transfer_id,
                    fields=("partial_chain",),
                )

        missing = tuple(spec for group in missing_groups for spec in group)
        state.operations["transfer_create_selected_count"] += len(missing)
        if not missing:
            continue
        try:
            statuses = result_statuses_by_index(
                client.create_transfers(missing),
                count=len(missing),
                default_status="created",
                status_type_names=("CreateTransferStatus",),
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "transfer_create", len(missing))
            _add_blocker(state.blockers, _BLOCKER_TRANSFER_CREATE)
            _record_exception(state, stage="transfer_create", exc=exc)
            continue
        failures = sum(
            status not in {"created", "exists"} for status in statuses.values()
        )
        if failures:
            _increment(state, "transfer_create", failures)
            _add_blocker(state.blockers, _BLOCKER_TRANSFER_CREATE)


def _verify_accounts(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> tuple[int, str]:
    accounts = [summary.accounts[item] for item in sorted(summary.accounts)]
    actual_count = 0
    actual_hasher = hashlib.sha256()
    for chunk in projection.chunked(accounts, projection.TIGERBEETLE_MAX_BATCH_SIZE):
        ids = [item.spec.account_id for item in chunk]
        try:
            actual_by_id = projection.account_objects_by_id(
                client.lookup_accounts(ids),
                requested_ids=ids,
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "account_lookup")
            _add_blocker(state.blockers, _BLOCKER_ACCOUNT_LOOKUP)
            _record_exception(state, stage="account_verify_lookup", exc=exc)
            continue
        actual_count += len(actual_by_id)
        for expected in chunk:
            actual = actual_by_id.get(expected.spec.account_id)
            if actual is None:
                _increment(state, "account_missing")
                _add_blocker(state.blockers, _BLOCKER_ACCOUNT_MISSING)
                _record_mismatch(
                    state,
                    kind="account",
                    object_id=expected.spec.account_id,
                    fields=("missing",),
                )
                continue
            expected_payload = projection.account_payload(expected)
            try:
                actual_payload = projection.actual_account_payload(actual)
            except (AttributeError, TypeError, ValueError) as exc:
                _increment(state, "account_mismatch")
                _add_blocker(state.blockers, _BLOCKER_ACCOUNT_MISMATCH)
                _record_exception(state, stage="account_verify_payload", exc=exc)
                _record_mismatch(
                    state,
                    kind="account",
                    object_id=expected.spec.account_id,
                    fields=("payload_invalid",),
                )
                continue
            actual_hasher.update(projection.canonical_line(actual_payload))
            mismatches = projection.mismatch_fields(expected_payload, actual_payload)
            if mismatches:
                _increment(state, "account_mismatch")
                _add_blocker(state.blockers, _BLOCKER_ACCOUNT_MISMATCH)
                _record_mismatch(
                    state,
                    kind="account",
                    object_id=expected.spec.account_id,
                    fields=mismatches,
                )
    return actual_count, actual_hasher.hexdigest()


def _verify_transfers(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> tuple[int, str]:
    actual_count = 0
    actual_hasher = hashlib.sha256()
    for specs in projection.iter_transfer_batches(summary):
        ids = [spec.transfer_id for spec in specs]
        try:
            actual_by_id = projection.transfer_objects_by_id(
                client.lookup_transfers(ids),
                requested_ids=ids,
            )
        except _AUDIT_OPERATION_ERRORS as exc:
            _increment(state, "transfer_lookup")
            _add_blocker(state.blockers, _BLOCKER_TRANSFER_LOOKUP)
            _record_exception(state, stage="transfer_verify_lookup", exc=exc)
            continue
        actual_count += len(actual_by_id)
        for expected in specs:
            actual = actual_by_id.get(expected.transfer_id)
            if actual is None:
                _increment(state, "transfer_missing")
                _add_blocker(state.blockers, _BLOCKER_TRANSFER_MISSING)
                _record_mismatch(
                    state,
                    kind="transfer",
                    object_id=expected.transfer_id,
                    fields=("missing",),
                )
                continue
            expected_payload = projection.transfer_payload(expected)
            try:
                actual_payload = projection.actual_transfer_payload(actual)
            except (AttributeError, TypeError, ValueError) as exc:
                _increment(state, "transfer_mismatch")
                _add_blocker(state.blockers, _BLOCKER_TRANSFER_MISMATCH)
                _record_exception(state, stage="transfer_verify_payload", exc=exc)
                _record_mismatch(
                    state,
                    kind="transfer",
                    object_id=expected.transfer_id,
                    fields=("payload_invalid",),
                )
                continue
            actual_hasher.update(projection.canonical_line(actual_payload))
            mismatches = projection.mismatch_fields(expected_payload, actual_payload)
            if mismatches:
                _increment(state, "transfer_mismatch")
                _add_blocker(state.blockers, _BLOCKER_TRANSFER_MISMATCH)
                _record_mismatch(
                    state,
                    kind="transfer",
                    object_id=expected.transfer_id,
                    fields=mismatches,
                )
    return actual_count, actual_hasher.hexdigest()


def _utc(value: datetime, reason: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise EconomicLedgerError(reason)
    return value.astimezone(timezone.utc)


def _new_audit_state() -> _AuditState:
    return _AuditState(
        blockers=[],
        errors={
            "account_create": 0,
            "account_lookup": 0,
            "account_mismatch": 0,
            "account_missing": 0,
            "transfer_chain_partial": 0,
            "transfer_create": 0,
            "transfer_lookup": 0,
            "transfer_mismatch": 0,
            "transfer_missing": 0,
        },
        operations={
            "account_create_selected_count": 0,
            "account_existing_count": 0,
            "transfer_create_selected_count": 0,
            "transfer_existing_chain_count": 0,
        },
        mismatch_samples=[],
        exceptions=[],
    )


@dataclass(frozen=True, slots=True)
class _AuditResult:
    observed_at: datetime
    source_watermark: datetime
    source_age_seconds: int
    summary: projection.ProjectionSummary
    state: _AuditState
    actual: dict[str, object]


@dataclass(frozen=True, slots=True)
class _ValidatedParityPayload:
    bindings: Mapping[str, object]
    expected: Mapping[str, object]
    actual: Mapping[str, object]
    errors: Mapping[str, object]
    blockers: tuple[str, ...]
    source_age_seconds: int
    max_source_age_seconds: int
    parity: bool


def _validated_observation(
    observation: TigerBeetleEconomicParityObservation,
) -> datetime:
    if observation.cluster_id <= 0:
        raise ValueError("tigerbeetle_economic_cluster_id_invalid")
    if observation.max_source_age_seconds <= 0:
        raise ValueError("tigerbeetle_economic_max_source_age_invalid")
    return _utc(
        observation.observed_at,
        "tigerbeetle_economic_observed_at_invalid",
    )


def _read_actual_projection(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> dict[str, object]:
    _create_missing_accounts(client, summary, state)
    if _accounts_are_safe_for_transfers(client, summary, state):
        _create_missing_transfer_chains(client, summary, state)
    return _verify_actual_projection(client, summary, state)


def _verify_actual_projection(
    client: TigerBeetleClientProtocol,
    summary: projection.ProjectionSummary,
    state: _AuditState,
) -> dict[str, object]:
    account_count, account_digest = _verify_accounts(client, summary, state)
    transfer_count, transfer_digest = _verify_transfers(client, summary, state)
    return {
        "account_count": account_count,
        "account_manifest_sha256": account_digest,
        "transfer_count": transfer_count,
        "transfer_manifest_sha256": transfer_digest,
    }


def _run_audit(
    client: TigerBeetleClientProtocol,
    replay: BrokerEconomicLedgerReplay,
    observation: TigerBeetleEconomicParityObservation,
) -> _AuditResult:
    observed_at = _validated_observation(observation)
    source_watermark = _utc(
        replay.snapshot.source_watermark,
        "tigerbeetle_economic_source_watermark_invalid",
    )
    if observed_at < source_watermark:
        raise EconomicLedgerError("tigerbeetle_economic_observed_before_watermark")
    source_age_seconds = int((observed_at - source_watermark).total_seconds())
    summary = projection.build_projection_summary(replay)
    state = _new_audit_state()
    if not replay.reduction.admissible:
        _add_blocker(state.blockers, "tigerbeetle_economic_projection_inadmissible")
    if summary.transfer_count == 0:
        _add_blocker(state.blockers, _BLOCKER_PROJECTION_EMPTY)
    if source_age_seconds > observation.max_source_age_seconds:
        _add_blocker(state.blockers, _BLOCKER_SOURCE_STALE)
    actual = (
        _read_actual_projection(client, summary, state)
        if replay.reduction.admissible
        else _verify_actual_projection(client, summary, state)
    )
    return _AuditResult(
        observed_at=observed_at,
        source_watermark=source_watermark,
        source_age_seconds=source_age_seconds,
        summary=summary,
        state=state,
        actual=actual,
    )


def _parity_from_sections(
    expected: Mapping[str, object],
    actual: Mapping[str, object],
    errors: Mapping[str, object],
    blockers: Sequence[str],
    *,
    source_fresh: bool,
) -> bool:
    return (
        not blockers
        and source_fresh
        and _required_nonnegative_int(expected.get("account_count"), "account_count")
        > 0
        and _required_nonnegative_int(
            expected.get("transaction_count"), "transaction_count"
        )
        > 0
        and _required_nonnegative_int(expected.get("transfer_count"), "transfer_count")
        > 0
        and actual.get("account_count") == expected.get("account_count")
        and actual.get("transfer_count") == expected.get("transfer_count")
        and actual.get("account_manifest_sha256")
        == expected.get("account_manifest_sha256")
        and actual.get("transfer_manifest_sha256")
        == expected.get("transfer_manifest_sha256")
        and all(value == 0 for value in errors.values())
    )


def _replay_bindings(
    replay: BrokerEconomicLedgerReplay,
    runs: PublishedBrokerEconomicLedgerRuns,
    source_watermark: datetime,
) -> dict[str, object]:
    return {
        "comparison_sha256": replay.reduction.comparison.comparison_digest,
        "current_source_watermark": source_watermark.isoformat(),
        "input_id": str(runs.input_id),
        "input_manifest_sha256": replay.snapshot.prepared.manifest_digest,
        "input_source_watermark": _utc(
            runs.source_watermark,
            "tigerbeetle_economic_input_watermark_invalid",
        ).isoformat(),
        "journal_run_id": str(runs.journal_run_id),
        "journal_sha256": replay.reduction.journal.journal_digest,
        "reducer_version": replay.reduction.journal.projection.reducer_version,
        "state_run_id": str(runs.state_run_id),
    }


def _build_payload(
    replay: BrokerEconomicLedgerReplay,
    runs: PublishedBrokerEconomicLedgerRuns,
    observation: TigerBeetleEconomicParityObservation,
    audit: _AuditResult,
) -> dict[str, object]:
    expected = audit.summary.payload()
    blockers = tuple(sorted(audit.state.blockers))
    parity = _parity_from_sections(
        expected,
        audit.actual,
        audit.state.errors,
        blockers,
        source_fresh=(audit.source_age_seconds <= observation.max_source_age_seconds),
    )
    return {
        "schema_version": TIGERBEETLE_ECONOMIC_PARITY_SCHEMA_VERSION,
        "projection_version": projection.TIGERBEETLE_ECONOMIC_PROJECTION_VERSION,
        "cluster_id": observation.cluster_id,
        "scope_sha256": projection.scope_digest(replay.snapshot.prepared.scope),
        "observed_at": audit.observed_at.isoformat(),
        "source_age_seconds": audit.source_age_seconds,
        "max_source_age_seconds": observation.max_source_age_seconds,
        "bindings": _replay_bindings(replay, runs, audit.source_watermark),
        "expected": expected,
        "actual": audit.actual,
        "errors": dict(audit.state.errors),
        "operations": dict(audit.state.operations),
        "mismatch_samples": audit.state.mismatch_samples,
        "exceptions": audit.state.exceptions,
        "blockers": list(blockers),
        "parity": parity,
        "capital_authority": False,
        "promotion_authority": False,
    }


def audit_broker_economic_tigerbeetle_parity(
    client: TigerBeetleClientProtocol,
    replay: BrokerEconomicLedgerReplay,
    *,
    runs: PublishedBrokerEconomicLedgerRuns,
    observation: TigerBeetleEconomicParityObservation,
) -> BrokerEconomicTigerBeetleParityResult:
    """Materialize missing immutable chains, then prove the complete projection."""

    audit = _run_audit(client, replay, observation)
    payload = _build_payload(replay, runs, observation, audit)
    validate_tigerbeetle_economic_parity_payload(
        payload,
        replay=replay,
        runs=runs,
        observation=observation,
    )
    return BrokerEconomicTigerBeetleParityResult(
        payload=payload,
        parity=payload["parity"] is True,
        observation=observation,
    )


def _required_mapping(value: object, reason: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise EconomicLedgerError(reason)
    return cast(Mapping[str, object], value)


def _required_nonnegative_int(value: object, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise EconomicLedgerError(f"tigerbeetle_economic_parity_{field_name}_invalid")
    return value


def _required_digest(value: object, field_name: str) -> str:
    resolved = str(value or "")
    if _SHA256_PATTERN.fullmatch(resolved) is None:
        raise EconomicLedgerError(f"tigerbeetle_economic_parity_{field_name}_invalid")
    return resolved


def _required_aware_timestamp(value: object, field_name: str) -> str:
    resolved = str(value or "")
    try:
        parsed = datetime.fromisoformat(resolved.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EconomicLedgerError(
            f"tigerbeetle_economic_parity_{field_name}_invalid"
        ) from exc
    _utc(parsed, f"tigerbeetle_economic_parity_{field_name}_invalid")
    return resolved


def _validate_projection_sections(
    expected: Mapping[str, object],
    actual: Mapping[str, object],
    errors: Mapping[str, object],
) -> None:
    for field_name in ("account_count", "transaction_count", "transfer_count"):
        _required_nonnegative_int(expected.get(field_name), f"expected_{field_name}")
    for field_name in ("account_count", "transfer_count"):
        _required_nonnegative_int(actual.get(field_name), f"actual_{field_name}")
    for field_name in ("account_manifest_sha256", "transfer_manifest_sha256"):
        _required_digest(expected.get(field_name), f"expected_{field_name}")
        _required_digest(actual.get(field_name), f"actual_{field_name}")
    expected_error_fields = {
        "account_create",
        "account_lookup",
        "account_mismatch",
        "account_missing",
        "transfer_chain_partial",
        "transfer_create",
        "transfer_lookup",
        "transfer_mismatch",
        "transfer_missing",
    }
    if set(errors) != expected_error_fields:
        raise EconomicLedgerError("tigerbeetle_economic_parity_errors_invalid")
    for field_name, value in errors.items():
        _required_nonnegative_int(value, f"errors_{field_name}")


def _validated_blockers(payload: Mapping[str, object]) -> tuple[str, ...]:
    blockers_raw = payload.get("blockers")
    if not isinstance(blockers_raw, list):
        raise EconomicLedgerError("tigerbeetle_economic_parity_blockers_invalid")
    blocker_items = cast(list[object], blockers_raw)
    if any(not isinstance(item, str) or not item for item in blocker_items):
        raise EconomicLedgerError("tigerbeetle_economic_parity_blockers_invalid")
    blockers = tuple(cast(list[str], blocker_items))
    if blockers != tuple(sorted(set(blockers))):
        raise EconomicLedgerError("tigerbeetle_economic_parity_blockers_invalid")
    return blockers


def _validate_diagnostics(payload: Mapping[str, object]) -> None:
    operations = _required_mapping(
        payload.get("operations"),
        "tigerbeetle_economic_parity_operations_invalid",
    )
    for field_name, value in operations.items():
        _required_nonnegative_int(value, f"operations_{field_name}")
    for collection_name in ("mismatch_samples", "exceptions"):
        collection = payload.get(collection_name)
        if not isinstance(collection, list):
            raise EconomicLedgerError(
                f"tigerbeetle_economic_parity_{collection_name}_invalid"
            )
        collection_items = cast(list[object], collection)
        if len(collection_items) > _MISMATCH_SAMPLE_LIMIT or any(
            not isinstance(item, Mapping) for item in collection_items
        ):
            raise EconomicLedgerError(
                f"tigerbeetle_economic_parity_{collection_name}_invalid"
            )


def _validated_payload_sections(
    payload: Mapping[str, object],
    *,
    expected_cluster_id: int | None,
) -> _ValidatedParityPayload:
    if payload.get("schema_version") != TIGERBEETLE_ECONOMIC_PARITY_SCHEMA_VERSION:
        raise EconomicLedgerError("tigerbeetle_economic_parity_schema_invalid")
    if payload.get("projection_version") != (
        projection.TIGERBEETLE_ECONOMIC_PROJECTION_VERSION
    ):
        raise EconomicLedgerError("tigerbeetle_economic_projection_version_invalid")
    cluster_id = _required_nonnegative_int(payload.get("cluster_id"), "cluster_id")
    if cluster_id == 0 or (
        expected_cluster_id is not None and cluster_id != expected_cluster_id
    ):
        raise EconomicLedgerError("tigerbeetle_economic_parity_cluster_id_invalid")
    _required_digest(payload.get("scope_sha256"), "scope_sha256")
    _required_aware_timestamp(payload.get("observed_at"), "observed_at")
    source_age = _required_nonnegative_int(
        payload.get("source_age_seconds"),
        "source_age_seconds",
    )
    max_source_age = _required_nonnegative_int(
        payload.get("max_source_age_seconds"),
        "max_source_age_seconds",
    )
    if max_source_age == 0:
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_max_source_age_seconds_invalid"
        )
    bindings = _required_mapping(
        payload.get("bindings"),
        "tigerbeetle_economic_parity_bindings_invalid",
    )
    expected = _required_mapping(
        payload.get("expected"),
        "tigerbeetle_economic_parity_expected_invalid",
    )
    actual = _required_mapping(
        payload.get("actual"),
        "tigerbeetle_economic_parity_actual_invalid",
    )
    errors = _required_mapping(
        payload.get("errors"),
        "tigerbeetle_economic_parity_errors_invalid",
    )
    _validate_projection_sections(expected, actual, errors)
    blockers = _validated_blockers(payload)
    parity = payload.get("parity")
    if not isinstance(parity, bool):
        raise EconomicLedgerError("tigerbeetle_economic_parity_value_invalid")
    calculated = _parity_from_sections(
        expected,
        actual,
        errors,
        blockers,
        source_fresh=source_age <= max_source_age,
    )
    if parity is not calculated:
        raise EconomicLedgerError("tigerbeetle_economic_parity_value_contradiction")
    if not parity and not blockers:
        raise EconomicLedgerError("tigerbeetle_economic_parity_blocker_missing")
    if payload.get("capital_authority") is not False:
        raise EconomicLedgerError("tigerbeetle_economic_capital_authority_invalid")
    if payload.get("promotion_authority") is not False:
        raise EconomicLedgerError("tigerbeetle_economic_promotion_authority_invalid")
    _validate_diagnostics(payload)
    return _ValidatedParityPayload(
        bindings=bindings,
        expected=expected,
        actual=actual,
        errors=errors,
        blockers=blockers,
        source_age_seconds=source_age,
        max_source_age_seconds=max_source_age,
        parity=parity,
    )


def _require_bindings(
    bindings: Mapping[str, object],
    expected: Mapping[str, object],
) -> None:
    if set(bindings) != set(expected):
        raise EconomicLedgerError("tigerbeetle_economic_parity_bindings_invalid")
    for field_name, expected_value in expected.items():
        if bindings.get(field_name) != expected_value:
            raise EconomicLedgerError(
                f"tigerbeetle_economic_parity_{field_name}_binding_invalid"
            )


def validate_tigerbeetle_economic_parity_payload(
    payload: Mapping[str, object],
    *,
    replay: BrokerEconomicLedgerReplay,
    runs: PublishedBrokerEconomicLedgerRuns,
    observation: TigerBeetleEconomicParityObservation,
) -> None:
    """Recompute immutable expectations before sealing parity into PostgreSQL."""

    sections = _validated_payload_sections(
        payload,
        expected_cluster_id=observation.cluster_id,
    )
    observed_at = _validated_observation(observation)
    source_watermark = _utc(
        replay.snapshot.source_watermark,
        "tigerbeetle_economic_source_watermark_invalid",
    )
    if payload.get("scope_sha256") != projection.scope_digest(
        replay.snapshot.prepared.scope
    ):
        raise EconomicLedgerError("tigerbeetle_economic_parity_scope_binding_invalid")
    if payload.get("observed_at") != observed_at.isoformat():
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_observed_at_binding_invalid"
        )
    source_age_seconds = int((observed_at - source_watermark).total_seconds())
    if source_age_seconds < 0:
        raise EconomicLedgerError("tigerbeetle_economic_observed_before_watermark")
    if sections.source_age_seconds != source_age_seconds:
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_source_age_binding_invalid"
        )
    if sections.max_source_age_seconds != observation.max_source_age_seconds:
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_max_source_age_binding_invalid"
        )
    _require_bindings(
        sections.bindings,
        _replay_bindings(replay, runs, source_watermark),
    )
    if dict(sections.expected) != projection.build_projection_summary(replay).payload():
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_expected_projection_invalid"
        )


def validated_tigerbeetle_parity_attachment(
    parity: BrokerEconomicTigerBeetleParityResult,
    replay: BrokerEconomicLedgerReplay,
    runs: PublishedBrokerEconomicLedgerRuns,
    observed_at: datetime,
    max_source_age_seconds: int,
) -> dict[str, object]:
    """Validate the audit result against the reconciliation observation."""

    expected_observed_at = _utc(
        observed_at,
        "economic_reconciliation_tigerbeetle_observation_binding_invalid",
    )
    if (
        _validated_observation(parity.observation) != expected_observed_at
        or parity.observation.max_source_age_seconds != max_source_age_seconds
    ):
        raise EconomicLedgerError(
            "economic_reconciliation_tigerbeetle_observation_binding_invalid"
        )
    validate_tigerbeetle_economic_parity_payload(
        parity.payload,
        replay=replay,
        runs=runs,
        observation=parity.observation,
    )
    return dict(parity.payload)


def _persisted_bindings(
    row: BrokerEconomicLedgerReconciliation,
    *,
    input_manifest_sha256: str,
    reducer_version: str,
) -> dict[str, object]:
    return {
        "comparison_sha256": row.comparison_sha256,
        "current_source_watermark": as_utc(row.source_watermark).isoformat(),
        "input_id": str(row.input_id),
        "input_manifest_sha256": input_manifest_sha256,
        "input_source_watermark": as_utc(row.input_source_watermark).isoformat(),
        "journal_run_id": str(row.journal_run_id),
        "journal_sha256": row.journal_sha256,
        "reducer_version": reducer_version,
        "state_run_id": str(row.state_run_id),
    }


def load_persisted_tigerbeetle_economic_parity(
    row: BrokerEconomicLedgerReconciliation,
    *,
    scope: LedgerScope,
    expected_cluster_id: int | None,
) -> tuple[Mapping[str, object] | None, bool, tuple[str, ...]]:
    """Validate the optional sealed parity payload and its row bindings."""

    raw_payload = row.result.get("tigerbeetle_economic_parity")
    if raw_payload is None:
        return None, False, ("tigerbeetle_economic_parity_missing",)
    payload = _required_mapping(
        raw_payload,
        "economic_reconciliation_persisted_tigerbeetle_parity_invalid",
    )
    sections = _validated_payload_sections(
        payload,
        expected_cluster_id=expected_cluster_id,
    )
    if payload.get("scope_sha256") != projection.scope_digest(scope):
        raise EconomicLedgerError("tigerbeetle_economic_parity_scope_binding_invalid")
    if payload.get("observed_at") != as_utc(row.observed_at).isoformat():
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_observed_at_binding_invalid"
        )
    if sections.source_age_seconds != row.source_age_seconds:
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_source_age_binding_invalid"
        )
    if sections.max_source_age_seconds != row.max_source_age_seconds:
        raise EconomicLedgerError(
            "tigerbeetle_economic_parity_max_source_age_binding_invalid"
        )
    reducers = _required_mapping(
        row.result.get("reducers"),
        "economic_reconciliation_persisted_reducers_invalid",
    )
    reducer_version = str(reducers.get("journal") or "")
    if not reducer_version:
        raise EconomicLedgerError(
            "economic_reconciliation_persisted_journal_reducer_invalid"
        )
    input_manifest_sha256 = _required_digest(
        row.result.get("input_manifest_sha256"),
        "input_manifest_sha256",
    )
    _require_bindings(
        sections.bindings,
        _persisted_bindings(
            row,
            input_manifest_sha256=input_manifest_sha256,
            reducer_version=reducer_version,
        ),
    )
    return payload, sections.parity, sections.blockers


__all__ = (
    "TIGERBEETLE_ECONOMIC_PARITY_SCHEMA_VERSION",
    "BrokerEconomicTigerBeetleParityResult",
    "TigerBeetleEconomicParityObservation",
    "audit_broker_economic_tigerbeetle_parity",
    "validate_tigerbeetle_economic_parity_payload",
)
