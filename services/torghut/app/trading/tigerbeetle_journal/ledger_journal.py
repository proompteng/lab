"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from types import TracebackType
from typing import Any, Self, cast

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import (
    TigerBeetleClientProtocol,
    create_tigerbeetle_client,
)
from app.trading.tigerbeetle_ids import u128_decimal
from app.trading.tigerbeetle_ledger_model import (
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)

from .journal_payloads import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    PreparedTigerBeetleTransferWrite,
    StableRefPayloadInput,
    result_statuses_by_index,
    tigerbeetle_stable_ref_payload,
    transfer_attr,
)
from .source_transfer_plans import (
    build_execution_tca_metric_transfer_plan,
    build_execution_transfer_plan,
    build_runtime_ledger_bucket_transfer_plan,
)
from .stable_ref_backfill import (
    backfill_stable_ref_payloads as backfill_stable_ref_payloads_in_postgres,
    count_missing_stable_ref_payloads as count_missing_stable_ref_payloads_in_postgres,
)
from .transfer_refs import (
    build_order_event_transfer_plan,
    dedupe_account_specs,
    execution_economic_event_key,
    execution_source_id,
    execution_tca_metric_economic_event_key,
    execution_tca_metric_source_id,
    find_transfer_ref,
    merge_existing_transfer_ref,
    persist_account_refs,
    transfer_matches,
    TransferRefLookupKey,
)


@dataclass(frozen=True)
class _PendingTigerBeetleTransferWrite:
    original_index: int
    prepared: PreparedTigerBeetleTransferWrite
    payload_json: dict[str, object]


