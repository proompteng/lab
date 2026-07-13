from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, Execution, ExecutionOrderEvent
from scripts.reconcile_order_feed_coverage import project_order_feed_coverage


UTC = timezone.utc


def _engine() -> object:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return engine


def _execution(
    *,
    order_id: str,
    account_label: str = "PA3SX7FYNUTF",
    filled_qty: str = "0",
    status: str = "new",
    activity_at: datetime = datetime(2026, 7, 10, 14, 30, tzinfo=UTC),
) -> Execution:
    return Execution(
        alpaca_account_label=account_label,
        alpaca_order_id=order_id,
        client_order_id=f"client-{order_id}",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("2"),
        filled_qty=Decimal(filled_qty),
        status=status,
        raw_order={"id": order_id},
        created_at=activity_at,
        updated_at=activity_at,
        last_update_at=activity_at,
        order_feed_last_event_ts=activity_at,
    )


def _event(
    *,
    fingerprint: str,
    account_label: str = "PA3SX7FYNUTF",
    execution_id: object = None,
    event_type: str | None = "fill",
    status: str | None = "filled",
    filled_qty: str = "1",
    filled_qty_delta: str | None = "1",
    source_window_id: object = None,
    source_partition: int | None = 0,
    source_offset: int | None = 1,
    alpaca_order_id: str | None = "order-linked",
    client_order_id: str | None = "client-order-linked",
) -> ExecutionOrderEvent:
    return ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic="alpaca.trade_updates",
        source_partition=source_partition,
        source_offset=source_offset,
        alpaca_account_label=account_label,
        event_ts=datetime(2026, 7, 10, 14, 31, tzinfo=UTC),
        symbol="AAPL",
        alpaca_order_id=alpaca_order_id,
        client_order_id=client_order_id,
        event_type=event_type,
        status=status,
        filled_qty=Decimal(filled_qty),
        filled_qty_delta=(
            Decimal(filled_qty_delta) if filled_qty_delta is not None else None
        ),
        avg_fill_price=Decimal("100"),
        raw_event={"event": event_type or status or "unknown"},
        execution_id=execution_id,
        source_window_id=source_window_id,
        created_at=datetime(2026, 7, 10, 14, 31, tzinfo=UTC),
    )


