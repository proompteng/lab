from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.repair_order_feed_source_windows_script.support import (
    Decimal,
    Execution,
    ExecutionOrderEvent,
    OrderFeedSourceWindow,
    Session,
    Strategy,
    TestCase,
    TradeDecision,
    _FakeSession,
    _FakeSessionFactory,
    _seed_canonical_execution,
    _seed_live_source_window,
    _sqlite_model_engine,
    cross_dsn_script,
    datetime,
    io,
    json,
    os,
    patch,
    select,
    sys,
    timedelta,
    timezone,
    uuid,
)


class TestCrossDsnOrderFeedReconciliationScript(TestCase):
    def test_cross_dsn_parse_datetime_dsn_and_helper_edges(self) -> None:
        with patch.object(
            sys,
            "argv",
            [
                "reconcile_cross_dsn_order_feed_links.py",
                "--source-account-label",
                "PA3SX7FYNUTF",
                "--canonical-account-label",
                "TORGHUT_SIM",
                "--window-start",
                "2026-06-11T13:30:00Z",
                "--window-end",
                "2026-06-11T20:10:00Z",
            ],
        ):
            args = cross_dsn_script._parse_args()

        self.assertEqual(args.event_dsn_env, "DB_DSN")
        self.assertEqual(args.canonical_dsn_env, "SIM_DB_DSN")
        self.assertEqual(args.limit, 5000)
        with self.assertRaisesRegex(SystemExit, "empty_datetime"):
            cross_dsn_script._parse_dt(" ")
        self.assertEqual(
            cross_dsn_script._parse_dt("2026-06-11T13:30:00").isoformat(),
            "2026-06-11T13:30:00+00:00",
        )
        self.assertEqual(
            cross_dsn_script._sqlalchemy_dsn("postgres://example/live"),
            "postgresql+psycopg://example/live",
        )
        self.assertEqual(
            cross_dsn_script._sqlalchemy_dsn("postgresql://example/sim"),
            "postgresql+psycopg://example/sim",
        )
        self.assertEqual(
            cross_dsn_script._sqlalchemy_dsn("sqlite+pysqlite:///:memory:"),
            "sqlite+pysqlite:///:memory:",
        )

        engine = _sqlite_model_engine()
        with Session(engine) as session:
            _, execution, _ = _seed_canonical_execution(
                session,
                order_id="duplicate-order",
                client_order_id="duplicate-client",
            )
            session.commit()
            self.assertEqual(
                cross_dsn_script._unique_executions([execution, execution]),
                [execution],
            )
            event_without_identity = ExecutionOrderEvent(
                event_fingerprint="no-order-identity",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="PA3SX7FYNUTF",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )
            self.assertEqual(
                cross_dsn_script._canonical_execution_matches(
                    session,
                    event_without_identity,
                    canonical_account_label="TORGHUT_SIM",
                ),
                [],
            )
            self.assertEqual(
                cross_dsn_script._event_raw_payload(
                    ExecutionOrderEvent(
                        event_fingerprint="raw-list-event",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=2,
                        alpaca_account_label="PA3SX7FYNUTF",
                        symbol="AMZN",
                        raw_event=["raw-list"],
                    )
                ),
                {"raw_event": ["raw-list"]},
            )

    def test_cross_dsn_decision_fallback_handles_missing_no_match_and_single(
        self,
    ) -> None:
        engine = _sqlite_model_engine()
        with Session(engine) as session:
            strategy = Strategy(
                name="decision-fallback",
                description="decision fallback",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AMZN"],
            )
            session.add(strategy)
            session.flush()
            decisions = [
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AMZN",
                    timeframe="1Min",
                    decision_json={"side": "buy"},
                    decision_hash="single-client",
                    status="submitted",
                ),
            ]
            session.add_all(decisions)
            session.flush()
            execution = Execution(
                trade_decision_id=None,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="fallback-order",
                client_order_id="fallback-client",
                symbol="AMZN",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="new",
                raw_order={"id": "fallback-order"},
                last_update_at=datetime(2026, 6, 11, 14, 30, tzinfo=timezone.utc),
            )
            session.add(execution)
            session.flush()
            event_without_client = ExecutionOrderEvent(
                event_fingerprint="fallback-no-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="PA3SX7FYNUTF",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )
            event_with_missing_client = ExecutionOrderEvent(
                event_fingerprint="fallback-missing-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=2,
                alpaca_account_label="PA3SX7FYNUTF",
                client_order_id="missing-client",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )
            event_with_single_client = ExecutionOrderEvent(
                event_fingerprint="fallback-single-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=3,
                alpaca_account_label="PA3SX7FYNUTF",
                client_order_id="single-client",
                symbol="AMZN",
                raw_event={"event": "fill"},
            )

            self.assertIsNone(
                cross_dsn_script._canonical_decision_id(
                    session,
                    event_without_client,
                    execution,
                    canonical_account_label="TORGHUT_SIM",
                )
            )
            self.assertIsNone(
                cross_dsn_script._canonical_decision_id(
                    session,
                    event_with_missing_client,
                    execution,
                    canonical_account_label="TORGHUT_SIM",
                )
            )
            self.assertEqual(
                cross_dsn_script._canonical_decision_id(
                    session,
                    event_with_single_client,
                    execution,
                    canonical_account_label="TORGHUT_SIM",
                ),
                decisions[-1].id,
            )

    def test_cross_dsn_source_window_marking_handles_missing_and_empty_counts(
        self,
    ) -> None:
        event_engine = _sqlite_model_engine()
        linked_at = datetime(2026, 6, 11, 21, 0, tzinfo=timezone.utc)

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=1)
            source_window.payload_json = ["not-a-mapping"]
            source_window.classification_counts = {
                "cross_dsn_execution_ref_count": 7,
            }
            event_session.commit()
            source_window_id = source_window.id

        with Session(event_engine) as event_session:
            marked = cross_dsn_script._mark_source_windows(
                event_session,
                source_window_ids={uuid.uuid4(), source_window_id},
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                canonical_execution_ids=set(),
                canonical_trade_decision_ids=set(),
                canonical_tca_ids=set(),
                linked_at=linked_at,
            )
            event_session.commit()
            source_window = event_session.get(OrderFeedSourceWindow, source_window_id)

        self.assertEqual(marked, 1)
        assert source_window is not None
        self.assertEqual(
            source_window.payload_json["cross_dsn_execution_ref_count"],
            0,
        )
        self.assertNotIn(
            "cross_dsn_execution_ref_count",
            source_window.classification_counts,
        )
        self.assertEqual(
            source_window.payload_json["_torghut_cross_dsn_linkage"][
                "canonical_execution_ids"
            ],
            [],
        )

    def test_dry_run_and_apply_cross_dsn_refs_without_live_fks(self) -> None:
        event_engine = _sqlite_model_engine()
        canonical_engine = _sqlite_model_engine()
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc)
        linked_at = datetime(2026, 6, 11, 21, 0, tzinfo=timezone.utc)

        with Session(canonical_engine) as canonical_session:
            for index in range(4):
                _seed_canonical_execution(
                    canonical_session,
                    order_id=f"sim-order-{index}",
                    client_order_id=f"sim-client-{index}",
                )
            canonical_session.commit()

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=16)
            for order_index in range(4):
                for event_index in range(4):
                    offset = 10_000 + (order_index * 4) + event_index
                    event_session.add(
                        ExecutionOrderEvent(
                            event_fingerprint=f"live-event-{order_index}-{event_index}",
                            source_topic="torghut.trade-updates.v1",
                            source_partition=0,
                            source_offset=offset,
                            alpaca_account_label="PA3SX7FYNUTF",
                            event_ts=window_start
                            + timedelta(minutes=order_index, seconds=event_index),
                            symbol="AMZN",
                            alpaca_order_id=f"sim-order-{order_index}",
                            client_order_id=f"sim-client-{order_index}",
                            event_type="fill",
                            status="filled",
                            qty=Decimal("1"),
                            filled_qty=Decimal("1"),
                            avg_fill_price=Decimal("100"),
                            raw_event={"event": "fill", "source_offset": offset},
                            source_window_id=source_window.id,
                        )
                    )
            event_session.commit()

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            dry_run = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=False,
                now=linked_at,
            )
            first_event = event_session.scalars(
                select(ExecutionOrderEvent).order_by(ExecutionOrderEvent.source_offset)
            ).first()

        self.assertEqual(dry_run["selected"], 16)
        self.assertEqual(dry_run["events_matched"], 16)
        self.assertEqual(dry_run["canonical_executions_matched"], 4)
        self.assertEqual(dry_run["canonical_trade_decisions_matched"], 4)
        self.assertEqual(dry_run["canonical_tca_matched"], 4)
        self.assertEqual(dry_run["events_ambiguous"], 0)
        self.assertEqual(dry_run["events_marked"], 0)
        assert first_event is not None
        self.assertNotIn("_torghut_cross_dsn_linkage", first_event.raw_event)

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            applied = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=True,
                now=linked_at,
            )
            event_session.commit()

        self.assertEqual(applied["selected"], 16)
        self.assertEqual(applied["events_matched"], 16)
        self.assertEqual(applied["events_marked"], 16)
        self.assertEqual(applied["source_windows_marked"], 1)
        self.assertEqual(applied["canonical_executions_matched"], 4)
        self.assertEqual(applied["canonical_trade_decisions_matched"], 4)
        self.assertEqual(applied["canonical_tca_matched"], 4)

        with Session(event_engine) as event_session:
            events = list(
                event_session.scalars(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.source_offset
                    )
                )
            )
            source_window = event_session.scalar(select(OrderFeedSourceWindow))

        self.assertEqual(len(events), 16)
        for event in events:
            self.assertIsNone(event.execution_id)
            self.assertIsNone(event.trade_decision_id)
            linkage = event.raw_event["_torghut_cross_dsn_linkage"]
            self.assertEqual(linkage["source_dsn_env"], "DB_DSN")
            self.assertEqual(linkage["canonical_dsn_env"], "SIM_DB_DSN")
            self.assertEqual(linkage["canonical_account_label"], "TORGHUT_SIM")
            self.assertFalse(linkage["promotion_authority_eligible"])
            self.assertTrue(linkage["canonical_execution_id"])
            self.assertTrue(linkage["canonical_trade_decision_id"])
            self.assertTrue(linkage["canonical_execution_tca_metric_id"])
        assert source_window is not None
        self.assertEqual(source_window.unlinked_execution_count, 16)
        self.assertEqual(source_window.unlinked_decision_count, 16)
        self.assertEqual(
            source_window.payload_json["cross_dsn_execution_ref_count"], 16
        )
        self.assertEqual(
            source_window.payload_json["cross_dsn_trade_decision_ref_count"],
            16,
        )
        self.assertEqual(source_window.payload_json["cross_dsn_tca_ref_count"], 16)
        self.assertEqual(
            source_window.classification_counts["cross_dsn_execution_ref_count"],
            16,
        )
        self.assertEqual(
            len(
                source_window.payload_json["_torghut_cross_dsn_linkage"][
                    "canonical_execution_ids"
                ]
            ),
            4,
        )

    def test_ambiguous_order_identity_fails_closed(self) -> None:
        event_engine = _sqlite_model_engine()
        canonical_engine = _sqlite_model_engine()
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc)

        with Session(canonical_engine) as canonical_session:
            _seed_canonical_execution(
                canonical_session,
                order_id="ambiguous-order",
                client_order_id="first-client",
            )
            _seed_canonical_execution(
                canonical_session,
                order_id="second-order",
                client_order_id="second-client",
                execution_idempotency_key="ambiguous-client",
            )
            canonical_session.commit()

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=1)
            event_session.add(
                ExecutionOrderEvent(
                    event_fingerprint="live-ambiguous-event",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=10_000,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=window_start + timedelta(minutes=1),
                    symbol="AMZN",
                    alpaca_order_id="ambiguous-order",
                    client_order_id="ambiguous-client",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    raw_event={"event": "fill"},
                    source_window_id=source_window.id,
                )
            )
            event_session.commit()

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            result = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=True,
                now=window_end,
            )
            event_session.commit()

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["events_matched"], 0)
        self.assertEqual(result["events_ambiguous"], 1)
        self.assertEqual(result["events_marked"], 0)
        self.assertEqual(result["source_windows_marked"], 0)
        self.assertFalse(result["promotion_authority_eligible"])

        with Session(event_engine) as event_session:
            event = event_session.scalar(select(ExecutionOrderEvent))
            source_window = event_session.scalar(select(OrderFeedSourceWindow))

        assert event is not None
        self.assertIsNone(event.execution_id)
        self.assertIsNone(event.trade_decision_id)
        self.assertNotIn("_torghut_cross_dsn_linkage", event.raw_event)
        assert source_window is not None
        self.assertNotIn("_torghut_cross_dsn_linkage", source_window.payload_json)

    def test_unmatched_and_missing_tca_are_reported_without_live_fks(self) -> None:
        event_engine = _sqlite_model_engine()
        canonical_engine = _sqlite_model_engine()
        window_start = datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc)

        with Session(canonical_engine) as canonical_session:
            _, _, metric = _seed_canonical_execution(
                canonical_session,
                order_id="matched-without-tca",
                client_order_id="matched-client",
            )
            canonical_session.delete(metric)
            canonical_session.commit()

        with Session(event_engine) as event_session:
            source_window = _seed_live_source_window(event_session, event_count=2)
            for offset, order_id, client_order_id in (
                (10_000, "matched-without-tca", "matched-client"),
                (10_001, "missing-canonical-order", "missing-client"),
            ):
                event_session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"live-{order_id}",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=offset,
                        alpaca_account_label="PA3SX7FYNUTF",
                        event_ts=window_start + timedelta(minutes=1),
                        symbol="AMZN",
                        alpaca_order_id=order_id,
                        client_order_id=client_order_id,
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("100"),
                        raw_event={"event": "fill"},
                        source_window_id=source_window.id,
                    )
                )
            event_session.commit()

        with (
            Session(event_engine) as event_session,
            Session(canonical_engine) as canonical_session,
        ):
            result = cross_dsn_script.reconcile_cross_dsn_order_feed_links(
                event_session,
                canonical_session,
                event_dsn_env="DB_DSN",
                canonical_dsn_env="SIM_DB_DSN",
                source_account_label="PA3SX7FYNUTF",
                canonical_account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
                apply=True,
                now=window_end,
            )
            event_session.commit()

        self.assertEqual(result["selected"], 2)
        self.assertEqual(result["events_matched"], 1)
        self.assertEqual(result["events_unmatched"], 1)
        self.assertEqual(result["canonical_tca_matched"], 0)
        self.assertEqual(result["canonical_tca_missing"], 1)
        self.assertEqual(
            result["unmatched_order_identities"][0]["alpaca_order_id"],
            "missing-canonical-order",
        )

    def test_cross_dsn_main_rejects_missing_envs_and_invalid_window(self) -> None:
        base_argv = [
            "reconcile_cross_dsn_order_feed_links.py",
            "--event-dsn-env",
            "EVENT_DSN",
            "--canonical-dsn-env",
            "CANONICAL_DSN",
            "--source-account-label",
            "PA3SX7FYNUTF",
            "--canonical-account-label",
            "TORGHUT_SIM",
            "--window-start",
            "2026-06-11T20:10:00Z",
            "--window-end",
            "2026-06-11T13:30:00Z",
        ]
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(sys, "argv", base_argv),
        ):
            with self.assertRaisesRegex(SystemExit, "missing DSN env var: EVENT_DSN"):
                cross_dsn_script.main()
        with (
            patch.dict(
                os.environ, {"EVENT_DSN": "postgres://example/live"}, clear=True
            ),
            patch.object(sys, "argv", base_argv),
        ):
            with self.assertRaisesRegex(
                SystemExit,
                "missing DSN env var: CANONICAL_DSN",
            ):
                cross_dsn_script.main()
        with (
            patch.dict(
                os.environ,
                {
                    "EVENT_DSN": "postgres://example/live",
                    "CANONICAL_DSN": "postgresql://example/sim",
                },
                clear=True,
            ),
            patch.object(sys, "argv", base_argv),
            patch.object(cross_dsn_script, "create_engine") as create_engine,
        ):
            with self.assertRaisesRegex(
                SystemExit,
                "window_end_must_be_after_window_start",
            ):
                cross_dsn_script.main()

        create_engine.assert_not_called()

    def test_cross_dsn_main_transaction_and_output_modes(self) -> None:
        def run_main(
            *,
            argv: list[str],
            event_session: _FakeSession,
            canonical_session: _FakeSession,
            reconcile_payload: dict[str, object],
        ) -> tuple[int, str]:
            stdout = io.StringIO()
            with (
                patch.dict(
                    os.environ,
                    {
                        "EVENT_DSN": "postgres://example/live",
                        "CANONICAL_DSN": "postgresql://example/sim",
                    },
                    clear=True,
                ),
                patch.object(sys, "argv", argv),
                patch.object(
                    cross_dsn_script,
                    "create_engine",
                    return_value=object(),
                ),
                patch.object(
                    cross_dsn_script,
                    "sessionmaker",
                    side_effect=[
                        _FakeSessionFactory(event_session),
                        _FakeSessionFactory(canonical_session),
                    ],
                ),
                patch.object(
                    cross_dsn_script,
                    "reconcile_cross_dsn_order_feed_links",
                    return_value=reconcile_payload,
                ),
                patch("sys.stdout", stdout),
            ):
                exit_code = cross_dsn_script.main()
            return exit_code, stdout.getvalue()

        base_argv = [
            "reconcile_cross_dsn_order_feed_links.py",
            "--event-dsn-env",
            "EVENT_DSN",
            "--canonical-dsn-env",
            "CANONICAL_DSN",
            "--source-account-label",
            "PA3SX7FYNUTF",
            "--canonical-account-label",
            "TORGHUT_SIM",
            "--window-start",
            "2026-06-11T13:30:00Z",
            "--window-end",
            "2026-06-11T20:10:00Z",
            "--limit",
            "6000",
        ]
        dry_event_session = _FakeSession()
        dry_canonical_session = _FakeSession()
        dry_code, dry_output = run_main(
            argv=base_argv,
            event_session=dry_event_session,
            canonical_session=dry_canonical_session,
            reconcile_payload={"status": "ok", "apply": False},
        )

        self.assertEqual(dry_code, 0)
        self.assertEqual(json.loads(dry_output)["apply"], False)
        self.assertIn("\n  ", dry_output)
        self.assertEqual(dry_event_session.commits, 0)
        self.assertEqual(dry_event_session.rollbacks, 1)
        self.assertEqual(dry_canonical_session.rollbacks, 1)

        apply_event_session = _FakeSession()
        apply_canonical_session = _FakeSession()
        apply_code, apply_output = run_main(
            argv=[*base_argv, "--apply", "--json"],
            event_session=apply_event_session,
            canonical_session=apply_canonical_session,
            reconcile_payload={"status": "ok", "apply": True},
        )

        self.assertEqual(apply_code, 0)
        self.assertEqual(json.loads(apply_output)["apply"], True)
        self.assertNotIn("\n  ", apply_output)
        self.assertEqual(apply_event_session.commits, 1)
        self.assertEqual(apply_event_session.rollbacks, 0)
        self.assertEqual(apply_canonical_session.rollbacks, 1)
