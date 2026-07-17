#!/usr/bin/env python3
"""Build a closed, append-only order-lineage census across live and SIM DSNs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    BrokerAccountActivity,
    BrokerEconomicLedgerInput,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from app.trading.broker_account_activities import ACCOUNT_ACTIVITIES_REST_SOURCE
from app.trading.economic_ledger import (
    LedgerScope,
    load_broker_economic_ledger_source_rows,
    prepare_broker_economic_ledger_snapshot,
)
from app.trading.order_lineage_census import (
    BrokerActivityFact,
    ExecutionLineageFact,
    OrderEventFact,
    OrderLineageCensusBuild,
    OrderLineageCensusEvidence,
    build_order_lineage_census,
)
from app.trading.order_lineage_runs import (
    OrderLineageCensusSources,
    OrderLineageRepairRunDraft,
    PersistedOrderLineageCensus,
    build_order_lineage_canonical_execution_import,
    build_order_lineage_repair_run,
    persist_order_lineage_census,
)


@dataclass(frozen=True, slots=True)
class RuntimeCensus:
    broker_input: BrokerEconomicLedgerInput
    census: OrderLineageCensusBuild
    source_account_label_sha256: str
    canonical_account_label_sha256: str
    canonical_source_database_sha256: str


@dataclass(frozen=True, slots=True)
class RuntimeCensusRequest:
    provider: str
    environment: str | None
    source_account_label: str | None
    canonical_account_label: str | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build a closed order-level lineage census without mutating source rows."
        )
    )
    parser.add_argument("--event-dsn-env", default="DB_DSN")
    parser.add_argument("--canonical-dsn-env", default="SIM_DB_DSN")
    parser.add_argument(
        "--source-account-label",
        default=os.getenv("TRADING_ACCOUNT_LABEL", ""),
    )
    parser.add_argument(
        "--canonical-account-label",
        default=os.getenv("SIM_TRADING_ACCOUNT_LABEL", ""),
    )
    parser.add_argument("--provider", default="alpaca")
    parser.add_argument("--environment", default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def sqlalchemy_dsn(dsn: str) -> str:
    value = dsn.strip()
    if value.startswith("postgresql+psycopg://"):
        return value
    if value.startswith("postgres://"):
        return value.replace("postgres://", "postgresql+psycopg://", 1)
    if value.startswith("postgresql://"):
        return value.replace("postgresql://", "postgresql+psycopg://", 1)
    return value


def reconcile_cross_dsn_order_feed_links(
    event_session: Session,
    canonical_session: Session,
    *,
    event_dsn_env: str,
    canonical_dsn_env: str,
    source_account_label: str | None,
    canonical_account_label: str | None = None,
    provider: str = "alpaca",
    environment: str | None = None,
    apply: bool = False,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build and optionally persist one full, source-closed census."""

    normalized_provider = _required_text(
        provider,
        "order_lineage_provider_missing",
    ).lower()
    runtime = load_runtime_census(
        event_session,
        canonical_session,
        RuntimeCensusRequest(
            provider=normalized_provider,
            environment=_optional_text(environment),
            source_account_label=_optional_text(source_account_label),
            canonical_account_label=_optional_text(canonical_account_label),
        ),
    )
    sources = _census_sources(runtime)
    run_draft = build_order_lineage_repair_run(sources, runtime.census.receipts)
    observed_at = _as_utc(now or datetime.now(timezone.utc))
    persisted = (
        persist_order_lineage_census(
            event_session,
            sources,
            runtime.census.receipts,
            observed_at=observed_at,
        )
        if apply
        else None
    )
    return _report(
        runtime,
        run_draft=run_draft,
        persisted=persisted,
        event_dsn_env=event_dsn_env,
        canonical_dsn_env=canonical_dsn_env,
        apply=apply,
        observed_at=observed_at,
    )


