from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from app.trading.order_lineage_census import (
    BrokerActivityFact,
    ExecutionLineageFact,
    OrderEventFact,
    OrderLineageCensusEvidence,
    build_order_lineage_census,
)
from app.trading.order_lineage_receipts import (
    CLASSIFICATION_AMBIGUOUS,
    CLASSIFICATION_COMPLETE,
    CLASSIFICATION_EXTERNAL_OR_UNPROVED,
    CLASSIFICATION_LINKED_INCOMPLETE,
    CLASSIFICATION_ORDER_FEED_ONLY,
    EXECUTION_SOURCE_CROSS_DSN,
    EXECUTION_SOURCE_LOCAL,
)


BASE_TIME = datetime(2026, 7, 17, 1, 0, tzinfo=timezone.utc)
EXECUTION_ID = uuid.UUID(int=101)
DECISION_ID = uuid.UUID(int=102)
STRATEGY_ID = uuid.UUID(int=103)
CLAIM_ID = DECISION_ID
TCA_ID = uuid.UUID(int=104)


def event(
    identity: int,
    *,
    broker_order_id: str | None = "broker-order",
    client_order_id: str | None = "decision-hash",
    is_fill: bool = False,
    execution_id: uuid.UUID | None = None,
) -> OrderEventFact:
    return OrderEventFact(
        id=uuid.UUID(int=identity),
        event_fingerprint=f"{identity:064x}",
        broker_order_id=broker_order_id,
        client_order_id=client_order_id,
        event_at=BASE_TIME + timedelta(seconds=identity),
        is_fill=is_fill,
        execution_id=execution_id,
        trade_decision_id=None,
        source_topic="torghut.alpaca.trade_updates.v1",
        source_partition=0,
        source_offset=identity,
    )


def activity(
    identity: int,
    *,
    broker_order_id: str | None = "broker-order",
    client_order_id: str | None = None,
    activity_type: str = "FILL",
) -> BrokerActivityFact:
    return BrokerActivityFact(
        id=uuid.UUID(int=identity),
        external_activity_id=f"activity-{identity}",
        activity_type=activity_type,
        broker_order_id=broker_order_id,
        client_order_id=client_order_id,
        event_at=BASE_TIME + timedelta(seconds=identity),
    )


def execution(
    identity: uuid.UUID = EXECUTION_ID,
    *,
    source: str = EXECUTION_SOURCE_CROSS_DSN,
    broker_order_id: str = "broker-order",
    client_order_id: str | None = "decision-hash",
    decision_id: uuid.UUID | None = DECISION_ID,
    strategy_id: uuid.UUID | None = STRATEGY_ID,
    claim_id: uuid.UUID | None = CLAIM_ID,
    tca_id: uuid.UUID | None = TCA_ID,
) -> ExecutionLineageFact:
    return ExecutionLineageFact(
        source=source,
        execution_id=identity,
        broker_order_id=broker_order_id,
        client_order_id=client_order_id,
        idempotency_key=client_order_id,
        trade_decision_id=decision_id,
        strategy_id=strategy_id,
        submission_claim_id=claim_id,
        tca_metric_id=tca_id,
        updated_at=BASE_TIME,
    )


def census(
    *,
    events: tuple[OrderEventFact, ...],
    activities: tuple[BrokerActivityFact, ...],
    local_executions: tuple[ExecutionLineageFact, ...] = (),
    canonical_executions: tuple[ExecutionLineageFact, ...] = (),
) -> OrderLineageCensusEvidence:
    return OrderLineageCensusEvidence(
        provider="alpaca",
        environment="paper",
        account_label="paper-account",
        canonical_account_label_sha256="a" * 64,
        order_events=events,
        broker_activities=activities,
        local_executions=local_executions,
        canonical_executions=canonical_executions,
    )


def test_complete_receipt_preserves_partial_fills_and_is_deterministic() -> None:
    events = (event(1), event(2, is_fill=True))
    activities = (activity(11), activity(12))
    candidate = execution()
    first = build_order_lineage_census(
        census(
            events=events,
            activities=activities,
            canonical_executions=(candidate,),
        )
    )
    second = build_order_lineage_census(
        census(
            events=tuple(reversed(events)),
            activities=tuple(reversed(activities)),
            canonical_executions=(candidate,),
        )
    )

    assert len(first.receipts) == 1
    receipt = first.receipts[0]
    assert receipt.classification == CLASSIFICATION_COMPLETE
    assert receipt.evidence_sha256 == second.receipts[0].evidence_sha256
    assert first.order_feed_manifest == second.order_feed_manifest
    assert first.broker_order_link_manifest == second.broker_order_link_manifest
    assert receipt.evidence["sources"] == {
        "broker_activity_ids": [str(activities[0].id), str(activities[1].id)],
        "broker_fill_activity_ids": [
            str(activities[0].id),
            str(activities[1].id),
        ],
        "counts": {
            "broker_activities": 2,
            "broker_fills": 2,
            "fill_order_events": 1,
            "order_events": 2,
        },
        "fill_order_event_ids": [str(events[1].id)],
        "first_at": events[0].event_at.isoformat(),
        "last_at": activities[1].event_at.isoformat(),
        "order_event_ids": [str(events[0].id), str(events[1].id)],
    }


