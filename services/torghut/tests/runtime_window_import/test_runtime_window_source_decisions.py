from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Base,
    Decimal,
    Mapping,
    POST_COST_BASIS_RUNTIME_LEDGER,
    RuntimeWindowImportTestCaseBase,
    StaticPool,
    StrategyRuntimeLedgerBucket,
    _SourceLedgerConnection,
    _SourceLedgerCursor,
    _complete_runtime_ledger_bucket,
    _first_bool,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_rows_from_durable_buckets,
    _runtime_ledger_tca_rows_from_source_dsn,
    _source_decision_mode,
    _source_decision_mode_counts,
    _source_decision_rows_profit_proof_eligible,
    _source_row_matches_lineage,
    _source_runtime_ledger_payload_from_row,
    cast,
    create_engine,
    datetime,
    patch,
    sessionmaker,
    timezone,
)


class TestRuntimeWindowImportSourceDecisions(RuntimeWindowImportTestCaseBase):
    def test_runtime_ledger_profit_proof_rejects_modeled_cost_basis(
        self,
    ) -> None:
        for overrides in (
            {"cost_basis": "modeled_paper_cost_budget"},
            {"cost_basis_counts": {"modeled_paper_cost_budget": 1}},
            {"cost_basis_counts": {"decision_impact_assumptions_total_cost_bps": 2}},
        ):
            with self.subTest(overrides=overrides):
                self.assertFalse(
                    _runtime_ledger_bucket_profit_proof_present(
                        _complete_runtime_ledger_bucket(**overrides)
                    )
                )

    def test_runtime_ledger_profit_proof_rejects_route_acquisition_source_mode(
        self,
    ) -> None:
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    source_decision_mode_counts={"route_acquisition_probe": 2}
                )
            )
        )
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    source_decision_mode="route_acquisition_probe"
                )
            )
        )
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(profit_proof_eligible=False)
            )
        )
        self.assertTrue(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    source_decision_mode_counts={"strategy_signal_paper": 2}
                )
            )
        )

    def test_source_decision_helpers_normalize_counts_and_profit_proof_flags(
        self,
    ) -> None:
        self.assertTrue(
            _first_bool(
                {"profit_proof_eligible": Decimal("1")}, "profit_proof_eligible"
            )
        )
        self.assertTrue(
            _first_bool({"profit_proof_eligible": "yes"}, "profit_proof_eligible")
        )
        self.assertFalse(
            _first_bool({"profit_proof_eligible": "blocked"}, "profit_proof_eligible")
        )
        self.assertEqual(
            _source_decision_mode(
                {"source_decision_mode": "paper-route-target-plan-source-decision"}
            ),
            "route_acquisition_probe",
        )
        self.assertEqual(
            _source_decision_mode({"mode": "strategy_signal_paper"}),
            "strategy_signal_paper",
        )
        self.assertIsNone(
            _source_decision_mode(
                {
                    "decision_json": {
                        "params": {"strategy_runtime": {"mode": "scheduler_v3"}}
                    }
                }
            )
        )
        self.assertEqual(
            _source_decision_mode_counts(
                [
                    {"source_decision_mode": "route_acquisition_probe"},
                    {"mode": "strategy_signal_paper"},
                    {"source_decision_mode": ""},
                ]
            ),
            {"route_acquisition_probe": 1, "strategy_signal_paper": 1},
        )
        self.assertFalse(
            _source_decision_rows_profit_proof_eligible(
                [{"source_decision_mode": "route_acquisition_probe"}]
            )
        )
        self.assertFalse(
            _source_decision_rows_profit_proof_eligible(
                [{"profit_proof_eligible": "failed"}]
            )
        )
        self.assertTrue(
            _source_decision_rows_profit_proof_eligible(
                [
                    {
                        "source_decision_mode": "strategy_signal_paper",
                        "profit_proof_eligible": True,
                    }
                ]
            )
        )

    def test_source_decision_helpers_prefer_strategy_signal_over_nested_probe(
        self,
    ) -> None:
        row = {
            "decision_json": {
                "params": {
                    "paper_route_probe": {
                        "source_decision_mode": "route_acquisition_probe",
                        "profit_proof_eligible": False,
                    }
                },
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
                "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                "source_hypothesis_ids": ["H-PAIRS-01"],
                "strategy_signal_paper": {
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                },
            }
        }

        self.assertEqual(_source_decision_mode(row), "strategy_signal_paper")
        self.assertEqual(
            _source_decision_mode_counts([row]),
            {"strategy_signal_paper": 1},
        )
        self.assertTrue(_source_decision_rows_profit_proof_eligible([row]))
        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_source_decision_helpers_prefer_params_signal_over_nested_probe(
        self,
    ) -> None:
        row = {
            "decision_json": {
                "params": {
                    "strategy_runtime": {"mode": "scheduler_v3"},
                    "paper_route_probe": {
                        "source_decision_mode": "route_acquisition_probe",
                        "profit_proof_eligible": False,
                    },
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                    "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                    "source_hypothesis_ids": ["H-PAIRS-01"],
                    "strategy_signal_paper": {
                        "source_decision_mode": "strategy_signal_paper",
                        "profit_proof_eligible": True,
                    },
                }
            }
        }

        self.assertEqual(_source_decision_mode(row), "strategy_signal_paper")
        self.assertEqual(
            _source_decision_mode_counts([row]),
            {"strategy_signal_paper": 1},
        )
        self.assertTrue(_source_decision_rows_profit_proof_eligible([row]))
        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_source_decision_helpers_prefer_current_target_source_over_legacy_probe(
        self,
    ) -> None:
        row = {
            "decision_json": {
                "paper_route_target_plan": {
                    "source_decision_mode": "route_acquisition_probe",
                    "profit_proof_eligible": False,
                },
                "params": {
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                    "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                    "source_hypothesis_ids": ["H-PAIRS-01"],
                    "paper_route_target_plan_source_decision": {
                        "source_decision_mode": "bounded_paper_route_collection",
                        "profit_proof_eligible": True,
                    },
                },
            }
        }

        self.assertEqual(_source_decision_mode(row), "bounded_paper_route_collection")
        self.assertEqual(
            _source_decision_mode_counts([row]),
            {"bounded_paper_route_collection": 1},
        )
        self.assertTrue(_source_decision_rows_profit_proof_eligible([row]))
        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_runtime_ledger_tca_rows_from_durable_buckets_queries_matching_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-proof-1",
                    candidate_id="H-TSMOM-LIQ-01",
                    hypothesis_id="H-TSMOM-LIQ-01",
                    observed_stage="paper",
                    bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="intraday-tsmom-profit-v3",
                    strategy_family="intraday_tsmom_consistent",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("200"),
                    gross_strategy_pnl=Decimal("1"),
                    cost_amount=Decimal("0.20"),
                    net_strategy_pnl_after_costs=Decimal("0.80"),
                    post_cost_expectancy_bps=Decimal("40"),
                    ledger_schema_version="torghut.exact_replay_ledger.v1",
                    pnl_basis=POST_COST_BASIS_RUNTIME_LEDGER,
                    execution_policy_hash_counts={"policy-sha": 2},
                    cost_model_hash_counts={"cost-sha": 2},
                    lineage_hash_counts={"lineage-sha": 2},
                    blockers_json=[],
                    payload_json={
                        "source_decision_mode_counts": {"strategy_signal_paper": 2},
                        "cost_basis_counts": {"broker_reported": 2},
                        "source_window_start": "2026-03-06T14:30:00+00:00",
                        "source_window_end": "2026-03-06T15:00:00+00:00",
                        "source_refs": [
                            "postgres:trade_decisions",
                            "postgres:executions",
                            "postgres:execution_order_events",
                            "postgres:order_feed_source_windows",
                        ],
                        "source_row_counts": {
                            "trade_decisions": 2,
                            "executions": 2,
                            "execution_order_events": 4,
                            "order_feed_source_windows": 4,
                        },
                        "source_window_ids": [
                            "source-window-new-buy",
                            "source-window-fill-buy",
                            "source-window-new-sell",
                            "source-window-fill-sell",
                        ],
                        "trade_decision_ids": ["decision-buy", "decision-sell"],
                        "execution_ids": ["execution-buy", "execution-sell"],
                        "execution_order_event_ids": [
                            "event-new-buy",
                            "event-fill-buy",
                            "event-new-sell",
                            "event-fill-sell",
                        ],
                        "source_offsets": [
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 100,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 101,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 102,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 103,
                            },
                        ],
                        "source_materialization": "execution_order_events",
                        "authority_class": "runtime_order_feed_execution_source",
                        "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                        "profit_proof_eligible": True,
                    },
                )
            )
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-proof-other",
                    candidate_id="other-candidate",
                    hypothesis_id="H-TSMOM-LIQ-01",
                    observed_stage="paper",
                    bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    runtime_strategy_name="intraday-tsmom-profit-v3",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("200"),
                    gross_strategy_pnl=Decimal("1"),
                    cost_amount=Decimal("0.20"),
                    net_strategy_pnl_after_costs=Decimal("0.80"),
                    post_cost_expectancy_bps=Decimal("40"),
                    ledger_schema_version="torghut.exact_replay_ledger.v1",
                    pnl_basis=POST_COST_BASIS_RUNTIME_LEDGER,
                )
            )
            session.commit()

            rows, metadata = _runtime_ledger_tca_rows_from_durable_buckets(
                session=session,
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_durable_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_durable_bucket_run_ids"],
            ["runtime-proof-1"],
        )
        self.assertEqual(metadata["runtime_ledger_durable_bucket_fill_count"], 2)
        self.assertEqual(
            metadata["runtime_ledger_durable_bucket_profit_proof_count"],
            1,
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["run_id"], "runtime-proof-1")
        self.assertEqual(bucket["closed_trade_count"], 1)

    def test_runtime_ledger_tca_rows_from_durable_buckets_block_aggregate_only_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-aggregate-only",
                    candidate_id="H-TSMOM-LIQ-01",
                    hypothesis_id="H-TSMOM-LIQ-01",
                    observed_stage="paper",
                    bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="intraday-tsmom-profit-v3",
                    strategy_family="intraday_tsmom_consistent",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("200"),
                    gross_strategy_pnl=Decimal("1"),
                    cost_amount=Decimal("0.20"),
                    net_strategy_pnl_after_costs=Decimal("0.80"),
                    post_cost_expectancy_bps=Decimal("40"),
                    ledger_schema_version="torghut.exact_replay_ledger.v1",
                    pnl_basis=POST_COST_BASIS_RUNTIME_LEDGER,
                    execution_policy_hash_counts={"policy-sha": 2},
                    cost_model_hash_counts={"cost-sha": 2},
                    lineage_hash_counts={"lineage-sha": 2},
                    blockers_json=[],
                    payload_json={
                        "source_decision_mode_counts": {"strategy_signal_paper": 2},
                        "source_window_start": "2026-03-06T14:30:00+00:00",
                        "source_window_end": "2026-03-06T15:00:00+00:00",
                        "source_refs": [],
                        "source_row_counts": {},
                        "profit_proof_eligible": True,
                    },
                )
            )
            session.commit()

            rows, metadata = _runtime_ledger_tca_rows_from_durable_buckets(
                session=session,
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_durable_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_durable_bucket_profit_proof_count"],
            0,
        )
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing",
            metadata["runtime_ledger_durable_bucket_profit_proof_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            metadata["runtime_ledger_durable_bucket_profit_proof_blockers"],
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertIn(
            "runtime_ledger_authority_class_missing",
            rows[0]["runtime_ledger_blockers"],
        )

    def test_runtime_ledger_tca_rows_from_source_dsn_queries_matching_proof(
        self,
    ) -> None:
        cursor = _SourceLedgerCursor()
        connection = _SourceLedgerConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            rows, metadata = _runtime_ledger_tca_rows_from_source_dsn(
                dsn="postgresql://source",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_source_bucket_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_ids"],
            ["source-runtime-ledger-bucket-1"],
        )
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_refs"],
            ["postgres:strategy_runtime_ledger_buckets:source-runtime-ledger-bucket-1"],
        )
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_run_ids"],
            ["runtime-proof-source"],
        )
        self.assertEqual(metadata["runtime_ledger_source_bucket_fill_count"], 2)
        self.assertEqual(metadata["runtime_ledger_source_bucket_profit_proof_count"], 1)
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_profit_proof_blockers"],
            [],
        )
        self.assertEqual(
            metadata["runtime_ledger_source_bucket_candidate_id"],
            "H-TSMOM-LIQ-01",
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], True)
        self.assertEqual(
            rows[0]["post_cost_expectancy_basis"],
            POST_COST_BASIS_RUNTIME_LEDGER,
        )
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertEqual(bucket["run_id"], "runtime-proof-source")
        self.assertEqual(
            bucket["source_runtime_ledger_bucket_id"],
            "source-runtime-ledger-bucket-1",
        )
        self.assertIn(
            "postgres:strategy_runtime_ledger_buckets:source-runtime-ledger-bucket-1",
            bucket["source_refs"],
        )
        self.assertEqual(
            bucket["source_row_counts"]["strategy_runtime_ledger_buckets"],
            1,
        )
        self.assertEqual(
            bucket["cost_basis_counts"], {"broker_reported_commission_and_fees": 2}
        )
        self.assertEqual(
            bucket["source_decision_mode_counts"], {"strategy_signal_paper": 2}
        )
        self.assertEqual(bucket["profit_proof_eligible"], True)
        self.assertEqual(bucket["bucket_started_at"], "2026-03-06T14:30:00+00:00")
        query, params = cursor.executed[0]
        self.assertIn("from strategy_runtime_ledger_buckets", query)
        self.assertIn("runtime_strategy_name = any(%s)", query)
        self.assertEqual(
            params,
            (
                "H-TSMOM-LIQ-01",
                "paper",
                window_end,
                window_start,
                "H-TSMOM-LIQ-01",
                "TORGHUT_SIM",
                ["intraday-tsmom-profit-v3"],
            ),
        )

    def test_source_runtime_ledger_payload_drops_recursive_payload_json(self) -> None:
        cursor = _SourceLedgerCursor()
        row = list(cursor._results[0][0])
        payload_json = dict(cast(Mapping[str, object], row[-1]))
        payload_json["payload_json"] = {"stale_nested_payload": True}
        row[-1] = payload_json

        payload = _source_runtime_ledger_payload_from_row(tuple(row))

        self.assertNotIn("payload_json", payload)
        self.assertEqual(payload["run_id"], "runtime-proof-source")
        self.assertEqual(
            payload["source_runtime_ledger_bucket_id"],
            "source-runtime-ledger-bucket-1",
        )
        self.assertEqual(
            payload["source_runtime_ledger_bucket_ref"],
            "postgres:strategy_runtime_ledger_buckets:source-runtime-ledger-bucket-1",
        )
        self.assertIn(
            "postgres:strategy_runtime_ledger_buckets:source-runtime-ledger-bucket-1",
            payload["source_refs"],
        )
        self.assertEqual(
            cast(Mapping[str, object], payload["source_row_counts"])[
                "strategy_runtime_ledger_buckets"
            ],
            1,
        )
        self.assertEqual(
            payload["source_decision_mode_counts"],
            {"strategy_signal_paper": 2},
        )
        self.assertEqual(payload["bucket_started_at"], "2026-03-06T14:30:00+00:00")

    def test_runtime_ledger_tca_rows_from_source_dsn_block_aggregate_only_proof(
        self,
    ) -> None:
        cursor = _SourceLedgerCursor()
        row = list(cursor._results[0][0])
        payload = dict(cast(Mapping[str, object], row[-1]))
        payload.update(
            {
                "source_window_ids": [],
                "trade_decision_ids": [],
                "execution_ids": [],
                "execution_order_event_ids": [],
                "source_offsets": [],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
            }
        )
        row[-1] = payload
        cursor._results[0] = [tuple(row)]
        connection = _SourceLedgerConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            rows, metadata = _runtime_ledger_tca_rows_from_source_dsn(
                dsn="postgresql://source",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_source_bucket_profit_proof_count"], 0)
        self.assertIn(
            "runtime_ledger_trade_decision_refs_missing",
            metadata["runtime_ledger_source_bucket_profit_proof_blockers"],
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing",
            rows[0]["runtime_ledger_blockers"],
        )
