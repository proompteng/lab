from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_window_import.support import *


class TestRuntimeWindowImportPart2(_TestRuntimeWindowImportBase):
    def test_build_observed_runtime_buckets_counts_only_source_backed_rows(
        self,
    ) -> None:
        source_backed_bucket = _runtime_ledger_bucket(
            filled_notional="100",
            net_strategy_pnl_after_costs="1",
            cost_amount="0.01",
            post_cost_expectancy_bps="100",
        )
        replay_only_bucket = _runtime_ledger_bucket(
            filled_notional="10000",
            net_strategy_pnl_after_costs="1000",
            cost_amount="0.01",
            post_cost_expectancy_bps="1000",
            source_window_ids=[],
            trade_decision_ids=[],
            execution_ids=[],
            execution_order_event_ids=[],
            source_offsets=[],
            source_materialization=None,
            authority_class="exact_replay_artifact_only_not_live",
            authority_reason="exact_replay_artifact_not_runtime_proof",
            pnl_derivation="exact_replay_artifact_only_not_live",
            blockers=["exact_replay_artifact_not_runtime_proof"],
        )

        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 40, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("100"),
                    "runtime_ledger_bucket": source_backed_bucket,
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("1000"),
                    "runtime_ledger_bucket": replay_only_bucket,
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 1)
        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("100"))
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_notional_weighted_sample_count"],
            1,
        )
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_filled_notional"], "100"
        )
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_net_strategy_pnl_after_costs"],
            "1",
        )
        runtime_ledger_buckets = buckets[0].payload_json["runtime_ledger_buckets"]
        self.assertIsInstance(runtime_ledger_buckets, list)
        self.assertEqual(len(runtime_ledger_buckets), 2)

    def test_runtime_ledger_bucket_blockers_require_complete_lifecycle_proof(
        self,
    ) -> None:
        missing_blockers = _runtime_ledger_bucket_blockers({})

        self.assertIn("runtime_ledger_schema_version_missing", missing_blockers)
        self.assertIn("runtime_ledger_pnl_basis_missing", missing_blockers)
        self.assertIn("runtime_ledger_open_position_count_missing", missing_blockers)

        invalid_blockers = _runtime_ledger_bucket_blockers(
            {
                "ledger_schema_version": "torghut.loose_runtime_ledger.v0",
                "pnl_basis": "simulation_report_net_pnl",
                "fill_count": 0,
                "decision_count": 0,
                "submitted_order_count": 0,
                "closed_trade_count": 0,
                "open_position_count": 1,
                "filled_notional": "0",
                "cost_amount": "-0.01",
                "post_cost_expectancy_bps": None,
                "execution_policy_hash_counts": "not-a-map",
                "cost_model_hash_counts": {},
                "lineage_hash_counts": {},
            }
        )

        self.assertIn("runtime_ledger_schema_version_invalid", invalid_blockers)
        self.assertIn("runtime_ledger_pnl_basis_invalid", invalid_blockers)
        self.assertIn("runtime_fills_missing", invalid_blockers)
        self.assertIn("runtime_decision_lifecycle_missing", invalid_blockers)
        self.assertIn("submitted_order_lifecycle_missing", invalid_blockers)
        self.assertIn("closed_round_trip_missing", invalid_blockers)
        self.assertIn("unclosed_position", invalid_blockers)
        self.assertIn("filled_notional_missing", invalid_blockers)
        self.assertIn("explicit_cost_missing", invalid_blockers)
        self.assertIn("runtime_ledger_expectancy_missing", invalid_blockers)
        self.assertIn("runtime_ledger_execution_policy_hash_missing", invalid_blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", invalid_blockers)
        self.assertIn("runtime_ledger_lineage_hash_missing", invalid_blockers)
        self.assertIn("source_decision_mode_profit_proof_missing", invalid_blockers)

    def test_runtime_ledger_bucket_blockers_preserve_diagnostic_expectancy(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_blockers(
            _runtime_ledger_bucket(
                open_position_count=1,
                post_cost_expectancy_bps=None,
                diagnostic_closed_trade_expectancy_bps="282.5",
                diagnostic_closed_trade_expectancy_basis=(
                    "realized_closed_trips_after_explicit_costs_not_promotion_grade"
                ),
            )
        )

        self.assertIn("unclosed_position", blockers)
        self.assertIn("runtime_ledger_expectancy_not_promotion_grade", blockers)
        self.assertNotIn("runtime_ledger_expectancy_missing", blockers)

    def test_runtime_ledger_bucket_blockers_reject_non_promotion_grade_cost_basis(
        self,
    ) -> None:
        for basis in (
            "modeled_paper_cost_budget",
            "paper_cost_model_estimate",
            "decision_impact_assumptions_total_cost_bps",
        ):
            with self.subTest(basis=basis):
                blockers = _runtime_ledger_bucket_blockers(
                    _runtime_ledger_bucket(cost_basis_counts={basis: 2})
                )

                self.assertEqual(
                    blockers,
                    [
                        "runtime_ledger_explicit_costs_missing",
                        "runtime_ledger_cost_basis_non_promotion_grade",
                    ],
                )

        self.assertFalse(
            cost_basis_counts_have_non_promotion_grade_costs(
                {"modeled_paper_cost_budget": object()}
            )
        )

    def test_runtime_ledger_bucket_blockers_reject_route_acquisition_profit_proof(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_blockers(
            _runtime_ledger_bucket(
                cost_basis_counts={"broker_reported_commission_and_fees": 2},
                source_decision_mode_counts={"route_acquisition_probe": 2},
            )
        )

        self.assertEqual(blockers, ["source_decision_mode_not_profit_proof_eligible"])

        self.assertFalse(
            source_decision_mode_counts_have_non_profit_proof_modes(
                {"route_acquisition_probe": object()}
            )
        )

    def test_runtime_ledger_bucket_blockers_reject_direct_route_acquisition_mode(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_blockers(
            _runtime_ledger_bucket(source_decision_mode="route-acquisition-probe")
        )

        self.assertEqual(blockers, ["source_decision_mode_not_profit_proof_eligible"])

    def test_runtime_ledger_bucket_blockers_reject_false_profit_proof_flag(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_blockers(
            _runtime_ledger_bucket(profit_proof_eligible="false")
        )

        self.assertEqual(blockers, ["source_decision_mode_not_profit_proof_eligible"])

    def test_runtime_ledger_bucket_blockers_reject_missing_source_decision_evidence(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_blockers(
            _runtime_ledger_bucket(
                source_decision_mode_counts={},
                profit_proof_eligible=None,
            )
        )

        self.assertEqual(blockers, ["source_decision_mode_profit_proof_missing"])

    def test_persisted_runtime_ledger_bucket_evidence_grade_rejects_modeled_cost_basis(
        self,
    ) -> None:
        row = StrategyRuntimeLedgerBucket(
            run_id="run-modeled-cost",
            candidate_id="cand",
            hypothesis_id="hyp",
            observed_stage="paper",
            bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            runtime_strategy_name="strategy",
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
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            execution_policy_hash_counts={"policy-sha": 2},
            cost_model_hash_counts={"cost-sha": 2},
            lineage_hash_counts={"lineage-sha": 2},
            blockers_json=[],
            payload_json={"cost_basis_counts": {"modeled_paper_cost_budget": 2}},
        )

        self.assertFalse(_persisted_runtime_ledger_bucket_evidence_grade(row))

    def test_persisted_runtime_ledger_bucket_evidence_grade_requires_source_proof(
        self,
    ) -> None:
        source_backed_payload = _runtime_ledger_bucket()
        aggregate_only_payload = {
            key: value
            for key, value in source_backed_payload.items()
            if key
            not in {
                "trade_decision_ids",
                "execution_ids",
                "execution_order_event_ids",
                "source_window_ids",
                "source_offsets",
                "source_materialization",
                "authority_class",
                "authority_reason",
            }
        }
        row = StrategyRuntimeLedgerBucket(
            run_id="run-aggregate-only",
            candidate_id="cand",
            hypothesis_id="hyp",
            observed_stage="paper",
            bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            runtime_strategy_name="strategy",
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
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            execution_policy_hash_counts={"policy-sha": 2},
            cost_model_hash_counts={"cost-sha": 2},
            lineage_hash_counts={"lineage-sha": 2},
            blockers_json=[],
            payload_json=aggregate_only_payload,
        )

        self.assertFalse(_persisted_runtime_ledger_bucket_evidence_grade(row))
        row.payload_json = source_backed_payload
        self.assertTrue(_persisted_runtime_ledger_bucket_evidence_grade(row))
        row.payload_json = {**source_backed_payload, "authority_reason": None}
        self.assertFalse(_persisted_runtime_ledger_bucket_evidence_grade(row))

    def test_runtime_window_readback_counts_only_source_backed_mixed_rows(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        source_backed_payload = _runtime_ledger_bucket()
        aggregate_only_payload = {
            key: value
            for key, value in source_backed_payload.items()
            if key
            not in {
                "trade_decision_ids",
                "execution_ids",
                "execution_tca_metric_ids",
                "execution_order_event_ids",
                "source_window_ids",
                "source_offsets",
                "source_materialization",
                "authority_class",
                "authority_reason",
            }
        }

        ledger_rows = [
            StrategyRuntimeLedgerBucket(
                run_id="mixed-source-runtime",
                candidate_id="cand",
                hypothesis_id="hyp",
                observed_stage="paper",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                account_label="TORGHUT_SIM",
                runtime_strategy_name="strategy",
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
                pnl_basis="realized_strategy_pnl_after_explicit_costs",
                ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                execution_policy_hash_counts={"policy-sha": 2},
                cost_model_hash_counts={"cost-sha": 2},
                lineage_hash_counts={"lineage-sha": 2},
                blockers_json=[],
                payload_json=payload,
            )
            for payload in (source_backed_payload, aggregate_only_payload)
        ]

        readback = _runtime_window_import_readback_from_rows(
            run_id="mixed-source-runtime",
            candidate_id="cand",
            hypothesis_id="hyp",
            observed_stage="paper",
            window_start=window_start,
            window_end=window_end,
            metric_rows=[],
            promotion_rows=[],
            ledger_rows=ledger_rows,
            runtime_ledger_daily_summary={},
            proof_blocker_codes=[],
        )

        self.assertEqual(readback["runtime_ledger_bucket_count"], 2)
        self.assertEqual(readback["evidence_grade_runtime_ledger_bucket_count"], 1)
        self.assertEqual(readback["execution_tca_metric_ids"], ["tca-buy", "tca-sell"])
        distance = readback["runtime_ledger_profit_distance_readback"]
        assert isinstance(distance, dict)
        self.assertEqual(
            distance["source_authority"]["source_backed_bucket_count"],
            1,
        )
        self.assertEqual(
            distance["source_authority"]["blocked_bucket_count"],
            1,
        )

    def test_runtime_window_import_readback_normalizes_source_offsets(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        good_payload = _runtime_ledger_bucket(
            source_offsets={
                "topic": "alpaca.trade_updates",
                "partition": 0,
                "offset": 100,
            },
            cost_basis_counts={"broker_reported_commission_and_fees": "2"},
        )
        malformed_payload = _runtime_ledger_bucket(
            source_offsets=[
                "alpaca.trade_updates:0:100",
                {"topic": "alpaca.trade_updates", "offset": 101},
                {
                    "topic": "alpaca.trade_updates",
                    "partition": 0,
                    "offset": 100,
                },
            ],
            cost_basis_counts={"broker_reported_commission_and_fees": "not-a-number"},
        )
        ledger_rows = [
            StrategyRuntimeLedgerBucket(
                run_id="readback-source-offsets",
                candidate_id="cand",
                hypothesis_id="hyp",
                observed_stage="paper",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                account_label="TORGHUT_SIM",
                runtime_strategy_name="strategy",
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
                pnl_basis="realized_strategy_pnl_after_explicit_costs",
                ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                execution_policy_hash_counts={"policy-sha": 2},
                cost_model_hash_counts={"cost-sha": 2},
                lineage_hash_counts={"lineage-sha": 2},
                blockers_json=[],
                payload_json=payload,
            )
            for payload in (good_payload, malformed_payload)
        ]

        readback = _runtime_window_import_readback_from_rows(
            run_id="readback-source-offsets",
            candidate_id="cand",
            hypothesis_id="hyp",
            observed_stage="paper",
            window_start=window_start,
            window_end=window_end,
            metric_rows=[],
            promotion_rows=[],
            ledger_rows=ledger_rows,
            runtime_ledger_daily_summary={},
            proof_blocker_codes=[],
        )

        self.assertEqual(
            readback["source_offsets"],
            [{"topic": "alpaca.trade_updates", "partition": 0, "offset": 100}],
        )
        self.assertEqual(
            readback["cost_basis_counts"],
            {"broker_reported_commission_and_fees": 2},
        )

    def test_runtime_ledger_bucket_payloads_accept_single_bucket_payload(
        self,
    ) -> None:
        payloads = _runtime_ledger_bucket_payloads(
            {"runtime_ledger_bucket": _runtime_ledger_bucket()}
        )

        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["blockers"], [])

    def test_runtime_observation_parsers_handle_edge_inputs(self) -> None:
        parsed = _parse_observation_datetime(
            datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        )

        self.assertEqual(parsed, datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc))
        self.assertEqual(_parse_observation_datetime("not-a-date"), None)
        self.assertEqual(_observation_bool(1), True)
        self.assertEqual(_observation_bool(0), False)
        self.assertEqual(_observation_bool("passed"), True)
        self.assertEqual(_observation_bool("blocked"), False)
        self.assertEqual(_observation_bool("unclear"), None)
        self.assertEqual(_observation_decimal("bad"), Decimal("0"))
        self.assertEqual(_observation_int("-7"), 0)
        self.assertEqual(_observation_int("bad"), 0)

    def test_delay_adjusted_depth_stress_blockers_cover_failed_and_stale_proof(
        self,
    ) -> None:
        _, manifest = resolve_hypothesis_manifest(
            hypothesis_id="H-MICRO-01",
            strategy_family="microstructure_breakout",
        )
        now = datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc)

        failed_reasons = _delay_adjusted_depth_stress_blocking_reasons(
            manifest=manifest,
            runtime_payload={
                "delay_adjusted_depth_stress_checks_total": 1,
                "delay_adjusted_depth_stress_passed": "failed",
                "delay_adjusted_depth_stress_checked_at": now.isoformat(),
            },
            now=now,
        )
        stale_reasons = _delay_adjusted_depth_stress_blocking_reasons(
            manifest=manifest,
            runtime_payload={
                "delay_adjusted_depth_stress_report": {
                    "case_count": "1",
                    "passed": True,
                    "checked_at": "2026-03-06T13:00:00Z",
                }
            },
            now=now,
        )

        self.assertEqual(failed_reasons, ["delay_adjusted_depth_stress_failed"])
        self.assertEqual(stale_reasons, ["delay_adjusted_depth_stress_stale"])

    def test_delay_adjusted_depth_stress_blockers_require_survival_detail(
        self,
    ) -> None:
        _, manifest = resolve_hypothesis_manifest(
            hypothesis_id="H-MICRO-01",
            strategy_family="microstructure_breakout",
        )
        now = datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc)

        reasons = _delay_adjusted_depth_stress_blocking_reasons(
            manifest=manifest,
            runtime_payload={
                "delay_adjusted_depth_stress_report": {
                    "case_count": "1",
                    "passed": True,
                    "checked_at": now.isoformat(),
                    "tail_coverage_passed": "false",
                    "p10_active_day_fillable_notional": "0",
                    "worst_active_day_fillable_notional": "0",
                    "stress_net_pnl_per_day": "-1",
                    "fill_survival_evidence_present": "false",
                    "fill_survival_sample_count": "0",
                }
            },
            now=now,
        )

        self.assertEqual(
            reasons,
            [
                "delay_adjusted_depth_tail_coverage_missing",
                "delay_adjusted_depth_p10_fillable_non_positive",
                "delay_adjusted_depth_worst_fillable_non_positive",
                "delay_adjusted_depth_stress_net_pnl_non_positive",
                "fill_survival_evidence_missing",
                "fill_survival_sample_count_zero",
                "queue_ahead_depletion_evidence_missing",
                "queue_ahead_depletion_sample_count_zero",
            ],
        )
