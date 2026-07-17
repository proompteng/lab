from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import OrderLineageRepairReceipt
from app.trading.order_lineage_receipts import (
    CLASSIFICATION_AMBIGUOUS,
    CLASSIFICATION_BROKER_ACTIVITY_ONLY,
    CLASSIFICATION_COMPLETE,
    CLASSIFICATION_EXTERNAL_OR_UNPROVED,
    CLASSIFICATION_LINKED_INCOMPLETE,
    CLASSIFICATION_ORDER_FEED_ONLY,
    CONFIDENCE_AMBIGUOUS,
    CONFIDENCE_EXACT,
    CONFIDENCE_UNPROVED,
    EXECUTION_SOURCE_CROSS_DSN,
    EXECUTION_SOURCE_NONE,
    MATCH_BASIS_ALPACA_ORDER_ID,
    MATCH_BASIS_CLIENT_ORDER_ID,
    OrderLineageEvidence,
    build_order_lineage_receipt,
    persist_order_lineage_receipt,
)


BASE_TIME = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)
ORDER_EVENT_A = uuid.UUID("00000000-0000-0000-0000-000000000001")
ORDER_EVENT_B = uuid.UUID("00000000-0000-0000-0000-000000000002")
BROKER_FILL_A = uuid.UUID("00000000-0000-0000-0000-000000000011")
BROKER_FILL_B = uuid.UUID("00000000-0000-0000-0000-000000000012")
EXECUTION_ID = uuid.UUID("00000000-0000-0000-0000-000000000021")
DECISION_ID = uuid.UUID("00000000-0000-0000-0000-000000000022")
STRATEGY_ID = uuid.UUID("00000000-0000-0000-0000-000000000023")
CLAIM_ID = DECISION_ID
TCA_ID = uuid.UUID("00000000-0000-0000-0000-000000000024")


def linked_incomplete_evidence() -> OrderLineageEvidence:
    return OrderLineageEvidence(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        alpaca_order_id="broker-order",
        client_order_id="decision-hash",
        classification=CLASSIFICATION_LINKED_INCOMPLETE,
        confidence=CONFIDENCE_EXACT,
        execution_source=EXECUTION_SOURCE_CROSS_DSN,
        canonical_execution_id=EXECUTION_ID,
        canonical_trade_decision_id=DECISION_ID,
        canonical_strategy_id=STRATEGY_ID,
        canonical_tca_metric_id=TCA_ID,
        order_event_ids=(ORDER_EVENT_B, ORDER_EVENT_A),
        fill_order_event_ids=(ORDER_EVENT_B,),
        broker_activity_ids=(BROKER_FILL_B, BROKER_FILL_A),
        broker_fill_activity_ids=(BROKER_FILL_B, BROKER_FILL_A),
        source_first_at=BASE_TIME,
        source_last_at=BASE_TIME + timedelta(seconds=2),
        match_basis=(MATCH_BASIS_CLIENT_ORDER_ID, MATCH_BASIS_ALPACA_ORDER_ID),
        blockers=("submission_claim_missing",),
    )


def test_receipt_is_deterministic_and_preserves_one_to_many_evidence() -> None:
    evidence = linked_incomplete_evidence()
    first = build_order_lineage_receipt(evidence)
    second = build_order_lineage_receipt(
        replace(
            evidence,
            order_event_ids=(ORDER_EVENT_A, ORDER_EVENT_B, ORDER_EVENT_A),
            broker_activity_ids=(BROKER_FILL_A, BROKER_FILL_B, BROKER_FILL_A),
            broker_fill_activity_ids=(BROKER_FILL_A, BROKER_FILL_B),
            match_basis=(MATCH_BASIS_ALPACA_ORDER_ID, MATCH_BASIS_CLIENT_ORDER_ID),
        )
    )

    assert first.evidence_sha256 == second.evidence_sha256
    assert first.order_identity_sha256 == second.order_identity_sha256
    assert first.evidence["promotion_authority_eligible"] is False
    assert first.evidence["sources"] == {
        "broker_activity_ids": [str(BROKER_FILL_A), str(BROKER_FILL_B)],
        "broker_fill_activity_ids": [str(BROKER_FILL_A), str(BROKER_FILL_B)],
        "counts": {
            "broker_activities": 2,
            "broker_fills": 2,
            "fill_order_events": 1,
            "order_events": 2,
        },
        "fill_order_event_ids": [str(ORDER_EVENT_B)],
        "first_at": BASE_TIME.isoformat(),
        "last_at": (BASE_TIME + timedelta(seconds=2)).isoformat(),
        "order_event_ids": [str(ORDER_EVENT_A), str(ORDER_EVENT_B)],
    }


