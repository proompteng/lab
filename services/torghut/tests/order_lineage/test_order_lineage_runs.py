from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import (
    Base,
    BrokerEconomicLedgerInput,
    OrderLineageRepairReceipt,
    OrderLineageRepairRun,
)
from app.trading.order_lineage_receipts import (
    CLASSIFICATION_BROKER_ACTIVITY_ONLY,
    CLASSIFICATION_LINKED_INCOMPLETE,
    CONFIDENCE_EXACT,
    CONFIDENCE_UNPROVED,
    EXECUTION_SOURCE_CROSS_DSN,
    EXECUTION_SOURCE_NONE,
    MATCH_BASIS_ALPACA_ORDER_ID,
    OrderLineageEvidence,
    OrderLineageReceiptDraft,
    build_order_lineage_receipt,
)
from app.trading.order_lineage_runs import (
    OrderLineageCensusSources,
    build_order_lineage_repair_run,
    load_order_lineage_repair_status,
    persist_order_lineage_census,
)


BASE_TIME = datetime(2026, 7, 17, 1, 0, tzinfo=timezone.utc)
BROKER_INPUT_ID = uuid.UUID("00000000-0000-0000-0000-000000000100")


def linked_receipt(order_number: int) -> OrderLineageReceiptDraft:
    order_event_id = uuid.UUID(f"00000000-0000-0000-0000-{order_number:012d}")
    broker_fill_id = uuid.UUID(f"00000000-0000-0000-0001-{order_number:012d}")
    return build_order_lineage_receipt(
        OrderLineageEvidence(
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
            alpaca_order_id=f"broker-order-{order_number}",
            client_order_id=f"decision-{order_number}",
            classification=CLASSIFICATION_LINKED_INCOMPLETE,
            confidence=CONFIDENCE_EXACT,
            execution_source=EXECUTION_SOURCE_CROSS_DSN,
            canonical_execution_id=uuid.uuid4(),
            order_event_ids=(order_event_id,),
            fill_order_event_ids=(order_event_id,),
            broker_activity_ids=(broker_fill_id,),
            broker_fill_activity_ids=(broker_fill_id,),
            source_first_at=BASE_TIME,
            source_last_at=BASE_TIME,
            match_basis=(MATCH_BASIS_ALPACA_ORDER_ID,),
            blockers=("submission_claim_missing",),
        )
    )


def broker_only_receipt(order_number: int) -> OrderLineageReceiptDraft:
    broker_fill_id = uuid.UUID(f"00000000-0000-0000-0002-{order_number:012d}")
    return build_order_lineage_receipt(
        OrderLineageEvidence(
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
            alpaca_order_id=f"external-order-{order_number}",
            client_order_id=None,
            classification=CLASSIFICATION_BROKER_ACTIVITY_ONLY,
            confidence=CONFIDENCE_UNPROVED,
            execution_source=EXECUTION_SOURCE_NONE,
            broker_activity_ids=(broker_fill_id,),
            broker_fill_activity_ids=(broker_fill_id,),
            source_first_at=BASE_TIME,
            source_last_at=BASE_TIME,
            blockers=("order_feed_missing",),
        )
    )


def census_sources() -> OrderLineageCensusSources:
    return OrderLineageCensusSources(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        broker_economic_input_id=BROKER_INPUT_ID,
        broker_economic_source="account_activities_rest",
        broker_economic_manifest_sha256="b" * 64,
        broker_activity_count=2,
        broker_source_watermark=BASE_TIME,
        broker_order_link_manifest={
            "activity_count": 2,
            "activity_set_sha256": "a" * 64,
        },
        order_feed_manifest={
            "event_count": 1,
            "event_set_sha256": "c" * 64,
            "partitions": [{"partition": 0, "max_offset": 10}],
        },
        execution_manifest={
            "execution_count": 1,
            "execution_set_sha256": "d" * 64,
        },
    )