class TigerBeetleLedgerJournal:
    def __init__(
        self,
        *,
        settings_obj: Settings = settings,
        client: TigerBeetleClientProtocol | None = None,
    ) -> None:
        self._settings = settings_obj
        self._client = client
        self._owns_client = client is None

    @property
    def cluster_id(self) -> int:
        return self._settings.tigerbeetle_cluster_id

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        self.close()

    def _client_for_write(self) -> TigerBeetleClientProtocol:
        if self._client is None:
            self._client = create_tigerbeetle_client(self._settings)
        return self._client

    def client_for_reconciliation(self) -> TigerBeetleClientProtocol | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        return self._client_for_write()

    def close(self) -> None:
        if not self._owns_client or self._client is None:
            return
        close = getattr(self._client, "close", None)
        if callable(close):
            close()
        self._client = None

    def _payload_with_stable_ref(
        self,
        prepared: PreparedTigerBeetleTransferWrite,
    ) -> dict[str, object]:
        cluster_id = self._settings.tigerbeetle_cluster_id
        return {
            **prepared.payload_json,
            **tigerbeetle_stable_ref_payload(
                StableRefPayloadInput(
                    cluster_id=cluster_id,
                    account_specs=prepared.account_specs,
                    transfer_spec=prepared.transfer_spec,
                    source_type=prepared.source_type,
                    source_id=prepared.source_id,
                    payload_json=prepared.payload_json,
                    event_fingerprint=prepared.event_fingerprint,
                )
            ),
        }

    def _persist_written_transfer_ref(
        self,
        session: Session,
        *,
        prepared: PreparedTigerBeetleTransferWrite,
        payload_json: Mapping[str, object],
        status: str,
    ) -> TigerBeetleTransferRef:
        cluster_id = self._settings.tigerbeetle_cluster_id
        transfer_spec = prepared.transfer_spec
        transfer_id_text = u128_decimal(transfer_spec.transfer_id)
        ref = TigerBeetleTransferRef(
            cluster_id=cluster_id,
            transfer_id=transfer_id_text,
            transfer_kind=transfer_spec.transfer_kind,
            ledger=transfer_spec.ledger,
            code=transfer_spec.code,
            amount=Decimal(transfer_spec.amount),
            status=status,
            result_code=status,
            trade_decision_id=cast(Any, prepared.trade_decision_id),
            execution_id=cast(Any, prepared.execution_id),
            execution_order_event_id=cast(Any, prepared.execution_order_event_id),
            execution_tca_metric_id=cast(Any, prepared.execution_tca_metric_id),
            runtime_ledger_bucket_id=cast(Any, prepared.runtime_ledger_bucket_id),
            source_type=prepared.source_type,
            source_id=prepared.source_id,
            event_fingerprint=prepared.event_fingerprint,
            payload_json=coerce_json_payload(payload_json),
        )
        try:
            with session.begin_nested():
                session.add(ref)
                session.flush()
        except IntegrityError:
            existing = find_transfer_ref(
                session,
                TransferRefLookupKey(
                    cluster_id=cluster_id,
                    transfer_id_text=transfer_id_text,
                    source_type=prepared.source_type,
                    source_id=prepared.source_id,
                    transfer_kind=transfer_spec.transfer_kind,
                ),
            )
            if existing is None:
                raise
            return merge_existing_transfer_ref(
                session,
                existing,
                prepared,
                payload_json=payload_json,
            )
        return ref

    def _persist_transfer_batch(
        self,
        session: Session,
        prepared_writes: Sequence[PreparedTigerBeetleTransferWrite],
    ) -> list[TigerBeetleTransferRef]:
        cluster_id = self._settings.tigerbeetle_cluster_id
        refs, new_writes = self._split_existing_transfer_writes(
            session,
            cluster_id=cluster_id,
            prepared_writes=prepared_writes,
        )
        if new_writes:
            self._persist_new_transfer_writes(
                session,
                cluster_id=cluster_id,
                refs=refs,
                new_writes=new_writes,
            )
        return [cast(TigerBeetleTransferRef, ref) for ref in refs]

    def _split_existing_transfer_writes(
        self,
        session: Session,
        *,
        cluster_id: int,
        prepared_writes: Sequence[PreparedTigerBeetleTransferWrite],
    ) -> tuple[
        list[TigerBeetleTransferRef | None], list[_PendingTigerBeetleTransferWrite]
    ]:
        refs: list[TigerBeetleTransferRef | None] = [None] * len(prepared_writes)
        pending: list[_PendingTigerBeetleTransferWrite] = []
        for index, prepared in enumerate(prepared_writes):
            payload_json = self._payload_with_stable_ref(prepared)
            existing = find_transfer_ref(
                session,
                self._transfer_lookup_key(cluster_id=cluster_id, prepared=prepared),
            )
            if existing is None:
                pending.append(
                    _PendingTigerBeetleTransferWrite(index, prepared, payload_json)
                )
                continue
            refs[index] = merge_existing_transfer_ref(
                session,
                existing,
                prepared,
                payload_json=payload_json,
            )
        return refs, pending

    @staticmethod
    def _transfer_lookup_key(
        *, cluster_id: int, prepared: PreparedTigerBeetleTransferWrite
    ) -> TransferRefLookupKey:
        transfer_spec = prepared.transfer_spec
        return TransferRefLookupKey(
            cluster_id=cluster_id,
            transfer_id_text=u128_decimal(transfer_spec.transfer_id),
            source_type=prepared.source_type,
            source_id=prepared.source_id,
            transfer_kind=transfer_spec.transfer_kind,
        )

    def _persist_new_transfer_writes(
        self,
        session: Session,
        *,
        cluster_id: int,
        refs: list[TigerBeetleTransferRef | None],
        new_writes: Sequence[_PendingTigerBeetleTransferWrite],
    ) -> None:
        account_specs = dedupe_account_specs(
            [spec for write in new_writes for spec in write.prepared.account_specs]
        )
        persist_account_refs(
            session,
            cluster_id=cluster_id,
            account_specs=account_specs,
        )
        client = self._client_for_write()
        account_statuses = result_statuses_by_index(
            client.create_accounts(account_specs),
            count=len(account_specs),
            default_status="created",
            status_type_names=("CreateAccountStatus",),
        )
        self._assert_account_create_statuses(account_specs, account_statuses)
        transfer_specs = [write.prepared.transfer_spec for write in new_writes]
        transfer_statuses = result_statuses_by_index(
            client.create_transfers(transfer_specs),
            count=len(transfer_specs),
            default_status="created",
            status_type_names=("CreateTransferStatus",),
        )
        existing_transfers_by_id = self._existing_transfers_by_id(
            client,
            transfer_specs=transfer_specs,
            transfer_statuses=transfer_statuses,
        )
        for batch_index, write in enumerate(new_writes):
            status = transfer_statuses[batch_index]
            if status not in {"created", "exists"}:
                raise RuntimeError(f"tigerbeetle_create_transfer_failed:{status}")
            if status == "exists":
                existing_transfer = existing_transfers_by_id.get(
                    write.prepared.transfer_spec.transfer_id
                )
                if existing_transfer is None or not transfer_matches(
                    existing_transfer,
                    write.prepared.transfer_spec,
                ):
                    raise RuntimeError("tigerbeetle_duplicate_transfer_conflict")
            refs[write.original_index] = self._persist_written_transfer_ref(
                session,
                prepared=write.prepared,
                payload_json=write.payload_json,
                status=status,
            )

    @staticmethod
    def _assert_account_create_statuses(
        account_specs: Sequence[TigerBeetleAccountSpec],
        account_statuses: Mapping[int, str],
    ) -> None:
        for index, status in account_statuses.items():
            if status in {"created", "exists"}:
                continue
            account_id = u128_decimal(account_specs[index].account_id)
            raise RuntimeError(
                f"tigerbeetle_create_account_failed:{account_id}:{status}"
            )

    @staticmethod
    def _existing_transfers_by_id(
        client: TigerBeetleClientProtocol,
        *,
        transfer_specs: Sequence[TigerBeetleTransferSpec],
        transfer_statuses: Mapping[int, str],
    ) -> dict[int, object]:
        existing_transfer_ids = list(
            dict.fromkeys(
                transfer_specs[index].transfer_id
                for index, status in transfer_statuses.items()
                if status == "exists"
            )
        )
        if not existing_transfer_ids:
            return {}
        return {
            int(transfer_attr(transfer, "id")): transfer
            for transfer in client.lookup_transfers(existing_transfer_ids)
        }

    def _persist_prepared_transfer(
        self, session: Session, prepared: PreparedTigerBeetleTransferWrite
    ) -> TigerBeetleTransferRef:
        return self._persist_transfer_batch(session, [prepared])[0]

    def _persist_transfer(
        self,
        session: Session,
        prepared: PreparedTigerBeetleTransferWrite,
    ) -> TigerBeetleTransferRef:
        return self._persist_prepared_transfer(session, prepared)

    def backfill_stable_ref_payloads(
        self,
        session: Session,
        *,
        limit: int = 1000,
    ) -> dict[str, object]:
        """Backfill stable audit-ref payloads on existing PostgreSQL refs only."""

        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return {"selected": 0, "updated": 0, "skipped": 0}
        return backfill_stable_ref_payloads_in_postgres(
            session,
            cluster_id=self.cluster_id,
            limit=limit,
        )

    def count_missing_stable_ref_payloads(self, session: Session) -> int:
        """Count repairable PostgreSQL transfer refs without a stable-ref object."""

        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return 0
        return count_missing_stable_ref_payloads_in_postgres(
            session,
            cluster_id=self.cluster_id,
        )

    def journal_order_events(
        self,
        session: Session,
        events: Sequence[ExecutionOrderEvent],
    ) -> list[TigerBeetleTransferRef | None]:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return [None for _ in events]

        indexes: list[int] = []
        prepared: list[PreparedTigerBeetleTransferWrite] = []
        refs: list[TigerBeetleTransferRef | None] = [None for _ in events]
        for index, event in enumerate(events):
            plan = build_order_event_transfer_plan(
                session,
                event,
                settings_obj=self._settings,
            )
            if plan is None:
                continue
            transfer_spec = plan.transfer_spec
            indexes.append(index)
            prepared.append(
                PreparedTigerBeetleTransferWrite(
                    account_specs=plan.account_specs,
                    transfer_spec=transfer_spec,
                    trade_decision_id=event.trade_decision_id,
                    execution_id=event.execution_id,
                    execution_order_event_id=event.id,
                    execution_tca_metric_id=None,
                    runtime_ledger_bucket_id=None,
                    event_fingerprint=event.event_fingerprint,
                    source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    source_id=str(event.id),
                    payload_json={
                        "debit_account_id": u128_decimal(
                            transfer_spec.debit_account_id
                        ),
                        "credit_account_id": u128_decimal(
                            transfer_spec.credit_account_id
                        ),
                        "pending_id": u128_decimal(transfer_spec.pending_id)
                        if transfer_spec.pending_id
                        else None,
                        "pending_mode": plan.pending_mode,
                        "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    },
                )
            )
        for index, ref in zip(indexes, self._persist_transfer_batch(session, prepared)):
            refs[index] = ref
        return refs

    def journal_executions(
        self,
        session: Session,
        executions: Sequence[Execution],
    ) -> list[TigerBeetleTransferRef | None]:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return [None for _ in executions]

        indexes: list[int] = []
        prepared: list[PreparedTigerBeetleTransferWrite] = []
        refs: list[TigerBeetleTransferRef | None] = [None for _ in executions]
        for index, execution in enumerate(executions):
            plan = build_execution_transfer_plan(execution)
            if plan is None:
                continue
            transfer_spec = plan.transfer_spec
            indexes.append(index)
            prepared.append(
                PreparedTigerBeetleTransferWrite(
                    account_specs=plan.account_specs,
                    transfer_spec=transfer_spec,
                    trade_decision_id=execution.trade_decision_id,
                    execution_id=execution.id,
                    execution_order_event_id=None,
                    execution_tca_metric_id=None,
                    runtime_ledger_bucket_id=None,
                    event_fingerprint=None,
                    source_type=SOURCE_TYPE_EXECUTION,
                    source_id=str(execution.id),
                    payload_json={
                        "source": SOURCE_TYPE_EXECUTION,
                        "source_refs": [
                            f"postgres:executions:{execution.id}",
                        ],
                        "source_row_id": str(execution.id),
                        "source_economic_fingerprint": execution_source_id(
                            execution
                        ).split(":", 1)[1],
                        "economic_event_key": execution_economic_event_key(execution),
                        "alpaca_order_id": execution.alpaca_order_id,
                        "client_order_id": execution.client_order_id,
                        "filled_qty": str(execution.filled_qty),
                        "avg_fill_price": str(execution.avg_fill_price),
                        "amount_source": str(plan.amount_source),
                        "notional_micros": transfer_spec.amount,
                        "transfer_id": u128_decimal(transfer_spec.transfer_id),
                        "ledger": transfer_spec.ledger,
                        "code": transfer_spec.code,
                        "debit_account_id": u128_decimal(
                            transfer_spec.debit_account_id
                        ),
                        "credit_account_id": u128_decimal(
                            transfer_spec.credit_account_id
                        ),
                    },
                )
            )
        for index, ref in zip(indexes, self._persist_transfer_batch(session, prepared)):
            refs[index] = ref
        return refs

    def journal_execution_tca_metrics(
        self,
        session: Session,
        metrics: Sequence[ExecutionTCAMetric],
    ) -> list[TigerBeetleTransferRef | None]:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return [None for _ in metrics]

        indexes: list[int] = []
        prepared: list[PreparedTigerBeetleTransferWrite] = []
        refs: list[TigerBeetleTransferRef | None] = [None for _ in metrics]
        for index, metric in enumerate(metrics):
            plan = build_execution_tca_metric_transfer_plan(metric)
            if plan is None:
                continue
            transfer_spec = plan.transfer_spec
            indexes.append(index)
            prepared.append(
                PreparedTigerBeetleTransferWrite(
                    account_specs=plan.account_specs,
                    transfer_spec=transfer_spec,
                    trade_decision_id=metric.trade_decision_id,
                    execution_id=metric.execution_id,
                    execution_order_event_id=None,
                    execution_tca_metric_id=metric.id,
                    runtime_ledger_bucket_id=None,
                    event_fingerprint=None,
                    source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
                    source_id=execution_tca_metric_source_id(metric),
                    payload_json={
                        "source": SOURCE_TYPE_EXECUTION_TCA_METRIC,
                        "source_refs": [
                            f"postgres:execution_tca_metrics:{metric.id}",
                            f"postgres:executions:{metric.execution_id}",
                        ],
                        "source_row_id": str(metric.id),
                        "source_economic_fingerprint": (
                            execution_tca_metric_source_id(metric).split(":", 1)[1]
                        ),
                        "economic_event_key": (
                            execution_tca_metric_economic_event_key(metric)
                        ),
                        "shortfall_notional": str(metric.shortfall_notional),
                        "realized_shortfall_bps": str(metric.realized_shortfall_bps),
                        "simulator_version": metric.simulator_version,
                        "amount_source": str(plan.amount_source),
                        "cost_micros": transfer_spec.amount,
                        "transfer_id": u128_decimal(transfer_spec.transfer_id),
                        "ledger": transfer_spec.ledger,
                        "code": transfer_spec.code,
                        "debit_account_id": u128_decimal(
                            transfer_spec.debit_account_id
                        ),
                        "credit_account_id": u128_decimal(
                            transfer_spec.credit_account_id
                        ),
                        "account_ids": [
                            u128_decimal(spec.account_id) for spec in plan.account_specs
                        ],
                        "account_keys": [
                            spec.account_key for spec in plan.account_specs
                        ],
                        "authority": "accounting_parity_only",
                        "promotion_authority": False,
                        "overrides_runtime_ledger_authority": False,
                    },
                )
            )
        for index, ref in zip(indexes, self._persist_transfer_batch(session, prepared)):
            refs[index] = ref
        return refs

    def journal_runtime_ledger_buckets(
        self,
        session: Session,
        buckets: Sequence[StrategyRuntimeLedgerBucket],
    ) -> list[TigerBeetleTransferRef | None]:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return [None for _ in buckets]

        indexes: list[int] = []
        prepared: list[PreparedTigerBeetleTransferWrite] = []
        refs: list[TigerBeetleTransferRef | None] = [None for _ in buckets]
        for index, bucket in enumerate(buckets):
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            if plan is None:
                continue
            transfer_spec = plan.transfer_spec
            indexes.append(index)
            prepared.append(
                PreparedTigerBeetleTransferWrite(
                    account_specs=plan.account_specs,
                    transfer_spec=transfer_spec,
                    trade_decision_id=None,
                    execution_id=None,
                    execution_order_event_id=None,
                    execution_tca_metric_id=None,
                    runtime_ledger_bucket_id=bucket.id,
                    event_fingerprint=None,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "source_refs": [
                            f"postgres:strategy_runtime_ledger_buckets:{bucket.id}",
                        ],
                        "source_row_id": str(bucket.id),
                        "run_id": bucket.run_id,
                        "candidate_id": bucket.candidate_id,
                        "hypothesis_id": bucket.hypothesis_id,
                        "observed_stage": bucket.observed_stage,
                        "pnl_basis": bucket.pnl_basis,
                        "ledger_schema_version": bucket.ledger_schema_version,
                        "filled_notional": str(bucket.filled_notional),
                        "gross_strategy_pnl": str(bucket.gross_strategy_pnl),
                        "cost_amount": str(bucket.cost_amount),
                        "net_strategy_pnl_after_costs": str(
                            bucket.net_strategy_pnl_after_costs
                        ),
                        "amount_source": str(plan.amount_source),
                        "amount_micros": transfer_spec.amount,
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "runtime_key": plan.runtime_key,
                        "transfer_id": u128_decimal(transfer_spec.transfer_id),
                        "ledger": transfer_spec.ledger,
                        "code": transfer_spec.code,
                        "debit_account_id": u128_decimal(
                            transfer_spec.debit_account_id
                        ),
                        "credit_account_id": u128_decimal(
                            transfer_spec.credit_account_id
                        ),
                    },
                )
            )
        for index, ref in zip(indexes, self._persist_transfer_batch(session, prepared)):
            refs[index] = ref
        return refs

    def journal_order_event(
        self, session: Session, event: ExecutionOrderEvent
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        plan = build_order_event_transfer_plan(
            session,
            event,
            settings_obj=self._settings,
        )
        if plan is None:
            return None

        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            PreparedTigerBeetleTransferWrite(
                account_specs=tuple(plan.account_specs),
                transfer_spec=transfer_spec,
                trade_decision_id=event.trade_decision_id,
                execution_id=event.execution_id,
                execution_order_event_id=event.id,
                execution_tca_metric_id=None,
                runtime_ledger_bucket_id=None,
                event_fingerprint=event.event_fingerprint,
                source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                source_id=str(event.id),
                payload_json={
                    "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                    "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
                    "pending_id": u128_decimal(transfer_spec.pending_id)
                    if transfer_spec.pending_id
                    else None,
                    "pending_mode": plan.pending_mode,
                    "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                },
            ),
        )

    def journal_execution(
        self, session: Session, execution: Execution
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        plan = build_execution_transfer_plan(execution)
        if plan is None:
            return None
        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            PreparedTigerBeetleTransferWrite(
                account_specs=tuple(plan.account_specs),
                transfer_spec=transfer_spec,
                trade_decision_id=execution.trade_decision_id,
                execution_id=execution.id,
                execution_order_event_id=None,
                execution_tca_metric_id=None,
                runtime_ledger_bucket_id=None,
                event_fingerprint=None,
                source_type=SOURCE_TYPE_EXECUTION,
                source_id=str(execution.id),
                payload_json={
                    "source": SOURCE_TYPE_EXECUTION,
                    "source_refs": [
                        f"postgres:executions:{execution.id}",
                    ],
                    "source_row_id": str(execution.id),
                    "source_economic_fingerprint": execution_source_id(execution).split(
                        ":", 1
                    )[1],
                    "economic_event_key": execution_economic_event_key(execution),
                    "alpaca_order_id": execution.alpaca_order_id,
                    "client_order_id": execution.client_order_id,
                    "filled_qty": str(execution.filled_qty),
                    "avg_fill_price": str(execution.avg_fill_price),
                    "amount_source": str(plan.amount_source),
                    "notional_micros": transfer_spec.amount,
                    "transfer_id": u128_decimal(transfer_spec.transfer_id),
                    "ledger": transfer_spec.ledger,
                    "code": transfer_spec.code,
                    "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                    "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
                },
            ),
        )

    def journal_execution_tca_metric(
        self, session: Session, metric: ExecutionTCAMetric
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        plan = build_execution_tca_metric_transfer_plan(metric)
        if plan is None:
            return None
        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            PreparedTigerBeetleTransferWrite(
                account_specs=tuple(plan.account_specs),
                transfer_spec=transfer_spec,
                trade_decision_id=metric.trade_decision_id,
                execution_id=metric.execution_id,
                execution_order_event_id=None,
                execution_tca_metric_id=metric.id,
                runtime_ledger_bucket_id=None,
                event_fingerprint=None,
                source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
                source_id=execution_tca_metric_source_id(metric),
                payload_json={
                    "source": SOURCE_TYPE_EXECUTION_TCA_METRIC,
                    "source_refs": [
                        f"postgres:execution_tca_metrics:{metric.id}",
                        f"postgres:executions:{metric.execution_id}",
                    ],
                    "source_row_id": str(metric.id),
                    "source_economic_fingerprint": execution_tca_metric_source_id(
                        metric
                    ).split(":", 1)[1],
                    "economic_event_key": execution_tca_metric_economic_event_key(
                        metric
                    ),
                    "shortfall_notional": str(metric.shortfall_notional),
                    "realized_shortfall_bps": str(metric.realized_shortfall_bps),
                    "simulator_version": metric.simulator_version,
                    "amount_source": str(plan.amount_source),
                    "cost_micros": transfer_spec.amount,
                    "transfer_id": u128_decimal(transfer_spec.transfer_id),
                    "ledger": transfer_spec.ledger,
                    "code": transfer_spec.code,
                    "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                    "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
                },
            ),
        )

    def journal_runtime_ledger_bucket(
        self, session: Session, bucket: StrategyRuntimeLedgerBucket
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        plan = build_runtime_ledger_bucket_transfer_plan(bucket)
        if plan is None:
            return None
        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            PreparedTigerBeetleTransferWrite(
                account_specs=tuple(plan.account_specs),
                transfer_spec=transfer_spec,
                trade_decision_id=None,
                execution_id=None,
                execution_order_event_id=None,
                execution_tca_metric_id=None,
                runtime_ledger_bucket_id=bucket.id,
                event_fingerprint=None,
                source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json={
                    "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    "source_refs": [
                        f"postgres:strategy_runtime_ledger_buckets:{bucket.id}",
                    ],
                    "source_row_id": str(bucket.id),
                    "run_id": bucket.run_id,
                    "candidate_id": bucket.candidate_id,
                    "hypothesis_id": bucket.hypothesis_id,
                    "observed_stage": bucket.observed_stage,
                    "pnl_basis": bucket.pnl_basis,
                    "ledger_schema_version": bucket.ledger_schema_version,
                    "filled_notional": str(bucket.filled_notional),
                    "gross_strategy_pnl": str(bucket.gross_strategy_pnl),
                    "cost_amount": str(bucket.cost_amount),
                    "net_strategy_pnl_after_costs": str(
                        bucket.net_strategy_pnl_after_costs
                    ),
                    "amount_source": str(plan.amount_source),
                    "amount_micros": transfer_spec.amount,
                    "signed_amount_micros": plan.signed_amount_micros,
                    "pnl_direction": plan.pnl_direction,
                    "runtime_key": plan.runtime_key,
                    "transfer_id": u128_decimal(transfer_spec.transfer_id),
                    "ledger": transfer_spec.ledger,
                    "code": transfer_spec.code,
                    "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                    "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
                    "account_ids": [
                        u128_decimal(spec.account_id) for spec in plan.account_specs
                    ],
                    "account_keys": [spec.account_key for spec in plan.account_specs],
                    "authority": "accounting_parity_only",
                    "promotion_authority": False,
                    "overrides_runtime_ledger_authority": False,
                },
            ),
        )
