from __future__ import annotations


from tests.submission_council.support import (
    Base,
    Decimal,
    Mapping,
    SimpleNamespace,
    StaticPool,
    StrategyRuntimeLedgerBucket,
    SubmissionCouncilTestCase,
    _bounded_source_collection_probe_window,
    _load_runtime_ledger_repair_candidates,
    _runtime_ledger_aggregate_candidate_payloads,
    _runtime_ledger_latest_payloads_per_symbol,
    _runtime_ledger_merge_count_maps,
    _runtime_ledger_paper_probation_candidates,
    _runtime_ledger_paper_probation_import_plan,
    _runtime_ledger_repair_reason_codes,
    _runtime_ledger_repair_score,
    _runtime_ledger_source_collection_candidates,
    _runtime_ledger_source_collection_target_progress_payload,
    _runtime_ledger_unique_sequence,
    build_live_submission_gate_payload,
    cast,
    create_engine,
    datetime,
    patch,
    sessionmaker,
    settings,
    timedelta,
    timezone,
)


class TestSubmissionCouncilSourceCollectionCandidates(SubmissionCouncilTestCase):
    def test_runtime_ledger_candidate_aggregation_helpers_fail_closed(self) -> None:
        self.assertEqual(
            _runtime_ledger_latest_payloads_per_symbol(
                [
                    {"symbol": "AAPL", "marker": "newest-aapl"},
                    {"symbol": "AAPL", "marker": "older-aapl"},
                ]
            ),
            [{"symbol": "AAPL", "marker": "newest-aapl"}],
        )
        self.assertEqual(
            _runtime_ledger_latest_payloads_per_symbol(
                [
                    {"symbol": "AAPL", "marker": "symbol-bucket"},
                    {"marker": "portfolio-bucket"},
                ]
            ),
            [{"marker": "portfolio-bucket"}],
        )
        self.assertEqual(
            _runtime_ledger_merge_count_maps(
                [
                    {"counts": "not-a-map"},
                    {"counts": {"": 3, "zero": 0, "policy": "2"}},
                ],
                "counts",
            ),
            {"policy": 2},
        )
        self.assertEqual(
            _runtime_ledger_unique_sequence(
                [
                    {"items": "not-a-sequence"},
                    {
                        "items": [
                            {"topic": "fills", "offset": 1},
                            {"topic": "fills", "offset": 1},
                        ]
                    },
                    {"items": [{"topic": "fills", "offset": 2}]},
                ],
                "items",
            ),
            [{"topic": "fills", "offset": 1}, {"topic": "fills", "offset": 2}],
        )
        self.assertEqual(_runtime_ledger_aggregate_candidate_payloads([]), {})

    def test_runtime_ledger_repair_candidates_aggregate_same_window_symbol_buckets(
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
        window_start = datetime(2026, 6, 5, 15, 13, 23, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 5, 20, 6, tzinfo=timezone.utc)
        registry_items = [
            {
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                "strategy_family": "microbar_cross_sectional_pairs",
                "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            }
        ]

        with session_local() as session:
            session.add_all(
                [
                    StrategyRuntimeLedgerBucket(
                        run_id="hpairs-friday-window",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-cross-sectional-pairs-v1",
                        strategy_family="microbar_cross_sectional_pairs",
                        fill_count=16,
                        decision_count=4,
                        submitted_order_count=8,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=13,
                        open_position_count=0,
                        filled_notional=Decimal("149316.19255257"),
                        gross_strategy_pnl=Decimal("-742.50905543"),
                        cost_amount=Decimal("9.76"),
                        net_strategy_pnl_after_costs=Decimal("-752.26905543"),
                        post_cost_expectancy_bps=Decimal("-50.38094279"),
                        ledger_schema_version="torghut.exact_replay_ledger.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 8},
                        cost_model_hash_counts={"cost": 8},
                        lineage_hash_counts={"lineage": 8},
                        blockers_json=[],
                        payload_json={
                            "symbol": "AAPL",
                            "source_refs": ["postgres:executions:aapl"],
                            "source_offsets": [
                                {
                                    "topic": "torghut.trade-updates.v1",
                                    "partition": 0,
                                    "offset": 100,
                                }
                            ],
                            "pnl_derivation": "execution_reconstruction",
                        },
                        created_at=window_end + timedelta(minutes=1),
                        updated_at=window_end + timedelta(minutes=1),
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="hpairs-friday-window",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-cross-sectional-pairs-v1",
                        strategy_family="microbar_cross_sectional_pairs",
                        fill_count=6,
                        decision_count=3,
                        submitted_order_count=9,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=4,
                        open_position_count=0,
                        filled_notional=Decimal("74055.97138900"),
                        gross_strategy_pnl=Decimal("876.38483500"),
                        cost_amount=Decimal("1.42"),
                        net_strategy_pnl_after_costs=Decimal("874.96483500"),
                        post_cost_expectancy_bps=Decimal("118.14912675"),
                        ledger_schema_version="torghut.exact_replay_ledger.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 9},
                        cost_model_hash_counts={"cost": 9},
                        lineage_hash_counts={"lineage": 9},
                        blockers_json=[],
                        payload_json={
                            "symbol": "AMZN",
                            "source_refs": ["postgres:executions:amzn"],
                            "source_offsets": [
                                {
                                    "topic": "torghut.trade-updates.v1",
                                    "partition": 0,
                                    "offset": 101,
                                }
                            ],
                            "pnl_derivation": "execution_reconstruction",
                        },
                        created_at=window_end + timedelta(minutes=2),
                        updated_at=window_end + timedelta(minutes=2),
                    ),
                ]
            )
            session.commit()

            candidates = _load_runtime_ledger_repair_candidates(
                session,
                registry_items=registry_items,
                limit=5,
            )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["fill_count"], 22)
        self.assertEqual(candidate["submitted_order_count"], 17)
        self.assertEqual(candidate["closed_trade_count"], 17)
        self.assertEqual(candidate["filled_notional"], "223372.16394157")
        self.assertEqual(candidate["net_strategy_pnl_after_costs"], "122.69577957")
        runtime_bucket = cast(Mapping[str, object], candidate["runtime_ledger_bucket"])
        self.assertEqual(
            runtime_bucket["runtime_ledger_bucket_aggregation"],
            "portfolio_window_from_symbol_buckets",
        )
        self.assertEqual(runtime_bucket["runtime_ledger_aggregate_bucket_count"], 2)
        self.assertEqual(
            runtime_bucket["runtime_ledger_aggregate_symbols"], ["AAPL", "AMZN"]
        )

        source_candidates = _runtime_ledger_source_collection_candidates(candidates)
        self.assertEqual(len(source_candidates), 1)
        self.assertFalse(
            source_candidates[0]["source_collection_profit_target_candidate"]
        )
        self.assertEqual(
            source_candidates[0]["source_collection_priority"],
            "source_window_evidence_collection",
        )
        plan = _runtime_ledger_paper_probation_import_plan(source_candidates)
        self.assertEqual(plan["source_collection_profit_target_count"], 0)
        target = plan["targets"][0]
        self.assertTrue(target["bounded_live_paper_collection_authorized"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "25")
        self.assertEqual(target["max_notional"], "25")
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_htsmom_runtime_candidate_alias_unlocks_paper_probation_only(
        self,
    ) -> None:
        candidate = {
            "source": "strategy_runtime_ledger_buckets",
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "strategy_id": "intraday_tsmom_v2@research",
            "strategy_family": "intraday_tsmom_consistent",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "account": "TORGHUT_SIM",
            "observed_stage": "paper",
            "bucket_started_at": "2026-06-02T13:51:11.262153+00:00",
            "bucket_ended_at": "2026-06-02T18:14:43.066253+00:00",
            "decision_count": 2,
            "submitted_order_count": 6,
            "fill_count": 8,
            "closed_trade_count": 5,
            "open_position_count": 0,
            "filled_notional": "7546.75932928",
            "cost_amount": "0.25000000",
            "net_strategy_pnl_after_costs": "44.74192128",
            "post_cost_expectancy_bps": "59.28627021",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 5},
            "cost_model_hash_counts": {"cost": 8},
            "lineage_hash_counts": {"lineage": 17},
            "source_window_start": "2026-06-02T13:53:19.908725+00:00",
            "source_window_end": "2026-06-02T18:14:43.066253+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_tca_metrics",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
                "postgres:tigerbeetle_transfer_refs",
                "postgres:tigerbeetle_account_refs",
                "postgres:strategy_runtime_ledger_buckets:365d7c3a-2ea3-407f-a421-11ca3bf27c02",
                "postgres:tigerbeetle_transfer_refs:4b104eae-e7ae-4424-b4e6-f785b95dc8d4",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_tca_metrics": 2,
                "execution_order_events": 2,
                "order_feed_source_windows": 2,
                "tigerbeetle_account_refs": 3,
                "tigerbeetle_transfer_refs": 1,
            },
            "source_window_ids": ["window-1", "window-2"],
            "trade_decision_ids": ["decision-1", "decision-2"],
            "execution_ids": ["execution-1", "execution-2"],
            "execution_order_event_ids": ["event-1", "event-2"],
            "source_offsets": [
                {"topic": "torghut.trade-updates.v1", "partition": 1, "offset": 7091},
                {"topic": "torghut.trade-updates.v1", "partition": 1, "offset": 7092},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        mismatch_reasons = _runtime_ledger_repair_reason_codes(
            candidate,
            manifest={
                "candidate_id": "H-TSMOM-LIQ-01",
                "strategy_family": "intraday_tsmom_consistent",
            },
        )
        alias_reasons = _runtime_ledger_repair_reason_codes(
            candidate,
            manifest={
                "candidate_id": "H-TSMOM-LIQ-01",
                "paper_probation_candidate_ids": [
                    "H-TSMOM-LIQ-01",
                    "ca4e6e3c7d639e3363dc5860",
                ],
                "strategy_family": "intraday_tsmom_consistent",
            },
        )

        self.assertIn("runtime_ledger_candidate_mismatch", mismatch_reasons)
        self.assertEqual(alias_reasons, ["runtime_ledger_stage_not_live"])

        probation_candidates = _runtime_ledger_paper_probation_candidates(
            [{**candidate, "reason_codes": alias_reasons}]
        )
        self.assertEqual(len(probation_candidates), 1)
        probation_candidate = probation_candidates[0]
        self.assertTrue(probation_candidate["paper_probation_eligible"])
        self.assertTrue(probation_candidate["bounded_live_paper_collection_authorized"])
        self.assertFalse(probation_candidate["capital_promotion_allowed"])
        self.assertFalse(probation_candidate["final_promotion_allowed"])

        plan = _runtime_ledger_paper_probation_import_plan(probation_candidates)
        self.assertEqual(plan["paper_probation_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "ca4e6e3c7d639e3363dc5860")
        self.assertTrue(target["paper_probation_authorized"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(target["target_notional"], "25")
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "25")
        self.assertEqual(target["max_notional"], "25")
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertIn(
            "live_runtime_ledger_required", target["final_promotion_blockers"]
        )

    def test_source_collection_target_progress_payload_handles_zero_pnl(self) -> None:
        payload = _runtime_ledger_source_collection_target_progress_payload(
            net_pnl_after_costs=Decimal("0"),
            filled_notional=Decimal("125000"),
        )

        self.assertEqual(payload["probation_target_shortfall"], "500")
        self.assertEqual(payload["probation_target_progress_ratio"], "0")
        self.assertEqual(payload["required_notional_repair_scale_to_target"], "0")
        self.assertEqual(payload["required_notional_to_reach_target"], "0")
        self.assertEqual(
            payload["required_notional_repair_scale_authority"],
            "linear_notional_sizing_estimate_for_repair_only_not_capital_authority",
        )

    def test_runtime_ledger_repair_score_prefers_source_backed_positive_candidate(
        self,
    ) -> None:
        aggregate_profit_candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "bucket_ended_at": "2026-05-13T17:30:00+00:00",
            "submitted_order_count": 8,
            "fill_count": 35,
            "closed_trade_count": 2,
            "filled_notional": "127090.02495200",
            "net_strategy_pnl_after_costs": "567.44720578",
            "post_cost_expectancy_bps": "44.64923238",
            "reason_codes": [
                "runtime_ledger_source_window_missing",
                "runtime_ledger_source_refs_missing",
                "execution_reconstruction_not_runtime_ledger_proof",
            ],
        }
        source_backed_candidate = {
            "hypothesis_id": "H-TSMOM-LIQ-01",
            "candidate_id": "ca4e6e3c7d639e3363dc5860",
            "observed_stage": "paper",
            "bucket_ended_at": "2026-06-02T18:14:43.066253+00:00",
            "submitted_order_count": 2,
            "fill_count": 8,
            "closed_trade_count": 5,
            "filled_notional": "7546.75932928",
            "net_strategy_pnl_after_costs": "44.74192128",
            "post_cost_expectancy_bps": "59.28641313",
            "reason_codes": ["runtime_ledger_stage_not_live"],
            "runtime_ledger_bucket": {
                "source_window_start": "2026-06-02T13:51:11.262153+00:00",
                "source_window_end": "2026-06-02T18:14:43.066253+00:00",
                "source_refs": [
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["decision-1", "decision-2"],
                "execution_ids": ["execution-1", "execution-2"],
                "execution_order_event_ids": ["event-1", "event-2"],
                "source_window_ids": ["window-1", "window-2"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 42},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 43},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                "filled_notional": "7546.75932928",
                "cost_amount": "0.25000000",
                "cost_basis_counts": {"broker_reported_zero_cost": 1},
                "cost_model_hash_counts": {"cost-model": 1},
            },
        }

        self.assertGreater(
            _runtime_ledger_repair_score(source_backed_candidate),
            _runtime_ledger_repair_score(aggregate_profit_candidate),
        )

    def test_runtime_ledger_source_collection_bucket_without_account_uses_sim_source(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "source": "strategy_runtime_ledger_buckets",
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-pairs-vwap-cap-safe",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-13T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-13T17:30:00+00:00",
                    "submitted_order_count": 8,
                    "fill_count": 35,
                    "filled_notional": "127090.02495200",
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                }
            ]
        )

        self.assertEqual(len(candidates), 1)
        plan = _runtime_ledger_paper_probation_import_plan(candidates)

        target = plan["targets"][0]
        self.assertEqual(target["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")

    def test_bounded_source_collection_target_defaults_current_session_window(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "account": "TORGHUT_SIM",
                    "source_collection_candidate": True,
                    "source_collection_authorized": True,
                    "source_collection_profit_target_candidate": True,
                    "bounded_evidence_collection_authorized": True,
                    "bounded_evidence_collection_max_notional": "75000",
                    "source_collection_reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                }
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 0)
        self.assertEqual(plan["source_collection_target_count"], 1)
        self.assertEqual(plan["source_collection_profit_target_count"], 1)
        target = plan["targets"][0]
        self.assertTrue(target["source_collection_authorized"])
        self.assertTrue(target["runtime_ledger_source_collection_window_defaulted"])
        self.assertEqual(
            target["runtime_ledger_source_collection_window_source"],
            "current_regular_session_bounded_source_collection_default",
        )
        self.assertEqual(
            target["paper_route_probe_window_start"], target["window_start"]
        )
        self.assertEqual(target["paper_route_probe_window_end"], target["window_end"])

        window_start = datetime.fromisoformat(cast(str, target["window_start"]))
        window_end = datetime.fromisoformat(cast(str, target["window_end"]))
        self.assertEqual(window_end - window_start, timedelta(hours=6, minutes=30))

    def test_source_collection_import_target_defaults_without_bounded_submit(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "account": "TORGHUT_SIM",
                    "source_collection_candidate": True,
                    "source_collection_authorized": True,
                    "bounded_evidence_collection_authorized": False,
                    "source_collection_reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                }
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertTrue(target["source_collection_authorized"])
        self.assertTrue(target["bounded_live_paper_collection_authorized"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            target["bounded_evidence_collection_scope"],
            "paper_route_probe_next_session_only",
        )
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "25")
        self.assertEqual(target["max_notional"], "25")
        self.assertFalse(target["promotion_allowed"])
        self.assertTrue(target["runtime_ledger_source_collection_window_defaulted"])
        self.assertEqual(
            target["runtime_ledger_source_collection_window_source"],
            "current_regular_session_bounded_source_collection_default",
        )
        self.assertEqual(
            target["paper_route_probe_window_start"], target["window_start"]
        )
        self.assertEqual(target["paper_route_probe_window_end"], target["window_end"])

    def test_source_collection_import_target_defaults_existing_blank_window_target(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "account": "TORGHUT_SIM",
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "account_stage_runtime_identity": {
                        "source_kind": "runtime_ledger_source_collection_candidate",
                    },
                    "source_collection_authorized": True,
                    "window_start": "",
                    "window_end": "",
                    "paper_route_probe_window_start": "",
                    "paper_route_probe_window_end": "",
                    "bounded_evidence_collection_authorized": False,
                    "source_collection_reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                    ],
                }
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertTrue(target["source_collection_authorized"])
        self.assertTrue(target["runtime_ledger_source_collection_window_defaulted"])
        self.assertEqual(
            target["runtime_ledger_source_collection_window_source"],
            "current_regular_session_bounded_source_collection_default",
        )
        self.assertNotEqual(target["window_start"], "")
        self.assertNotEqual(target["window_end"], "")
        self.assertEqual(
            target["paper_route_probe_window_start"], target["window_start"]
        )
        self.assertEqual(target["paper_route_probe_window_end"], target["window_end"])

    def test_source_collection_probe_window_does_not_default_without_source_authority(
        self,
    ) -> None:
        self.assertEqual(
            _bounded_source_collection_probe_window({}), (None, None, False)
        )
        self.assertEqual(
            _bounded_source_collection_probe_window(
                {
                    "source_collection_candidate": True,
                }
            ),
            (None, None, False),
        )
        self.assertEqual(
            _bounded_source_collection_probe_window(
                {
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "window_start": "",
                    "window_end": "",
                }
            ),
            (None, None, False),
        )
        self.assertEqual(
            _bounded_source_collection_probe_window(
                {
                    "account_stage_runtime_identity": {
                        "source_kind": "runtime_ledger_source_collection_candidate",
                    },
                    "window_start": "",
                    "window_end": "",
                }
            ),
            (None, None, False),
        )

    def test_source_collection_probe_window_defaults_with_source_authority_only(
        self,
    ) -> None:
        window_start, window_end, defaulted = _bounded_source_collection_probe_window(
            {
                "source_kind": "runtime_ledger_source_collection_candidate",
                "source_collection_authorized": True,
                "bounded_evidence_collection_authorized": False,
                "window_start": "",
                "window_end": "",
            }
        )

        self.assertTrue(defaulted)
        self.assertIsNotNone(window_start)
        self.assertIsNotNone(window_end)
        self.assertEqual(
            datetime.fromisoformat(cast(str, window_end))
            - datetime.fromisoformat(cast(str, window_start)),
            timedelta(hours=6, minutes=30),
        )

    def test_runtime_ledger_source_collection_allows_unclosed_or_losing_activity(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-29T14:30:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "submitted_order_count": 6,
                    "fill_count": 12,
                    "closed_trade_count": 0,
                    "open_position_count": 1,
                    "filled_notional": "1087.98000000",
                    "net_strategy_pnl_after_costs": "-0.31170732",
                    "reason_codes": [
                        "runtime_ledger_stage_not_live",
                        "runtime_ledger_source_window_missing",
                        "runtime_ledger_source_refs_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                        "unclosed_position",
                        "post_cost_pnl_non_positive",
                    ],
                }
            ]
        )

        self.assertEqual(len(candidates), 1)
        source_candidate = candidates[0]
        self.assertTrue(source_candidate["source_collection_authorized"])
        self.assertEqual(source_candidate["proof_mode"], "probation")
        self.assertTrue(source_candidate["evidence_collection_ok"])
        self.assertFalse(source_candidate["canary_collection_authorized"])
        self.assertFalse(source_candidate["capital_promotion_allowed"])
        self.assertFalse(source_candidate.get("paper_probation_eligible", False))
        self.assertEqual(
            source_candidate["source_collection_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            source_candidate["source_collection_reason_codes"],
        )

        plan = _runtime_ledger_paper_probation_import_plan(candidates)

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertFalse(target["paper_probation_authorized"])
        self.assertTrue(target["source_collection_authorized"])
        self.assertEqual(target["proof_mode"], "probation")
        self.assertTrue(target["evidence_collection_ok"])
        self.assertFalse(target["canary_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["probation_allowed"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertIn("post_cost_pnl_non_positive", target["candidate_blockers"])
        self.assertIn("unclosed_position", target["candidate_blockers"])

    def test_runtime_ledger_source_collection_requires_real_fill_activity(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-29T14:30:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "submitted_order_count": 6,
                    "fill_count": 0,
                    "closed_trade_count": 0,
                    "open_position_count": 0,
                    "filled_notional": "0",
                    "net_strategy_pnl_after_costs": "0",
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                    ],
                }
            ]
        )

        self.assertEqual(candidates, [])

    def test_live_gate_marks_source_collection_pending_without_probation(
        self,
    ) -> None:
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_paper_route_probe_max_notional = 100
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2999-01-01T20:05:00Z"
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        class _RegistryItem:
            hypothesis_id = "H-PAIRS-01"

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "lane_id": "microbar_cross_sectional_pairs",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[_RegistryItem()],
        )

        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="pairs-source-missing-runtime",
                    candidate_id="c88421d619759b2cfaa6f4d0",
                    hypothesis_id="H-PAIRS-01",
                    observed_stage="paper",
                    bucket_started_at=now - timedelta(hours=3),
                    bucket_ended_at=now - timedelta(hours=1),
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="microbar-cross-sectional-pairs-v1",
                    strategy_family="microbar_cross_sectional_pairs",
                    fill_count=35,
                    decision_count=72,
                    submitted_order_count=35,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=12,
                    open_position_count=0,
                    filled_notional=Decimal("157941.50000000"),
                    gross_strategy_pnl=Decimal("5530.86354020"),
                    cost_amount=Decimal("16"),
                    net_strategy_pnl_after_costs=Decimal("5514.86354020"),
                    post_cost_expectancy_bps=Decimal("349.15976763"),
                    ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                    pnl_basis="realized_strategy_pnl_after_explicit_costs",
                    execution_policy_hash_counts={},
                    cost_model_hash_counts={},
                    lineage_hash_counts={},
                    blockers_json=["execution_reconstruction_not_runtime_ledger_proof"],
                )
            )
            session.commit()

            with patch(
                "app.trading.submission_council.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=True,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        metrics=SimpleNamespace(
                            feature_batch_rows_total=9,
                            feature_null_rate={"price": 0.0},
                            feature_staleness_ms_p95=250,
                            feature_duplicate_ratio=0.0,
                            decision_state_total={},
                        ),
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    promotion_certificate_evidence=[],
                    session=session,
                )
                waiting_gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=False,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        metrics=SimpleNamespace(
                            feature_batch_rows_total=9,
                            feature_null_rate={"price": 0.0},
                            feature_staleness_ms_p95=250,
                            feature_duplicate_ratio=0.0,
                            decision_state_total={},
                        ),
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    promotion_certificate_evidence=[],
                    session=session,
                )

        self.assertEqual(gate["paper_probation_eligible_total"], 0)
        self.assertEqual(gate["runtime_ledger_paper_probation_eligible_total"], 0)
        self.assertIn(
            "runtime_ledger_source_collection_pending", gate["blocked_reasons"]
        )
        self.assertIn(
            "runtime_ledger_profit_target_source_collection_pending",
            gate["blocked_reasons"],
        )
        self.assertFalse(gate["allowed"])
        collection_gate = gate["bounded_live_paper_collection_gate"]
        self.assertTrue(collection_gate["allowed"])
        self.assertTrue(collection_gate["active"])
        self.assertEqual(
            collection_gate["reason"],
            "bounded_live_paper_collection_ready",
        )
        self.assertEqual(
            collection_gate["authority_scope"], "bounded_evidence_collection_only"
        )
        self.assertFalse(collection_gate["capital_promotion_allowed"])
        self.assertFalse(collection_gate["final_authority_ok"])
        self.assertEqual(collection_gate["blocked_reasons"], [])
        self.assertEqual(collection_gate["paper_route_probe_max_notional"], "100")
        waiting_collection_gate = waiting_gate["bounded_live_paper_collection_gate"]
        self.assertTrue(waiting_collection_gate["allowed"])
        self.assertFalse(waiting_collection_gate["active"])
        self.assertEqual(
            waiting_collection_gate["reason"],
            "bounded_live_paper_collection_waiting_for_session",
        )
        self.assertEqual(gate["runtime_ledger_source_collection_candidate_total"], 1)
        self.assertEqual(
            gate["runtime_ledger_source_collection_profit_target_candidate_total"], 1
        )
        source_candidates = gate["runtime_ledger_source_collection_candidates"]
        self.assertEqual(len(source_candidates), 1)
        self.assertEqual(
            source_candidates[0]["source_collection_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertTrue(
            source_candidates[0]["source_collection_profit_target_candidate"]
        )
        self.assertEqual(
            source_candidates[0]["source_collection_priority"],
            "profit_target_source_materialization",
        )
        import_plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(import_plan["paper_probation_target_count"], 0)
        self.assertEqual(import_plan["source_collection_target_count"], 1)
        self.assertEqual(import_plan["source_collection_profit_target_count"], 1)
        target = import_plan["targets"][0]
        self.assertFalse(target["paper_probation_authorized"])
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertEqual(
            target["selection_reason"], "profit_target_source_window_evidence_pending"
        )