def test_run_is_deterministic_and_counts_every_classification() -> None:
    linked = linked_receipt(1)
    broker_only = broker_only_receipt(2)
    first = build_order_lineage_repair_run(
        census_sources(),
        [linked, broker_only],
    )
    second = build_order_lineage_repair_run(
        census_sources(),
        [broker_only, linked],
    )

    assert first.input_manifest_sha256 == second.input_manifest_sha256
    assert first.result_sha256 == second.result_sha256
    assert first.receipt_count == 2
    assert first.result["classification_counts"] == {
        "ambiguous": 0,
        "broker_activity_only": 1,
        "complete": 0,
        "external_or_unproved": 0,
        "linked_incomplete": 1,
        "order_feed_only": 0,
    }
    assert first.result["source_coverage_counts"] == {
        "both": 1,
        "broker_activity_only": 1,
        "order_feed_only": 0,
    }
    assert first.result["confidence_counts"] == {
        "ambiguous": 0,
        "exact": 1,
        "unproved": 1,
    }
    assert first.result["execution_source_counts"] == {
        "canonical_cross_dsn": 1,
        "local": 0,
        "none": 1,
    }
    assert first.result["promotion_authority_eligible"] is False


def test_run_rejects_duplicate_identity_and_scope_drift() -> None:
    receipt = linked_receipt(1)
    with pytest.raises(ValueError, match="duplicate_order_identity"):
        build_order_lineage_repair_run(census_sources(), [receipt, receipt])
    with pytest.raises(ValueError, match="receipt_scope_mismatch"):
        build_order_lineage_repair_run(
            replace(census_sources(), environment="live"),
            [receipt],
        )


def test_census_persistence_reuses_exact_run_and_rejects_nondeterminism() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    receipts = [linked_receipt(1), broker_only_receipt(2)]

    with Session(engine) as session, session.begin():
        session.add(
            BrokerEconomicLedgerInput(
                id=BROKER_INPUT_ID,
                provider="alpaca",
                source="account_activities_rest",
                environment="paper",
                account_label="paper-account",
                endpoint_fingerprint="e" * 64,
                quote_currency="USD",
                source_cursor_id=uuid.uuid4(),
                source_watermark=BASE_TIME,
                input_count=2,
                duplicate_count=0,
                corrected_count=0,
                manifest_canonical_json="{}",
                manifest_sha256="b" * 64,
            )
        )
        first = persist_order_lineage_census(
            session,
            census_sources(),
            receipts,
            observed_at=BASE_TIME,
        )
        second = persist_order_lineage_census(
            session,
            census_sources(),
            receipts,
            observed_at=BASE_TIME + timedelta(minutes=1),
        )

        assert not first.run.reused_existing
        assert first.inserted_receipt_count == 2
        assert second.run.reused_existing
        assert second.reused_receipt_count == 2
        assert session.scalar(select(func.count(OrderLineageRepairRun.id))) == 1
        assert session.scalar(select(func.count(OrderLineageRepairReceipt.id))) == 2

        status = load_order_lineage_repair_status(
            session,
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
        )
        assert status["state"] == "closed"
        assert status["closed_census"] is True
        assert status["receipt_count"] == 2
        assert status["causal_complete_count"] == 0
        assert status["confidence_counts"] == {
            "ambiguous": 0,
            "exact": 1,
            "unproved": 1,
        }
        assert status["promotion_authority_eligible"] is False

        changed_receipt = replace(
            receipts[0],
            evidence_sha256="f" * 64,
        )
        with pytest.raises(ValueError, match="run_nondeterministic"):
            with session.begin_nested():
                persist_order_lineage_census(
                    session,
                    census_sources(),
                    [changed_receipt, receipts[1]],
                    observed_at=BASE_TIME + timedelta(minutes=2),
                )
        assert session.scalar(select(func.count(OrderLineageRepairRun.id))) == 1
        assert session.scalar(select(func.count(OrderLineageRepairReceipt.id))) == 2


def test_status_is_explicitly_missing_without_a_closed_run() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        status = load_order_lineage_repair_status(
            session,
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
        )

    assert status == {
        "schema_version": "torghut.order-lineage-repair-status.v1",
        "state": "missing",
        "closed_census": False,
        "current_version": False,
        "diagnostic_only": True,
        "promotion_authority_eligible": False,
        "reason_codes": ["order_lineage_closed_census_missing"],
    }
