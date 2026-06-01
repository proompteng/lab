"""Read-only TigerBeetle/runtime-ledger parity diagnostics for Torghut.

The diagnostic in this module intentionally compares existing source rows and
existing TigerBeetle reference/lookup rows only. It never journals missing
entries, synthesizes fills, creates proof artifacts, or changes runtime-ledger
authority gates.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
    Execution,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import TigerBeetleClientProtocol
from app.trading.tigerbeetle_ids import u128_decimal
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    TigerBeetleRuntimeLedgerTransferPlan,
    TigerBeetleSourceTransferPlan,
    build_execution_tca_metric_transfer_plan,
    build_execution_transfer_plan,
    build_runtime_ledger_bucket_transfer_plan,
    execution_tca_metric_source_id,
)
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TigerBeetleTransferSpec,
)


SCHEMA_VERSION = "torghut.tigerbeetle-runtime-ledger-parity.v1"

PARITY_STATUS_PASS = "pass"
PARITY_STATUS_NO_SOURCE_DATA = "no_source_data"
PARITY_STATUS_OPTIONAL_DEGRADED = "optional_degraded"
PARITY_STATUS_BLOCKED = "blocked"

BLOCKER_ENTRY_MISSING = "tigerbeetle_parity_entry_missing"
BLOCKER_AMOUNT_MISMATCH = "tigerbeetle_parity_amount_mismatch"
BLOCKER_ACCOUNT_MISMATCH = "tigerbeetle_parity_account_mismatch"
BLOCKER_CANDIDATE_MISMATCH = "tigerbeetle_parity_candidate_mismatch"
BLOCKER_TRANSFER_SHAPE_MISMATCH = "tigerbeetle_parity_transfer_shape_mismatch"
BLOCKER_TRANSFER_MISSING = "tigerbeetle_parity_transfer_missing"
BLOCKER_CLIENT_UNAVAILABLE = "tigerbeetle_parity_client_unavailable"
BLOCKER_RECONCILIATION_NOT_OK = "tigerbeetle_reconciliation_not_ok"


@dataclass(frozen=True)
class _ParitySource:
    family: str
    source_type: str
    source_id: str
    account_label: str | None
    candidate_id: str | None
    plan: TigerBeetleSourceTransferPlan | TigerBeetleRuntimeLedgerTransferPlan
    expected_metadata: Mapping[str, object]


def _payload_mapping(row: TigerBeetleTransferRef) -> Mapping[str, object]:
    raw_payload = cast(object, row.payload_json)
    if isinstance(raw_payload, Mapping):
        return cast(Mapping[str, object], raw_payload)
    return {}


def _transfer_attr(value: object, name: str) -> object:
    if isinstance(value, Mapping):
        value_mapping = cast(Mapping[str, object], value)
        result = value_mapping.get(name)
        if result is None and name == "id":
            result = value_mapping.get("transfer_id")
        return result
    if hasattr(value, name):
        return getattr(value, name)
    if name == "id" and hasattr(value, "transfer_id"):
        return getattr(value, "transfer_id")
    raise AttributeError(name)


def _stable_decimal(value: Decimal | int | object) -> str:
    return str(Decimal(str(value)))


def _increment(mapping: dict[str, int], key: str, value: int = 1) -> None:
    mapping[key] = int(mapping.get(key, 0)) + value


def _add_blocker(blockers: list[str], blocker: str) -> None:
    if blocker not in blockers:
        blockers.append(blocker)


def _query_transfer_ref(
    session: Session,
    *,
    settings_obj: Settings,
    source: _ParitySource,
) -> TigerBeetleTransferRef | None:
    return (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(
                TigerBeetleTransferRef.cluster_id
                == settings_obj.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.source_type == source.source_type,
                TigerBeetleTransferRef.source_id == source.source_id,
                TigerBeetleTransferRef.transfer_kind
                == source.plan.transfer_spec.transfer_kind,
            )
            .limit(1)
        )
        .scalars()
        .first()
    )


def _select_sources(
    session: Session,
    *,
    account_label: str | None,
    limit: int,
) -> list[_ParitySource]:
    sources: list[_ParitySource] = []
    execution_stmt = (
        select(Execution)
        .where(Execution.avg_fill_price.is_not(None), Execution.filled_qty > 0)
        .order_by(Execution.created_at.desc())
        .limit(limit)
    )
    if account_label:
        execution_stmt = execution_stmt.where(
            Execution.alpaca_account_label == account_label
        )
    for execution in session.execute(execution_stmt).scalars().all():
        plan = build_execution_transfer_plan(execution)
        if plan is None:
            continue
        sources.append(
            _ParitySource(
                family=TRANSFER_KIND_EXECUTION_FILL,
                source_type=SOURCE_TYPE_EXECUTION,
                source_id=str(execution.id),
                account_label=execution.alpaca_account_label,
                candidate_id=None,
                plan=plan,
                expected_metadata={
                    "alpaca_order_id": execution.alpaca_order_id,
                    "client_order_id": execution.client_order_id,
                },
            )
        )

    metric_stmt = (
        select(ExecutionTCAMetric)
        .where(
            ExecutionTCAMetric.shortfall_notional.is_not(None),
            ExecutionTCAMetric.shortfall_notional != 0,
        )
        .order_by(ExecutionTCAMetric.computed_at.desc())
        .limit(limit)
    )
    if account_label:
        metric_stmt = metric_stmt.where(
            ExecutionTCAMetric.alpaca_account_label == account_label
        )
    for metric in session.execute(metric_stmt).scalars().all():
        plan = build_execution_tca_metric_transfer_plan(metric)
        if plan is None:
            continue
        sources.append(
            _ParitySource(
                family=TRANSFER_KIND_EXECUTION_COST,
                source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
                source_id=execution_tca_metric_source_id(metric),
                account_label=metric.alpaca_account_label,
                candidate_id=None,
                plan=plan,
                expected_metadata={
                    "simulator_version": metric.simulator_version,
                    "shortfall_notional": str(metric.shortfall_notional),
                },
            )
        )

    bucket_stmt = (
        select(StrategyRuntimeLedgerBucket)
        .where(
            (StrategyRuntimeLedgerBucket.net_strategy_pnl_after_costs != 0)
            | (StrategyRuntimeLedgerBucket.cost_amount != 0)
        )
        .order_by(StrategyRuntimeLedgerBucket.bucket_ended_at.desc())
        .limit(limit)
    )
    if account_label:
        bucket_stmt = bucket_stmt.where(
            StrategyRuntimeLedgerBucket.account_label == account_label
        )
    for bucket in session.execute(bucket_stmt).scalars().all():
        plan = build_runtime_ledger_bucket_transfer_plan(bucket)
        if plan is None:
            continue
        sources.append(
            _ParitySource(
                family=TRANSFER_KIND_RUNTIME_NET_PNL,
                source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                account_label=bucket.account_label,
                candidate_id=bucket.candidate_id,
                plan=plan,
                expected_metadata={
                    "run_id": bucket.run_id,
                    "candidate_id": bucket.candidate_id,
                    "hypothesis_id": bucket.hypothesis_id,
                    "observed_stage": bucket.observed_stage,
                    "pnl_basis": bucket.pnl_basis,
                    "ledger_schema_version": bucket.ledger_schema_version,
                    "amount_source": str(plan.amount_source),
                    "runtime_key": plan.runtime_key,
                },
            )
        )
    return sorted(
        sources,
        key=lambda source: (source.family, source.source_type, source.source_id),
    )


def _expected_account_ids(spec: TigerBeetleTransferSpec) -> tuple[str, str]:
    return u128_decimal(spec.debit_account_id), u128_decimal(spec.credit_account_id)


def _ref_account_matches(
    ref: TigerBeetleTransferRef, spec: TigerBeetleTransferSpec
) -> bool:
    payload = _payload_mapping(ref)
    expected_debit, expected_credit = _expected_account_ids(spec)
    return (
        str(payload.get("debit_account_id")) == expected_debit
        and str(payload.get("credit_account_id")) == expected_credit
    )


def _ref_shape_matches(
    ref: TigerBeetleTransferRef, spec: TigerBeetleTransferSpec
) -> bool:
    return (
        ref.transfer_id == u128_decimal(spec.transfer_id)
        and ref.transfer_kind == spec.transfer_kind
        and ref.ledger == spec.ledger
        and ref.code == spec.code
    )


def _metadata_matches(source: _ParitySource, ref: TigerBeetleTransferRef) -> bool:
    if source.family != TRANSFER_KIND_RUNTIME_NET_PNL:
        return True
    payload = _payload_mapping(ref)
    return all(
        str(payload.get(key)) == str(value)
        for key, value in source.expected_metadata.items()
        if value is not None
    )


def _actual_amount(actual: object) -> Decimal:
    return Decimal(str(_transfer_attr(actual, "amount")))


def _actual_account_matches(actual: object, spec: TigerBeetleTransferSpec) -> bool:
    return (
        int(str(_transfer_attr(actual, "debit_account_id"))) == spec.debit_account_id
        and int(str(_transfer_attr(actual, "credit_account_id")))
        == spec.credit_account_id
    )


def _actual_shape_matches(actual: object, spec: TigerBeetleTransferSpec) -> bool:
    return (
        int(str(_transfer_attr(actual, "id"))) == spec.transfer_id
        and int(str(_transfer_attr(actual, "ledger"))) == spec.ledger
        and int(str(_transfer_attr(actual, "code"))) == spec.code
    )


def _required(settings_obj: Settings, require_tigerbeetle: bool | None) -> bool:
    if require_tigerbeetle is not None:
        return require_tigerbeetle
    return bool(
        settings_obj.tigerbeetle_required or settings_obj.tigerbeetle_reconcile_required
    )


def _status(*, blockers: Sequence[str], required: bool, source_count: int) -> str:
    if not blockers and source_count <= 0:
        return PARITY_STATUS_NO_SOURCE_DATA
    if not blockers:
        return PARITY_STATUS_PASS
    if required:
        return PARITY_STATUS_BLOCKED
    return PARITY_STATUS_OPTIONAL_DEGRADED


def audit_tigerbeetle_runtime_ledger_parity(
    session: Session,
    *,
    settings_obj: Settings = settings,
    client: TigerBeetleClientProtocol | None = None,
    account_label: str | None = None,
    limit: int = 500,
    require_tigerbeetle: bool | None = None,
) -> dict[str, object]:
    """Return stable read-only parity JSON for execution economics and runtime PnL."""

    required = _required(settings_obj, require_tigerbeetle)
    bounded_limit = max(1, min(int(limit), 5000))
    sources = _select_sources(session, account_label=account_label, limit=bounded_limit)
    blockers: list[str] = []
    source_counts: dict[str, int] = {}
    expected_micros_by_family: dict[str, str] = {}
    ref_micros_by_family: dict[str, str] = {}
    actual_micros_by_family: dict[str, str] = {}
    expected_totals: dict[str, Decimal] = {}
    ref_totals: dict[str, Decimal] = {}
    actual_totals: dict[str, Decimal] = {}
    samples: list[dict[str, object]] = []
    refs_by_transfer_id: dict[str, TigerBeetleTransferRef] = {}

    missing_ref_count = 0
    amount_mismatch_count = 0
    account_mismatch_count = 0
    candidate_mismatch_count = 0
    transfer_shape_mismatch_count = 0
    checked_ref_count = 0

    for source in sources:
        spec = source.plan.transfer_spec
        expected_amount = Decimal(spec.amount)
        _increment(source_counts, source.family)
        expected_totals[source.family] = (
            expected_totals.get(source.family, Decimal("0")) + expected_amount
        )
        ref = _query_transfer_ref(session, settings_obj=settings_obj, source=source)
        sample: dict[str, object] = {
            "family": source.family,
            "source_type": source.source_type,
            "source_id": source.source_id,
            "account_label": source.account_label,
            "candidate_id": source.candidate_id,
            "expected_transfer_id": u128_decimal(spec.transfer_id),
            "expected_amount_micros": _stable_decimal(expected_amount),
            "status": "pass",
            "blockers": [],
        }
        sample_blockers = cast(list[str], sample["blockers"])
        if ref is None:
            missing_ref_count += 1
            _add_blocker(blockers, BLOCKER_ENTRY_MISSING)
            sample_blockers.append(BLOCKER_ENTRY_MISSING)
            sample["status"] = "missing_ref"
            samples.append(sample)
            continue

        checked_ref_count += 1
        refs_by_transfer_id[ref.transfer_id] = ref
        ref_totals[source.family] = ref_totals.get(
            source.family, Decimal("0")
        ) + Decimal(ref.amount)
        sample["ref_transfer_id"] = ref.transfer_id
        sample["ref_amount_micros"] = _stable_decimal(ref.amount)
        if ref.amount != expected_amount:
            amount_mismatch_count += 1
            _add_blocker(blockers, BLOCKER_AMOUNT_MISMATCH)
            sample_blockers.append(BLOCKER_AMOUNT_MISMATCH)
            sample["status"] = "amount_mismatch"
        if not _ref_account_matches(ref, spec):
            account_mismatch_count += 1
            _add_blocker(blockers, BLOCKER_ACCOUNT_MISMATCH)
            sample_blockers.append(BLOCKER_ACCOUNT_MISMATCH)
            sample["status"] = "account_mismatch"
        if not _ref_shape_matches(ref, spec):
            transfer_shape_mismatch_count += 1
            _add_blocker(blockers, BLOCKER_TRANSFER_SHAPE_MISMATCH)
            sample_blockers.append(BLOCKER_TRANSFER_SHAPE_MISMATCH)
            sample["status"] = "transfer_shape_mismatch"
        if not _metadata_matches(source, ref):
            candidate_mismatch_count += 1
            _add_blocker(blockers, BLOCKER_CANDIDATE_MISMATCH)
            sample_blockers.append(BLOCKER_CANDIDATE_MISMATCH)
            sample["status"] = "candidate_mismatch"
        samples.append(sample)

    actual_missing_count = 0
    actual_checked_count = 0
    client_error: str | None = None
    if client is not None and refs_by_transfer_id:
        try:
            actuals = client.lookup_transfers(
                [int(transfer_id) for transfer_id in refs_by_transfer_id]
            )
            actual_lookup = {str(_transfer_attr(item, "id")): item for item in actuals}
            sample_by_transfer = {
                str(sample.get("ref_transfer_id")): sample
                for sample in samples
                if sample.get("ref_transfer_id") is not None
            }
            source_by_transfer = {
                u128_decimal(source.plan.transfer_spec.transfer_id): source
                for source in sources
            }
            for transfer_id, ref in refs_by_transfer_id.items():
                actual = actual_lookup.get(transfer_id)
                actual_sample = sample_by_transfer.get(transfer_id)
                source = source_by_transfer.get(transfer_id)
                if source is None:
                    continue
                spec = source.plan.transfer_spec
                if actual is None:
                    actual_missing_count += 1
                    _add_blocker(blockers, BLOCKER_TRANSFER_MISSING)
                    if actual_sample is not None:
                        cast(list[str], actual_sample["blockers"]).append(
                            BLOCKER_TRANSFER_MISSING
                        )
                        actual_sample["status"] = "missing_actual_transfer"
                    continue
                actual_checked_count += 1
                actual_amount = _actual_amount(actual)
                actual_totals[source.family] = (
                    actual_totals.get(source.family, Decimal("0")) + actual_amount
                )
                if actual_sample is not None:
                    actual_sample["actual_amount_micros"] = _stable_decimal(
                        actual_amount
                    )
                if actual_amount != Decimal(spec.amount):
                    amount_mismatch_count += 1
                    _add_blocker(blockers, BLOCKER_AMOUNT_MISMATCH)
                    if actual_sample is not None:
                        cast(list[str], actual_sample["blockers"]).append(
                            BLOCKER_AMOUNT_MISMATCH
                        )
                        actual_sample["status"] = "actual_amount_mismatch"
                if not _actual_account_matches(actual, spec):
                    account_mismatch_count += 1
                    _add_blocker(blockers, BLOCKER_ACCOUNT_MISMATCH)
                    if actual_sample is not None:
                        cast(list[str], actual_sample["blockers"]).append(
                            BLOCKER_ACCOUNT_MISMATCH
                        )
                        actual_sample["status"] = "actual_account_mismatch"
                if not _actual_shape_matches(actual, spec):
                    transfer_shape_mismatch_count += 1
                    _add_blocker(blockers, BLOCKER_TRANSFER_SHAPE_MISMATCH)
                    if actual_sample is not None:
                        cast(list[str], actual_sample["blockers"]).append(
                            BLOCKER_TRANSFER_SHAPE_MISMATCH
                        )
                        actual_sample["status"] = "actual_transfer_shape_mismatch"
        except Exception as exc:
            client_error = f"{type(exc).__name__}: {exc}"
            _add_blocker(blockers, BLOCKER_CLIENT_UNAVAILABLE)

    for family, value in sorted(expected_totals.items()):
        expected_micros_by_family[family] = _stable_decimal(value)
    for family, value in sorted(ref_totals.items()):
        ref_micros_by_family[family] = _stable_decimal(value)
    for family, value in sorted(actual_totals.items()):
        actual_micros_by_family[family] = _stable_decimal(value)

    unique_blockers = sorted(blockers)
    parity_status = _status(
        blockers=unique_blockers,
        required=required,
        source_count=len(sources),
    )
    ok = (
        parity_status in {PARITY_STATUS_PASS, PARITY_STATUS_NO_SOURCE_DATA}
        or not required
    )
    return coerce_json_payload(
        {
            "schema_version": SCHEMA_VERSION,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "cluster_id": settings_obj.tigerbeetle_cluster_id,
            "required": required,
            "enabled": settings_obj.tigerbeetle_enabled,
            "reconcile_required": settings_obj.tigerbeetle_reconcile_required,
            "account_label": account_label,
            "limit": bounded_limit,
            "ok": ok,
            "parity_status": parity_status,
            "blockers": unique_blockers,
            "client_lookup": client is not None,
            "client_error": client_error,
            "totals": {
                "checked_source_count": len(sources),
                "checked_ref_count": checked_ref_count,
                "checked_actual_transfer_count": actual_checked_count,
                "missing_ref_count": missing_ref_count,
                "actual_missing_count": actual_missing_count,
                "amount_mismatch_count": amount_mismatch_count,
                "account_mismatch_count": account_mismatch_count,
                "candidate_mismatch_count": candidate_mismatch_count,
                "transfer_shape_mismatch_count": transfer_shape_mismatch_count,
                "source_counts": dict(sorted(source_counts.items())),
                "expected_amount_micros_by_family": expected_micros_by_family,
                "tigerbeetle_ref_amount_micros_by_family": ref_micros_by_family,
                "tigerbeetle_actual_amount_micros_by_family": actual_micros_by_family,
            },
            "samples": samples[:50],
            "read_only_contract": {
                "generates_proof": False,
                "synthesizes_fills": False,
                "overrides_runtime_ledger_authority": False,
                "writes_database": False,
            },
        }
    )


def tigerbeetle_runtime_ledger_parity_blockers(
    payload: Mapping[str, object],
) -> list[str]:
    """Return fail-closed blockers only when the parity payload is required."""

    required = bool(payload.get("required"))
    if not required:
        return []
    blockers: list[str] = []
    if payload.get("reconciliation_ok") is False:
        blockers.append(BLOCKER_RECONCILIATION_NOT_OK)
        latest_reconciliation = payload.get("latest_reconciliation")
        if isinstance(latest_reconciliation, Mapping):
            reconciliation_payload = cast(
                Mapping[str, object],
                latest_reconciliation,
            )
            raw_reconciliation_blockers = reconciliation_payload.get("blockers")
            if isinstance(raw_reconciliation_blockers, Sequence) and not isinstance(
                raw_reconciliation_blockers,
                (str, bytes, bytearray),
            ):
                blockers.extend(
                    str(item)
                    for item in cast(Sequence[object], raw_reconciliation_blockers)
                )
    raw_blockers = payload.get("blockers")
    if not isinstance(raw_blockers, Sequence) or isinstance(
        raw_blockers, (str, bytes, bytearray)
    ):
        return sorted(set(blockers))
    blocker_items = cast(Sequence[object], raw_blockers)
    blockers.extend(str(item) for item in blocker_items)
    return sorted(set(blockers))