def load_runtime_census(
    event_session: Session,
    canonical_session: Session,
    request: RuntimeCensusRequest,
) -> RuntimeCensus:
    resolved_source_account = resolve_source_account_label(
        event_session,
        provider=request.provider,
        environment=request.environment,
        requested=request.source_account_label,
    )
    broker_input, activities = _load_verified_broker_input(
        event_session,
        provider=request.provider,
        environment=request.environment,
        account_label=resolved_source_account,
    )
    resolved_canonical_account = resolve_canonical_account_label(
        canonical_session,
        requested=request.canonical_account_label,
    )
    census = build_order_lineage_census(
        OrderLineageCensusEvidence(
            provider=broker_input.provider,
            environment=broker_input.environment,
            account_label=resolved_source_account,
            canonical_account_label_sha256=_sha256(resolved_canonical_account),
            order_events=load_order_events(
                event_session,
                account_label=resolved_source_account,
            ),
            broker_activities=activities,
            local_executions=load_execution_lineage(
                event_session,
                account_label=resolved_source_account,
                source="local",
            ),
            canonical_executions=load_execution_lineage(
                canonical_session,
                account_label=resolved_canonical_account,
                source="canonical_cross_dsn",
            ),
        )
    )
    return RuntimeCensus(
        broker_input=broker_input,
        census=census,
        source_account_label_sha256=_sha256(resolved_source_account),
        canonical_account_label_sha256=_sha256(resolved_canonical_account),
        canonical_source_database_sha256=_database_identity_sha256(canonical_session),
    )


def _load_verified_broker_input(
    session: Session,
    *,
    provider: str,
    environment: str | None,
    account_label: str,
) -> tuple[BrokerEconomicLedgerInput, tuple[BrokerActivityFact, ...]]:
    query = select(BrokerEconomicLedgerInput).where(
        BrokerEconomicLedgerInput.provider == provider,
        BrokerEconomicLedgerInput.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
        BrokerEconomicLedgerInput.account_label == account_label,
    )
    if environment is not None:
        query = query.where(BrokerEconomicLedgerInput.environment == environment)
    broker_input = session.scalar(
        query.order_by(
            BrokerEconomicLedgerInput.source_watermark.desc(),
            BrokerEconomicLedgerInput.created_at.desc(),
        ).limit(1)
    )
    if broker_input is None:
        raise ValueError("order_lineage_broker_input_missing")
    scope = LedgerScope(
        provider=broker_input.provider,
        environment=broker_input.environment,
        account_label=broker_input.account_label,
        endpoint_fingerprint=broker_input.endpoint_fingerprint,
        quote_currency=broker_input.quote_currency,
    )
    snapshot = prepare_broker_economic_ledger_snapshot(
        load_broker_economic_ledger_source_rows(session, scope=scope)
    )
    if (
        snapshot.cursor_id != broker_input.source_cursor_id
        or snapshot.source_watermark != _as_utc(broker_input.source_watermark)
        or len(snapshot.activities) != broker_input.input_count
        or snapshot.prepared.manifest_digest != broker_input.manifest_sha256
        or snapshot.input_manifest_canonical_json
        != broker_input.manifest_canonical_json
    ):
        raise ValueError("order_lineage_broker_input_not_current")
    rows = tuple(
        session.scalars(
            select(BrokerAccountActivity)
            .where(
                BrokerAccountActivity.provider == scope.provider,
                BrokerAccountActivity.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
                BrokerAccountActivity.environment == scope.environment,
                BrokerAccountActivity.account_label == scope.account_label,
                BrokerAccountActivity.endpoint_fingerprint
                == scope.endpoint_fingerprint,
            )
            .order_by(BrokerAccountActivity.external_activity_id)
        )
    )
    if len(rows) != broker_input.input_count:
        raise ValueError("order_lineage_broker_activity_count_mismatch")
    return broker_input, tuple(
        BrokerActivityFact(
            id=row.id,
            external_activity_id=row.external_activity_id,
            activity_type=row.activity_type,
            broker_order_id=row.order_id,
            client_order_id=row.client_order_id,
            event_at=_as_utc(row.event_at or row.first_observed_at),
        )
        for row in rows
        if row.order_id is not None or row.client_order_id is not None
    )


def load_order_events(
    session: Session,
    *,
    account_label: str,
) -> tuple[OrderEventFact, ...]:
    rows = tuple(
        session.scalars(
            select(ExecutionOrderEvent)
            .where(ExecutionOrderEvent.alpaca_account_label == account_label)
            .order_by(
                ExecutionOrderEvent.source_topic,
                ExecutionOrderEvent.source_partition,
                ExecutionOrderEvent.source_offset,
                ExecutionOrderEvent.id,
            )
        )
    )
    return tuple(
        OrderEventFact(
            id=row.id,
            event_fingerprint=row.event_fingerprint,
            broker_order_id=row.alpaca_order_id,
            client_order_id=row.client_order_id,
            event_at=_as_utc(row.event_ts or row.created_at),
            is_fill=_positive(row.filled_qty_delta),
            execution_id=row.execution_id,
            trade_decision_id=row.trade_decision_id,
            source_topic=row.source_topic,
            source_partition=row.source_partition,
            source_offset=row.source_offset,
        )
        for row in rows
    )