class TestOrderFeedCoverageProjection(TestCase):
    def test_projection_exposes_missing_execution_fill_event_lineage(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            linked_execution = _execution(
                order_id="order-linked",
                filled_qty="1",
                status="filled",
            )
            missing_execution = _execution(
                order_id="order-missing",
                filled_qty="2",
                status="filled",
            )
            unfilled_execution = _execution(order_id="order-unfilled")
            session.add_all([linked_execution, missing_execution, unfilled_execution])
            session.flush()
            session.add_all(
                [
                    _event(
                        fingerprint="linked-fill",
                        execution_id=linked_execution.id,
                        source_window_id=linked_execution.id,
                        source_offset=10,
                    ),
                    _event(
                        fingerprint="linked-new",
                        execution_id=linked_execution.id,
                        event_type="new",
                        status="new",
                        filled_qty="0",
                        filled_qty_delta=None,
                        source_window_id=linked_execution.id,
                        source_offset=11,
                    ),
                    _event(
                        fingerprint="linked-fill-without-source-evidence",
                        execution_id=linked_execution.id,
                        source_window_id=None,
                        source_partition=None,
                        source_offset=None,
                        alpaca_order_id=None,
                        client_order_id=None,
                    ),
                    _event(
                        fingerprint="unlinked-fill",
                        event_type="partial_fill",
                        status="partially_filled",
                        filled_qty="2",
                        filled_qty_delta="1",
                        source_window_id=None,
                        source_partition=None,
                        source_offset=None,
                    ),
                ]
            )
            session.commit()

            report = project_order_feed_coverage(session, account_label="PA3SX7FYNUTF")

            self.assertEqual(
                report["population"],
                {
                    "execution_count": 3,
                    "filled_execution_count": 2,
                    "execution_with_any_event_count": 1,
                    "execution_with_fill_event_count": 1,
                    "filled_executions_missing_fill_event_count": 1,
                },
            )
            self.assertEqual(
                report["event_lineage"],
                {
                    "fill_event_count": 3,
                    "linked_fill_event_count": 2,
                    "unlinked_fill_event_count": 1,
                    "linked_fill_events_missing_source_window_count": 1,
                    "linked_fill_events_missing_source_offset_count": 1,
                    "fill_events_missing_order_identity_count": 1,
                    "positive_fill_delta_event_count": 3,
                    "positive_fill_delta_unlinked_count": 1,
                },
            )
            self.assertEqual(
                report["coverage"],
                {
                    "filled_execution_to_fill_event_ratio": "0.500000",
                    "fill_event_to_execution_ratio": "0.666667",
                },
            )
            self.assertEqual(
                report["blockers"],
                [
                    "execution_fill_event_lineage_missing",
                    "unlinked_fill_events_present",
                    "fill_events_missing_source_window",
                    "fill_events_missing_source_offset",
                    "fill_events_missing_order_identity",
                ],
            )
            self.assertEqual(
                len(report["samples"]["filled_executions_missing_fill_event"]), 1
            )
            self.assertEqual(len(report["samples"]["unlinked_fill_events"]), 1)
            self.assertEqual(report["read_only"], True)
            self.assertEqual(report["writes_performed"], False)
            self.assertEqual(report["promotion_authority_eligible"], False)

    def test_projection_scopes_account_and_window_and_does_not_mutate_rows(
        self,
    ) -> None:
        engine = _engine()
        with Session(engine) as session:
            in_window = _execution(
                order_id="order-in-window",
                filled_qty="1",
                status="filled",
                activity_at=datetime(2026, 7, 10, 15, 0, tzinfo=UTC),
            )
            outside_window = _execution(
                order_id="order-outside-window",
                filled_qty="1",
                status="filled",
                activity_at=datetime(2026, 7, 11, 15, 0, tzinfo=UTC),
            )
            other_account = _execution(
                order_id="order-other-account",
                account_label="TORGHUT_SIM",
                filled_qty="1",
                status="filled",
                activity_at=datetime(2026, 7, 10, 15, 0, tzinfo=UTC),
            )
            session.add_all([in_window, outside_window, other_account])
            session.flush()
            session.add(
                _event(
                    fingerprint="in-window-fill",
                    execution_id=in_window.id,
                    source_window_id=in_window.id,
                    source_offset=20,
                )
            )
            session.commit()

            before = (in_window.filled_qty, in_window.status, in_window.raw_order)
            report = project_order_feed_coverage(
                session,
                account_label="PA3SX7FYNUTF",
                window_start=datetime(2026, 7, 10, 14, 0, tzinfo=UTC),
                window_end=datetime(2026, 7, 10, 16, 0, tzinfo=UTC),
                sample_limit=0,
            )

            self.assertEqual(report["population"]["execution_count"], 1)
            self.assertEqual(report["population"]["filled_execution_count"], 1)
            self.assertEqual(
                report["population"]["filled_executions_missing_fill_event_count"], 0
            )
            self.assertEqual(report["event_lineage"]["fill_event_count"], 1)
            self.assertEqual(report["blockers"], [])
            self.assertEqual(report["sample_limit"], 25)
            self.assertEqual(
                (in_window.filled_qty, in_window.status, in_window.raw_order),
                before,
            )

    def test_projection_rejects_reversed_window(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            with self.assertRaisesRegex(
                ValueError, "window_end_must_be_after_window_start"
            ):
                project_order_feed_coverage(
                    session,
                    window_start=datetime(2026, 7, 11, tzinfo=UTC),
                    window_end=datetime(2026, 7, 10, tzinfo=UTC),
                )