def test_direct_local_execution_wins_over_cross_dsn_match() -> None:
    local = execution(source=EXECUTION_SOURCE_LOCAL)
    canonical = execution(identity=uuid.UUID(int=201))
    result = build_order_lineage_census(
        census(
            events=(event(1, is_fill=True, execution_id=EXECUTION_ID),),
            activities=(activity(11),),
            local_executions=(local,),
            canonical_executions=(canonical,),
        )
    )

    receipt = result.receipts[0]
    assert receipt.execution_source == EXECUTION_SOURCE_LOCAL
    assert receipt.evidence["links"] == {
        "execution_id": str(EXECUTION_ID),
        "strategy_id": str(STRATEGY_ID),
        "submission_claim_id": str(CLAIM_ID),
        "tca_metric_id": str(TCA_ID),
        "trade_decision_id": str(DECISION_ID),
    }


def test_order_feed_only_receipt_keeps_exact_execution() -> None:
    result = build_order_lineage_census(
        census(
            events=(event(1, is_fill=True),),
            activities=(),
            canonical_executions=(execution(),),
        )
    )

    receipt = result.receipts[0]
    assert receipt.classification == CLASSIFICATION_ORDER_FEED_ONLY
    assert receipt.execution_source == EXECUTION_SOURCE_CROSS_DSN
    assert receipt.evidence["blockers"] == [
        "broker_activity_missing",
        "broker_fill_activity_missing",
    ]


def test_ambiguous_and_unproved_orders_never_select_a_winner() -> None:
    source = census(
        events=(event(1, is_fill=True),),
        activities=(activity(11),),
        canonical_executions=(execution(), execution(identity=uuid.UUID(int=202))),
    )
    ambiguous = build_order_lineage_census(source).receipts[0]
    unproved = build_order_lineage_census(
        replace(source, canonical_executions=())
    ).receipts[0]

    assert ambiguous.classification == CLASSIFICATION_AMBIGUOUS
    assert ambiguous.execution_source == "none"
    assert ambiguous.evidence["links"] == {
        "execution_id": None,
        "strategy_id": None,
        "submission_claim_id": None,
        "tca_metric_id": None,
        "trade_decision_id": None,
    }
    assert unproved.classification == CLASSIFICATION_EXTERNAL_OR_UNPROVED
    assert unproved.execution_source == "none"


def test_client_only_event_is_joined_to_later_broker_identity() -> None:
    result = build_order_lineage_census(
        census(
            events=(
                event(
                    1,
                    broker_order_id=None,
                    client_order_id="decision-hash",
                    is_fill=True,
                ),
            ),
            activities=(
                activity(
                    11,
                    broker_order_id="broker-order",
                    client_order_id="decision-hash",
                ),
            ),
            canonical_executions=(execution(),),
        )
    )

    assert len(result.receipts) == 1
    assert result.receipts[0].alpaca_order_id == "broker-order"
    assert result.receipts[0].classification == CLASSIFICATION_COMPLETE


def test_missing_claim_stays_linked_but_incomplete() -> None:
    result = build_order_lineage_census(
        census(
            events=(event(1, is_fill=True),),
            activities=(activity(11),),
            canonical_executions=(execution(claim_id=None),),
        )
    )

    receipt = result.receipts[0]
    assert receipt.classification == CLASSIFICATION_LINKED_INCOMPLETE
    assert receipt.evidence["blockers"] == ["submission_claim_missing"]


def test_conflicting_direct_execution_ids_fail_closed_as_ambiguous() -> None:
    first = execution(source=EXECUTION_SOURCE_LOCAL)
    second = execution(identity=uuid.UUID(int=202), source=EXECUTION_SOURCE_LOCAL)
    result = build_order_lineage_census(
        census(
            events=(
                event(1, execution_id=first.execution_id),
                event(2, is_fill=True, execution_id=second.execution_id),
            ),
            activities=(activity(11),),
            local_executions=(first, second),
        )
    )

    receipt = result.receipts[0]
    assert receipt.classification == CLASSIFICATION_AMBIGUOUS
    assert receipt.evidence["blockers"] == ["direct_execution_identity_inconsistent"]


def test_direct_execution_id_can_resolve_in_canonical_database() -> None:
    candidate = execution()
    result = build_order_lineage_census(
        census(
            events=(event(1, is_fill=True, execution_id=candidate.execution_id),),
            activities=(activity(11),),
            canonical_executions=(candidate,),
        )
    )

    receipt = result.receipts[0]
    assert receipt.classification == CLASSIFICATION_COMPLETE
    assert receipt.execution_source == EXECUTION_SOURCE_CROSS_DSN


def test_client_only_source_with_multiple_broker_aliases_is_ambiguous() -> None:
    result = build_order_lineage_census(
        census(
            events=(
                event(
                    1,
                    broker_order_id=None,
                    client_order_id="reused-client-id",
                    is_fill=True,
                ),
            ),
            activities=(
                activity(
                    11,
                    broker_order_id="broker-order-1",
                    client_order_id="reused-client-id",
                ),
                activity(
                    12,
                    broker_order_id="broker-order-2",
                    client_order_id="reused-client-id",
                ),
            ),
        )
    )

    client_only = next(
        receipt for receipt in result.receipts if receipt.alpaca_order_id is None
    )
    assert client_only.classification == CLASSIFICATION_AMBIGUOUS
    assert client_only.evidence["blockers"] == [
        "broker_activity_missing",
        "broker_fill_activity_missing",
        "client_order_alias_ambiguous",
    ]