def load_execution_lineage(
    session: Session,
    *,
    account_label: str,
    source: str,
) -> tuple[ExecutionLineageFact, ...]:
    decision_identity = func.coalesce(
        Execution.trade_decision_id,
        ExecutionTCAMetric.trade_decision_id,
    )
    rows = session.execute(
        select(
            Execution.id,
            Execution.alpaca_order_id,
            Execution.client_order_id,
            Execution.execution_idempotency_key,
            TradeDecision.id,
            func.coalesce(TradeDecision.strategy_id, ExecutionTCAMetric.strategy_id),
            TradeDecisionSubmissionClaim.trade_decision_id,
            ExecutionTCAMetric.id,
            Execution.updated_at,
        )
        .outerjoin(
            ExecutionTCAMetric,
            ExecutionTCAMetric.execution_id == Execution.id,
        )
        .outerjoin(TradeDecision, TradeDecision.id == decision_identity)
        .outerjoin(
            TradeDecisionSubmissionClaim,
            TradeDecisionSubmissionClaim.trade_decision_id == TradeDecision.id,
        )
        .where(Execution.alpaca_account_label == account_label)
        .order_by(Execution.id)
    ).tuples()
    return tuple(
        ExecutionLineageFact(
            source=source,
            execution_id=execution_id,
            broker_order_id=broker_order_id,
            client_order_id=client_order_id,
            idempotency_key=idempotency_key,
            trade_decision_id=trade_decision_id,
            strategy_id=strategy_id,
            submission_claim_id=submission_claim_id,
            tca_metric_id=tca_metric_id,
            updated_at=_database_utc(session, updated_at),
        )
        for (
            execution_id,
            broker_order_id,
            client_order_id,
            idempotency_key,
            trade_decision_id,
            strategy_id,
            submission_claim_id,
            tca_metric_id,
            updated_at,
        ) in rows
    )


def resolve_canonical_account_label(
    session: Session,
    *,
    requested: str | None,
) -> str:
    labels = tuple(
        session.scalars(
            select(Execution.alpaca_account_label)
            .distinct()
            .order_by(Execution.alpaca_account_label)
        )
    )
    if requested is not None:
        if requested not in labels:
            raise ValueError("order_lineage_canonical_account_not_found")
        return requested
    if len(labels) != 1:
        raise ValueError("order_lineage_canonical_account_ambiguous")
    return labels[0]


def resolve_source_account_label(
    session: Session,
    *,
    provider: str,
    environment: str | None,
    requested: str | None,
) -> str:
    if requested is not None:
        return requested
    query = select(BrokerEconomicLedgerInput.account_label).where(
        BrokerEconomicLedgerInput.provider == provider,
        BrokerEconomicLedgerInput.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
    )
    if environment is not None:
        query = query.where(BrokerEconomicLedgerInput.environment == environment)
    labels = tuple(
        session.scalars(
            query.distinct().order_by(BrokerEconomicLedgerInput.account_label)
        )
    )
    if not labels:
        raise ValueError("order_lineage_source_account_missing")
    if len(labels) != 1:
        raise ValueError("order_lineage_source_account_ambiguous")
    return labels[0]


def _census_sources(runtime: RuntimeCensus) -> OrderLineageCensusSources:
    broker_input = runtime.broker_input
    canonical_execution_import = build_order_lineage_canonical_execution_import(
        provider=broker_input.provider,
        environment=broker_input.environment,
        account_label=broker_input.account_label,
        source_database_sha256=runtime.canonical_source_database_sha256,
        execution_manifest=runtime.census.execution_manifest,
    )
    return OrderLineageCensusSources(
        provider=broker_input.provider,
        environment=broker_input.environment,
        account_label=broker_input.account_label,
        broker_economic_input_id=broker_input.id,
        broker_economic_source=broker_input.source,
        broker_economic_manifest_sha256=broker_input.manifest_sha256,
        broker_activity_count=broker_input.input_count,
        broker_source_watermark=_as_utc(broker_input.source_watermark),
        broker_order_link_manifest=runtime.census.broker_order_link_manifest,
        order_feed_manifest=runtime.census.order_feed_manifest,
        execution_manifest=runtime.census.execution_manifest,
        canonical_execution_import=canonical_execution_import,
    )


