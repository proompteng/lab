from __future__ import annotations

import io
import json
import os
import sys
import uuid
from argparse import ArgumentTypeError, Namespace
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, Execution, ExecutionOrderEvent, Strategy, TradeDecision
from scripts import reconcile_order_feed_coverage as coverage_script
from scripts.reconcile_order_feed_coverage import project_order_feed_coverage


UTC = timezone.utc
TRADE_DECISION_ID = uuid.UUID("00000000-0000-0000-0000-000000000777")


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
    filled_qty: str | None = "1",
    filled_qty_delta: str | None = "1",
    source_window_id: object = None,
    source_partition: int | None = 0,
    source_offset: int | None = 1,
    alpaca_order_id: str | None = "order-linked",
    client_order_id: str | None = "client-order-linked",
    trade_decision_id: object = TRADE_DECISION_ID,
    fill_quantity_basis: str | None = "delta",
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
        filled_qty=(Decimal(filled_qty) if filled_qty is not None else None),
        filled_qty_delta=(
            Decimal(filled_qty_delta) if filled_qty_delta is not None else None
        ),
        fill_quantity_basis=fill_quantity_basis,
        avg_fill_price=Decimal("100"),
        raw_event={"event": event_type or status or "unknown"},
        execution_id=execution_id,
        trade_decision_id=trade_decision_id,
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
                        fingerprint="linked-fill-without-trade-decision",
                        execution_id=linked_execution.id,
                        trade_decision_id=None,
                        source_window_id=linked_execution.id,
                        source_offset=12,
                    ),
                    _event(
                        fingerprint="unlinked-fill",
                        event_type="partial_fill",
                        status="partially_filled",
                        filled_qty="2",
                        filled_qty_delta="1",
                        alpaca_order_id="unlinked-order",
                        client_order_id="unlinked-client",
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
                    "fill_event_count": 4,
                    "linked_fill_event_count": 3,
                    "unlinked_fill_event_count": 1,
                    "linked_fill_events_missing_source_window_count": 1,
                    "linked_fill_events_missing_source_offset_count": 1,
                    "fill_events_missing_order_identity_count": 1,
                    "linked_fill_events_missing_trade_decision_count": 1,
                    "linked_fill_events_missing_delta_basis_count": 0,
                    "linked_fill_events_missing_delta_count": 0,
                    "positive_fill_delta_event_count": 4,
                    "positive_fill_delta_unlinked_count": 1,
                },
            )
            self.assertEqual(
                report["coverage"],
                {
                    "filled_execution_to_fill_event_ratio": "0.500000",
                    "fill_event_to_execution_ratio": "0.750000",
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
                    "fill_events_missing_trade_decision",
                ],
            )
            self.assertEqual(
                len(report["samples"]["filled_executions_missing_fill_event"]), 1
            )
            self.assertEqual(len(report["samples"]["unlinked_fill_events"]), 1)
            self.assertEqual(report["read_only"], True)
            self.assertEqual(report["writes_performed"], False)
            self.assertEqual(report["promotion_authority_eligible"], False)

    def test_blank_order_identity_is_blocked(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            session.add(
                _event(
                    fingerprint="blank-order-identity",
                    alpaca_order_id="",
                    client_order_id="   ",
                    execution_id=None,
                )
            )
            session.commit()

            report = project_order_feed_coverage(session)

            self.assertEqual(
                report["event_lineage"]["fill_events_missing_order_identity_count"],
                1,
            )
            self.assertIn("fill_events_missing_order_identity", report["blockers"])

    def test_linked_fill_events_missing_delta_proof_are_blocked(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            execution = _execution(
                order_id="delta-proof-execution",
                filled_qty="2",
                status="filled",
            )
            session.add(execution)
            session.flush()
            session.add_all(
                [
                    _event(
                        fingerprint="missing-delta-basis",
                        execution_id=execution.id,
                        source_window_id=execution.id,
                        source_offset=10,
                        fill_quantity_basis=None,
                    ),
                    _event(
                        fingerprint="missing-delta",
                        execution_id=execution.id,
                        source_window_id=execution.id,
                        source_offset=11,
                        filled_qty_delta=None,
                    ),
                    _event(
                        fingerprint="accepted-delta-basis-alias",
                        execution_id=execution.id,
                        source_window_id=execution.id,
                        source_offset=12,
                        fill_quantity_basis="cum_to_delta",
                    ),
                ]
            )
            session.commit()

            report = project_order_feed_coverage(session)

            self.assertEqual(
                report["event_lineage"]["linked_fill_events_missing_delta_basis_count"],
                1,
            )
            self.assertEqual(
                report["event_lineage"]["linked_fill_events_missing_delta_count"],
                1,
            )
            self.assertEqual(
                report["blockers"][-2:],
                [
                    "order_feed_fill_delta_basis_missing",
                    "order_feed_fill_delta_missing",
                ],
            )

    def test_trade_decision_fallbacks_match_runtime_resolution(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            linked_execution = _execution(
                order_id="decision-fallback-execution",
                filled_qty="1",
                status="filled",
            )
            linked_execution.trade_decision_id = TRADE_DECISION_ID
            client_execution = _execution(
                order_id="decision-client-fallback-execution",
                filled_qty="1",
                status="filled",
            )
            session.add_all([linked_execution, client_execution])
            strategy = Strategy(
                name="coverage-test-strategy",
                base_timeframe="1Min",
                universe_type="static",
            )
            client_decision = TradeDecision(
                strategy=strategy,
                alpaca_account_label="PA3SX7FYNUTF",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "buy"},
                decision_hash="client-decision-fallback",
            )
            session.add(client_decision)
            session.flush()
            session.add_all(
                [
                    _event(
                        fingerprint="decision-from-execution",
                        execution_id=linked_execution.id,
                        trade_decision_id=None,
                        source_window_id=linked_execution.id,
                        source_offset=20,
                    ),
                    _event(
                        fingerprint="decision-from-client-order",
                        execution_id=client_execution.id,
                        trade_decision_id=None,
                        client_order_id="client-decision-fallback",
                        source_window_id=client_execution.id,
                        source_offset=21,
                    ),
                ]
            )
            session.commit()

            report = project_order_feed_coverage(session)

            self.assertEqual(
                report["event_lineage"][
                    "linked_fill_events_missing_trade_decision_count"
                ],
                0,
            )
            self.assertNotIn("fill_events_missing_trade_decision", report["blockers"])

    def test_order_identity_fallback_links_unique_execution(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            execution = _execution(
                order_id="order-id-fallback",
                filled_qty="1",
                status="filled",
            )
            session.add(execution)
            session.flush()
            session.add(
                _event(
                    fingerprint="order-id-fallback-fill",
                    execution_id=None,
                    alpaca_order_id=execution.alpaca_order_id,
                    client_order_id=None,
                    source_window_id=execution.id,
                    source_offset=30,
                )
            )
            session.commit()

            report = project_order_feed_coverage(session)

            self.assertEqual(report["population"]["execution_with_fill_event_count"], 1)
            self.assertEqual(
                report["population"]["filled_executions_missing_fill_event_count"],
                0,
            )
            self.assertEqual(report["event_lineage"]["linked_fill_event_count"], 1)
            self.assertEqual(report["event_lineage"]["unlinked_fill_event_count"], 0)
            self.assertNotIn("unlinked_fill_events_present", report["blockers"])

    def test_execution_window_uses_updated_at_and_reports_sample_activity(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            execution = _execution(
                order_id="updated-at-only",
                filled_qty="2",
                status="filled",
                activity_at=datetime(2026, 7, 9, 15, 0, tzinfo=UTC),
            )
            execution.order_feed_last_event_ts = None
            execution.last_update_at = None
            execution.updated_at = datetime(2026, 7, 10, 15, 0, tzinfo=UTC)
            session.add(execution)
            session.commit()

            report = project_order_feed_coverage(
                session,
                window_start=datetime(2026, 7, 10, 14, 0, tzinfo=UTC),
                window_end=datetime(2026, 7, 10, 16, 0, tzinfo=UTC),
            )

            self.assertEqual(report["population"]["execution_count"], 1)
            self.assertEqual(
                report["samples"]["filled_executions_missing_fill_event"][0][
                    "activity_at"
                ],
                "2026-07-10T15:00:00+00:00",
            )

    def test_filled_qty_only_event_is_fill_activity(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            session.add(
                _event(
                    fingerprint="cumulative-filled-qty",
                    event_type="status",
                    status="new",
                    filled_qty="1",
                    filled_qty_delta=None,
                    execution_id=None,
                )
            )
            session.commit()

            report = project_order_feed_coverage(session)

            self.assertEqual(report["event_lineage"]["fill_event_count"], 1)
            self.assertEqual(report["event_lineage"]["unlinked_fill_event_count"], 1)
            self.assertIn("unlinked_fill_events_present", report["blockers"])

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

    def test_helper_parsers_and_bounds_fail_closed(self) -> None:
        self.assertEqual(
            coverage_script._sqlalchemy_dsn("postgres://user:pass@db/torghut"),
            "postgresql+psycopg://user:pass@db/torghut",
        )
        self.assertEqual(
            coverage_script._sqlalchemy_dsn("postgresql://user:pass@db/torghut"),
            "postgresql+psycopg://user:pass@db/torghut",
        )
        self.assertEqual(
            coverage_script._sqlalchemy_dsn("postgresql+psycopg://db/torghut"),
            "postgresql+psycopg://db/torghut",
        )
        self.assertEqual(
            coverage_script._sqlalchemy_dsn("sqlite+pysqlite:///:memory:"),
            "sqlite+pysqlite:///:memory:",
        )
        self.assertEqual(
            coverage_script._parse_datetime("2026-07-10T14:30:00Z").isoformat(),
            "2026-07-10T14:30:00+00:00",
        )
        self.assertEqual(
            coverage_script._parse_datetime("2026-07-10T14:30:00").isoformat(),
            "2026-07-10T14:30:00+00:00",
        )
        with self.assertRaisesRegex(ArgumentTypeError, "datetime cannot be empty"):
            coverage_script._parse_datetime(" ")
        with self.assertRaisesRegex(ArgumentTypeError, "invalid datetime"):
            coverage_script._parse_datetime("not-a-date")
        with self.assertRaisesRegex(ValueError, "limit must be an integer"):
            coverage_script._bounded_limit("not-an-int")
        self.assertEqual(coverage_script._bounded_limit(0, default=25), 25)
        self.assertEqual(coverage_script._bounded_limit(6000), 5000)
        self.assertEqual(coverage_script._bounded_limit(-1), 1)
        self.assertIsNone(coverage_script._ratio(0, 0))
        self.assertIsNone(coverage_script._iso(None))
        self.assertIsNone(coverage_script._decimal_text(None))

    def test_projection_serializes_null_event_fields_and_empty_coverage(self) -> None:
        engine = _engine()
        with Session(engine) as session:
            session.add(
                _event(
                    fingerprint="null-unlinked-fill",
                    event_type="fill",
                    status="filled",
                    filled_qty=None,
                    filled_qty_delta=None,
                    source_window_id=None,
                    source_partition=None,
                    source_offset=None,
                    alpaca_order_id=None,
                    client_order_id=None,
                )
            )
            session.commit()

            report = project_order_feed_coverage(session, sample_limit=-1)
            sample = report["samples"]["unlinked_fill_events"][0]

            self.assertEqual(report["population"]["execution_count"], 0)
            self.assertEqual(report["event_lineage"]["fill_event_count"], 1)
            self.assertIsNone(
                report["coverage"]["filled_execution_to_fill_event_ratio"]
            )
            self.assertEqual(report["sample_limit"], 1)
            self.assertIsNone(sample["filled_qty"])
            self.assertIsNone(sample["filled_qty_delta"])
            self.assertIsNone(sample["execution_id"])
            self.assertIsNone(sample["source_window_id"])

    def test_parse_args_covers_read_only_cli_flags(self) -> None:
        with patch.object(
            sys,
            "argv",
            [
                "reconcile_order_feed_coverage.py",
                "--dsn-env",
                "TEST_DSN",
                "--account-label",
                "PA3SX7FYNUTF",
                "--window-start",
                "2026-07-10T14:00:00Z",
                "--window-end",
                "2026-07-10T15:00:00Z",
                "--sample-limit",
                "7",
                "--fail-on-blockers",
                "--json",
            ],
        ):
            args = coverage_script._parse_args()

        self.assertEqual(args.dsn_env, "TEST_DSN")
        self.assertEqual(args.account_label, "PA3SX7FYNUTF")
        self.assertEqual(args.sample_limit, 7)
        self.assertTrue(args.fail_on_blockers)
        self.assertTrue(args.json)
        self.assertEqual(args.window_start.isoformat(), "2026-07-10T14:00:00+00:00")
        self.assertEqual(args.window_end.isoformat(), "2026-07-10T15:00:00+00:00")

    def test_run_report_reads_dsn_rolls_back_and_rejects_missing_dsn(self) -> None:
        fake_session = MagicMock()
        fake_session.__enter__.return_value = fake_session
        fake_session.__exit__.return_value = None
        fake_factory = MagicMock(return_value=fake_session)
        args = Namespace(
            dsn_env="TEST_DSN",
            account_label="PA3SX7FYNUTF",
            window_start=None,
            window_end=None,
            sample_limit=5,
        )
        expected = {"blockers": [], "read_only": True}
        with (
            patch.dict(os.environ, {"TEST_DSN": "postgresql://example/torghut"}),
            patch.object(
                coverage_script, "create_engine", return_value=object()
            ) as create_engine,
            patch.object(coverage_script, "sessionmaker", return_value=fake_factory),
            patch.object(
                coverage_script,
                "project_order_feed_coverage",
                return_value=expected,
            ) as project,
        ):
            self.assertEqual(coverage_script.run_report(args), expected)

        create_engine.assert_called_once_with(
            "postgresql+psycopg://example/torghut",
            pool_pre_ping=True,
            future=True,
        )
        project.assert_called_once_with(
            fake_session,
            account_label="PA3SX7FYNUTF",
            window_start=None,
            window_end=None,
            sample_limit=5,
        )
        fake_session.rollback.assert_called_once_with()

        with (
            patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(SystemExit, "missing DSN env var: MISSING_DSN"),
        ):
            coverage_script.run_report(
                Namespace(
                    dsn_env="MISSING_DSN",
                    account_label=None,
                    window_start=None,
                    window_end=None,
                    sample_limit=25,
                )
            )

    def test_main_emits_compact_and_pretty_json_and_fail_code(self) -> None:
        compact_args = Namespace(json=True, fail_on_blockers=False)
        compact_report = {"blockers": [], "read_only": True}
        compact_stdout = io.StringIO()
        with (
            patch.object(coverage_script, "_parse_args", return_value=compact_args),
            patch.object(coverage_script, "run_report", return_value=compact_report),
            patch("sys.stdout", compact_stdout),
        ):
            self.assertEqual(coverage_script.main(), 0)
        self.assertEqual(json.loads(compact_stdout.getvalue()), compact_report)

        pretty_args = Namespace(json=False, fail_on_blockers=True)
        pretty_report = {"blockers": ["unlinked_fill_events_present"]}
        pretty_stdout = io.StringIO()
        with (
            patch.object(coverage_script, "_parse_args", return_value=pretty_args),
            patch.object(coverage_script, "run_report", return_value=pretty_report),
            patch("sys.stdout", pretty_stdout),
        ):
            self.assertEqual(coverage_script.main(), 1)
        self.assertIn("\n", pretty_stdout.getvalue())
        self.assertEqual(json.loads(pretty_stdout.getvalue()), pretty_report)