def test_broker_order_identity_does_not_change_when_client_id_arrives() -> None:
    evidence = linked_incomplete_evidence()
    broker_only = build_order_lineage_receipt(
        replace(
            evidence, client_order_id=None, match_basis=(MATCH_BASIS_ALPACA_ORDER_ID,)
        )
    )
    both_ids = build_order_lineage_receipt(evidence)

    assert broker_only.order_identity_sha256 == both_ids.order_identity_sha256
    assert broker_only.evidence_sha256 != both_ids.evidence_sha256
    assert both_ids.evidence["order_identity"] == {
        "account_label": "paper-account",
        "alpaca_order_id": "broker-order",
        "client_order_id": "decision-hash",
        "environment": "paper",
        "primary_order_id": "broker-order",
        "primary_order_id_kind": MATCH_BASIS_ALPACA_ORDER_ID,
        "provider": "alpaca",
        "sha256": both_ids.order_identity_sha256,
    }


def test_complete_receipt_requires_every_causal_link_and_no_blockers() -> None:
    complete = replace(
        linked_incomplete_evidence(),
        classification=CLASSIFICATION_COMPLETE,
        canonical_submission_claim_id=CLAIM_ID,
        blockers=(),
    )
    draft = build_order_lineage_receipt(complete)
    assert draft.classification == CLASSIFICATION_COMPLETE

    with pytest.raises(ValueError, match="complete_evidence_incomplete"):
        build_order_lineage_receipt(
            replace(complete, canonical_submission_claim_id=None)
        )
    with pytest.raises(ValueError, match="complete_evidence_incomplete"):
        build_order_lineage_receipt(replace(complete, blockers=("stale",)))
    with pytest.raises(ValueError, match="complete_evidence_incomplete"):
        build_order_lineage_receipt(replace(complete, fill_order_event_ids=()))
    with pytest.raises(ValueError, match="submission_claim_identity_inconsistent"):
        build_order_lineage_receipt(
            replace(complete, canonical_submission_claim_id=uuid.uuid4())
        )


def test_ambiguous_receipt_cannot_claim_an_execution() -> None:
    ambiguous = OrderLineageEvidence(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        alpaca_order_id="broker-order",
        client_order_id=None,
        classification=CLASSIFICATION_AMBIGUOUS,
        confidence=CONFIDENCE_AMBIGUOUS,
        execution_source=EXECUTION_SOURCE_NONE,
        order_event_ids=(ORDER_EVENT_A,),
        source_first_at=BASE_TIME,
        source_last_at=BASE_TIME,
        match_basis=(MATCH_BASIS_ALPACA_ORDER_ID,),
        blockers=("ambiguous_execution_identity",),
    )
    draft = build_order_lineage_receipt(ambiguous)
    assert draft.evidence["links"]["execution_id"] is None
    assert draft.promotion_authority_eligible is False

    with pytest.raises(ValueError, match="execution_identity_inconsistent"):
        build_order_lineage_receipt(
            replace(ambiguous, canonical_execution_id=EXECUTION_ID)
        )


def test_source_subsets_and_timezone_fail_closed() -> None:
    evidence = linked_incomplete_evidence()
    with pytest.raises(ValueError, match="fill_event_not_in_order_events"):
        build_order_lineage_receipt(
            replace(evidence, fill_order_event_ids=(uuid.uuid4(),))
        )
    with pytest.raises(ValueError, match="timestamp_timezone_missing"):
        build_order_lineage_receipt(
            replace(evidence, source_first_at=BASE_TIME.replace(tzinfo=None))
        )