def _report(
    runtime: RuntimeCensus,
    *,
    run_draft: OrderLineageRepairRunDraft,
    persisted: PersistedOrderLineageCensus | None,
    event_dsn_env: str,
    canonical_dsn_env: str,
    apply: bool,
    observed_at: datetime,
) -> dict[str, object]:
    result = run_draft.result
    return {
        "status": "ok",
        "apply": apply,
        "closed_census": True,
        "event_dsn_env": event_dsn_env,
        "canonical_dsn_env": canonical_dsn_env,
        "source_account_sha256": runtime.source_account_label_sha256,
        "canonical_account_sha256": runtime.canonical_account_label_sha256,
        "broker_economic_input_id": str(runtime.broker_input.id),
        "broker_activity_count": runtime.broker_input.input_count,
        "order_event_count": runtime.census.order_feed_manifest["event_count"],
        "receipt_count": run_draft.receipt_count,
        "classification_counts": result["classification_counts"],
        "source_coverage_counts": result["source_coverage_counts"],
        "receipt_set_sha256": result["receipt_set_sha256"],
        "input_manifest_sha256": run_draft.input_manifest_sha256,
        "result_sha256": run_draft.result_sha256,
        "run_id": str(persisted.run.run.id) if persisted is not None else None,
        "run_reused": (
            persisted.run.reused_existing if persisted is not None else None
        ),
        "inserted_receipt_count": (
            persisted.inserted_receipt_count if persisted is not None else 0
        ),
        "reused_receipt_count": (
            persisted.reused_receipt_count if persisted is not None else 0
        ),
        "source_rows_mutated": 0,
        "promotion_authority_eligible": False,
        "completed_at": observed_at.isoformat(),
    }


def main() -> int:
    args = parse_args()
    event_dsn = os.environ.get(str(args.event_dsn_env).strip())
    canonical_dsn = os.environ.get(str(args.canonical_dsn_env).strip())
    if not event_dsn:
        raise SystemExit(f"missing DSN env var: {args.event_dsn_env}")
    if not canonical_dsn:
        raise SystemExit(f"missing DSN env var: {args.canonical_dsn_env}")
    event_engine = create_engine(
        sqlalchemy_dsn(event_dsn),
        pool_pre_ping=True,
        future=True,
    )
    canonical_engine = create_engine(
        sqlalchemy_dsn(canonical_dsn),
        pool_pre_ping=True,
        future=True,
    )
    event_sessions = sessionmaker(bind=event_engine, expire_on_commit=False)
    canonical_sessions = sessionmaker(bind=canonical_engine, expire_on_commit=False)
    with event_sessions() as event_session, canonical_sessions() as canonical_session:
        payload = reconcile_cross_dsn_order_feed_links(
            event_session,
            canonical_session,
            event_dsn_env=str(args.event_dsn_env),
            canonical_dsn_env=str(args.canonical_dsn_env),
            source_account_label=_optional_text(args.source_account_label),
            canonical_account_label=_optional_text(args.canonical_account_label),
            provider=str(args.provider),
            environment=_optional_text(args.environment),
            apply=bool(args.apply),
        )
        if args.apply:
            event_session.commit()
        else:
            event_session.rollback()
        canonical_session.rollback()
    print(
        json.dumps(payload, sort_keys=True, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2, sort_keys=True)
    )
    return 0


def _positive(value: Decimal | None) -> bool:
    return value is not None and value > 0


def _database_utc(session: Session, value: datetime) -> datetime:
    if value.tzinfo is None and session.get_bind().dialect.name == "sqlite":
        value = value.replace(tzinfo=timezone.utc)
    return _as_utc(value)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("order_lineage_timestamp_timezone_missing")
    return value.astimezone(timezone.utc)


def _required_text(value: object, error: str) -> str:
    normalized = str(value).strip() if value is not None else ""
    if not normalized:
        raise ValueError(error)
    return normalized


def _optional_text(value: object) -> str | None:
    normalized = str(value).strip() if value is not None else ""
    return normalized or None


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _database_identity_sha256(session: Session) -> str:
    bind = session.get_bind()
    url = getattr(bind, "url", None)
    if url is None:
        identity = {"backend": bind.dialect.name}
    else:
        identity = {
            "backend": url.get_backend_name(),
            "database": url.database or "",
            "host": url.host or "",
            "port": url.port,
        }
    return _sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    raise SystemExit(main())