@pytest.mark.parametrize(
    ("classification", "order_event_ids", "broker_activity_ids"),
    [
        (CLASSIFICATION_EXTERNAL_OR_UNPROVED, (ORDER_EVENT_A,), (BROKER_FILL_A,)),
        (CLASSIFICATION_BROKER_ACTIVITY_ONLY, (), (BROKER_FILL_A,)),
        (CLASSIFICATION_ORDER_FEED_ONLY, (ORDER_EVENT_A,), ()),
    ],
)
def test_unproved_classifications_require_their_declared_sources(
    classification: str,
    order_event_ids: tuple[uuid.UUID, ...],
    broker_activity_ids: tuple[uuid.UUID, ...],
) -> None:
    evidence = OrderLineageEvidence(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        alpaca_order_id="broker-order",
        client_order_id=None,
        classification=classification,
        confidence=CONFIDENCE_UNPROVED,
        execution_source=EXECUTION_SOURCE_NONE,
        order_event_ids=order_event_ids,
        broker_activity_ids=broker_activity_ids,
        broker_fill_activity_ids=broker_activity_ids,
        source_first_at=BASE_TIME,
        source_last_at=BASE_TIME,
        blockers=("canonical_execution_unproved",),
    )
    assert build_order_lineage_receipt(evidence).classification == classification
    with pytest.raises(ValueError, match="incomplete_blockers_missing"):
        build_order_lineage_receipt(replace(evidence, blockers=()))

    invalid_broker_activity_ids = (
        (BROKER_FILL_A,) if classification == CLASSIFICATION_ORDER_FEED_ONLY else ()
    )
    with pytest.raises(ValueError, match="sources_invalid"):
        build_order_lineage_receipt(
            replace(
                evidence,
                order_event_ids=(ORDER_EVENT_A,),
                broker_activity_ids=invalid_broker_activity_ids,
                broker_fill_activity_ids=invalid_broker_activity_ids,
            )
        )


@pytest.mark.parametrize(
    ("classification", "order_event_ids", "broker_activity_ids"),
    [
        (CLASSIFICATION_BROKER_ACTIVITY_ONLY, (), (BROKER_FILL_A,)),
        (CLASSIFICATION_ORDER_FEED_ONLY, (ORDER_EVENT_A,), ()),
    ],
)
def test_source_gaps_preserve_exact_execution_links(
    classification: str,
    order_event_ids: tuple[uuid.UUID, ...],
    broker_activity_ids: tuple[uuid.UUID, ...],
) -> None:
    draft = build_order_lineage_receipt(
        OrderLineageEvidence(
            provider="alpaca",
            environment="paper",
            account_label="paper-account",
            alpaca_order_id="broker-order",
            client_order_id="decision-hash",
            classification=classification,
            confidence=CONFIDENCE_EXACT,
            execution_source=EXECUTION_SOURCE_CROSS_DSN,
            canonical_execution_id=EXECUTION_ID,
            canonical_trade_decision_id=DECISION_ID,
            canonical_strategy_id=STRATEGY_ID,
            canonical_tca_metric_id=TCA_ID,
            order_event_ids=order_event_ids,
            broker_activity_ids=broker_activity_ids,
            broker_fill_activity_ids=broker_activity_ids,
            source_first_at=BASE_TIME,
            source_last_at=BASE_TIME,
            match_basis=(MATCH_BASIS_ALPACA_ORDER_ID,),
            blockers=("source_gap",),
        )
    )

    assert draft.evidence["links"] == {
        "execution_id": str(EXECUTION_ID),
        "strategy_id": str(STRATEGY_ID),
        "submission_claim_id": None,
        "tca_metric_id": str(TCA_ID),
        "trade_decision_id": str(DECISION_ID),
    }


def test_persistence_reuses_exact_receipt_and_appends_changed_evidence() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    OrderLineageRepairReceipt.__table__.create(engine)
    first_draft = build_order_lineage_receipt(linked_incomplete_evidence())
    second_draft = build_order_lineage_receipt(
        replace(
            linked_incomplete_evidence(),
            order_event_ids=(ORDER_EVENT_A, ORDER_EVENT_B, uuid.uuid4()),
            source_last_at=BASE_TIME + timedelta(seconds=3),
        )
    )

    with Session(engine) as session, session.begin():
        first = persist_order_lineage_receipt(
            session,
            first_draft,
            observed_at=BASE_TIME + timedelta(minutes=1),
        )
        duplicate = persist_order_lineage_receipt(
            session,
            first_draft,
            observed_at=BASE_TIME + timedelta(minutes=2),
        )
        changed = persist_order_lineage_receipt(
            session,
            second_draft,
            observed_at=BASE_TIME + timedelta(minutes=3),
        )

        assert not first.reused_existing
        assert duplicate.reused_existing
        assert duplicate.receipt.id == first.receipt.id
        assert not changed.reused_existing
        assert changed.receipt.id != first.receipt.id
        assert session.scalar(select(func.count(OrderLineageRepairReceipt.id))) == 2
