from __future__ import annotations

from tests.runtime_window_import.support import (
    Decimal,
    FakeTigerBeetleClient,
    StrategyRuntimeLedgerBucket,
    journal_tigerbeetle_runtime_ledger_bucket,
    _runtime_ledger_bucket,
    _runtime_pnl_basis,
    runtime_window_import_proof_blockers,
    _simulation_report_pnl_basis,
    _TestRuntimeWindowImportBase,
    build_observed_runtime_buckets,
    build_regular_session_buckets,
    datetime,
    patch,
    runtime_window_import_module,
    timezone,
)


class TestRuntimeWindowBucketsAndJournaling(_TestRuntimeWindowImportBase):
    def test_runtime_window_import_proof_blockers_dedupe_blank_and_authority_reason(
        self,
    ) -> None:
        blockers = runtime_window_import_proof_blockers(
            promotion_blocking_reasons=[
                "",
                "paper_stage_evidence_collection_only",
                "paper_stage_evidence_collection_only",
            ],
            runtime_payload={
                "authoritative": False,
                "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                "promotion_authority": "blocked",
                "runtime_ledger_profit_proof_present": False,
            },
            candidate_id="cand-paper-route",
            hypothesis_id="H-PAIRS-01",
            observed_stage="paper",
            window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(
            [item["blocker"] for item in blockers],
            [
                "paper_stage_evidence_collection_only",
                "runtime_without_runtime_ledger_profit_proof",
            ],
        )
        self.assertEqual(blockers[0]["promotion_authority"], "blocked")
        self.assertFalse(blockers[0]["runtime_ledger_profit_proof_present"])

    def test_runtime_ledger_bucket_journal_failure_respects_required_flag(
        self,
    ) -> None:
        with self.session_local() as session:
            row = StrategyRuntimeLedgerBucket(
                run_id="run-journal-failure",
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
                payload_json={},
            )
            session.add(row)
            session.flush()

            with (
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_journal_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_required",
                    False,
                ),
                patch(
                    "app.trading.runtime_window_import_modules.ledger_persistence.TigerBeetleLedgerJournal.journal_runtime_ledger_bucket",
                    side_effect=RuntimeError("journal failed"),
                ),
            ):
                with self.assertLogs(
                    runtime_window_import_module.logger,
                    level="WARNING",
                ):
                    journal_tigerbeetle_runtime_ledger_bucket(session, row)
            session.refresh(row)
            parity = row.payload_json["tigerbeetle_journal_parity"]
            self.assertEqual(parity["status"], "non_authority_blocked")
            self.assertEqual(parity["blockers"], ["tigerbeetle_journal_error"])
            self.assertFalse(parity["promotion_authority"])
            self.assertIn(
                "tigerbeetle_accounting_parity_not_promotion_authority",
                row.payload_json["tigerbeetle_non_authority_blockers"],
            )

            with (
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_journal_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_required",
                    True,
                ),
                patch(
                    "app.trading.runtime_window_import_modules.ledger_persistence.TigerBeetleLedgerJournal.journal_runtime_ledger_bucket",
                    side_effect=RuntimeError("journal failed"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "journal failed"):
                    journal_tigerbeetle_runtime_ledger_bucket(session, row)

    def test_runtime_bucket_journal_records_durable_tigerbeetle_refs(self) -> None:
        with self.session_local() as session:
            row = StrategyRuntimeLedgerBucket(
                run_id="run-journal-success",
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
                payload_json={
                    "source_refs": ["postgres:execution_order_events:event-1"],
                    "source_window_refs": ["postgres:source_windows:window-1"],
                },
            )
            session.add(row)
            session.flush()
            fake_client = FakeTigerBeetleClient()

            with (
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_journal_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_required",
                    False,
                ),
                patch(
                    "app.trading.tigerbeetle_journal_modules.ledger_journal.create_tigerbeetle_client",
                    return_value=fake_client,
                ),
            ):
                journal_tigerbeetle_runtime_ledger_bucket(session, row)

            session.refresh(row)
            payload = row.payload_json
            parity = payload["tigerbeetle_journal_parity"]
            self.assertEqual(parity["status"], "pass")
            self.assertEqual(parity["blockers"], [])
            self.assertFalse(parity["promotion_authority"])
            self.assertEqual(parity["transfer_count"], 1)
            self.assertEqual(len(payload["tigerbeetle_transfer_ids"]), 1)
            self.assertEqual(len(fake_client.transfers), 1)
            self.assertIn(
                "postgres:tigerbeetle_transfer_refs",
                " ".join(payload["source_refs"]),
            )

    def test_runtime_bucket_journal_disabled_records_non_authority_blocker(
        self,
    ) -> None:
        with self.session_local() as session:
            row = StrategyRuntimeLedgerBucket(
                run_id="run-journal-disabled",
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
                payload_json={},
            )
            session.add(row)

            with (
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_enabled",
                    False,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_journal_enabled",
                    True,
                ),
            ):
                journal_tigerbeetle_runtime_ledger_bucket(session, row)

            session.refresh(row)
            parity = row.payload_json["tigerbeetle_journal_parity"]
            self.assertEqual(parity["status"], "non_authority_blocked")
            self.assertEqual(parity["blockers"], ["tigerbeetle_journal_disabled"])
            self.assertEqual(parity["transfer_ids"], [])
            self.assertIsNotNone(row.id)
            self.assertEqual(parity["runtime_ledger_bucket_id"], str(row.id))
            self.assertIn(
                f"postgres:strategy_runtime_ledger_buckets:{row.id}",
                parity["source_refs"],
            )
            self.assertNotIn(
                "postgres:strategy_runtime_ledger_buckets:None",
                row.payload_json["source_refs"],
            )

    def test_runtime_bucket_journal_unavailable_records_non_authority_blocker(
        self,
    ) -> None:
        with self.session_local() as session:
            row = StrategyRuntimeLedgerBucket(
                run_id="run-journal-unavailable",
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
                payload_json={
                    "source_refs": ["postgres:execution_order_events:event-1"],
                    "source_window_refs": ["postgres:source_windows:window-1"],
                    "tigerbeetle": {
                        "account_ids": ["existing-account"],
                        "account_keys": ["existing-key"],
                        "transfer_ids": ["existing-transfer"],
                    },
                },
            )
            session.add(row)
            session.flush()

            with (
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_journal_enabled",
                    True,
                ),
                patch.object(
                    runtime_window_import_module.settings,
                    "tigerbeetle_required",
                    False,
                ),
                patch(
                    "app.trading.runtime_window_import_modules.ledger_persistence.TigerBeetleLedgerJournal.journal_runtime_ledger_bucket",
                    return_value=None,
                ),
            ):
                journal_tigerbeetle_runtime_ledger_bucket(session, row)

            session.refresh(row)
            payload = row.payload_json
            parity = payload["tigerbeetle_journal_parity"]
            self.assertEqual(parity["status"], "non_authority_blocked")
            self.assertEqual(
                parity["blockers"], ["tigerbeetle_journal_entry_unavailable"]
            )
            self.assertEqual(payload["tigerbeetle_transfer_ids"], ["existing-transfer"])
            self.assertEqual(payload["tigerbeetle_account_ids"], ["existing-account"])

    def test_build_regular_session_buckets_counts_session_samples(self) -> None:
        buckets = build_regular_session_buckets(
            window_start=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            window_end=datetime(2026, 3, 6, 16, 30, tzinfo=timezone.utc),
            bucket_minutes=30,
            sample_minutes=5,
        )

        self.assertEqual(len(buckets), 4)
        self.assertEqual([item[2] for item in buckets], [6, 6, 6, 6])

    def test_build_observed_runtime_buckets_treats_idle_window_as_aligned(self) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].decision_alignment_ratio, Decimal("1"))
        self.assertEqual(buckets[0].avg_abs_slippage_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)

    def test_build_observed_runtime_buckets_assigns_late_settled_source_bucket_to_source_window(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 6, 1, 14, 5, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("25"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        bucket_started_at="2026-06-01T13:41:00+00:00",
                        bucket_ended_at="2026-06-01T13:41:00.000001+00:00",
                        source_window_start="2026-06-01T13:41:00+00:00",
                        source_window_end="2026-06-01T13:41:00.000001+00:00",
                        source_window_ids=["source-window-late-close"],
                        execution_ids=["execution-late-close"],
                        trade_decision_ids=["decision-late-close"],
                        execution_order_event_ids=["event-late-close"],
                        source_offsets=[
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 41,
                            }
                        ],
                    ),
                    **_runtime_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].payload_json["tca_row_count"], 1)
        self.assertEqual(buckets[0].trade_count, 2)
        runtime_payloads = buckets[0].payload_json["runtime_ledger_buckets"]
        self.assertEqual(len(runtime_payloads), 1)
        self.assertEqual(
            runtime_payloads[0]["source_window_ids"], ["source-window-late-close"]
        )

    def test_build_observed_runtime_buckets_assigns_post_window_closeout_to_import_window(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 6, 1, 14, 5, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("25"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        bucket_started_at="2026-06-01T13:41:00+00:00",
                        bucket_ended_at="2026-06-01T14:05:00.000001+00:00",
                        source_window_start="2026-06-01T13:41:00+00:00",
                        source_window_end="2026-06-01T14:05:00.000001+00:00",
                        source_window_ids=[
                            "source-window-entry",
                            "source-window-closeout",
                        ],
                        execution_ids=["execution-entry", "execution-closeout"],
                        trade_decision_ids=["decision-entry", "decision-closeout"],
                        execution_order_event_ids=[
                            "event-fill-entry",
                            "event-fill-closeout",
                        ],
                        source_offsets=[
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 41,
                            },
                            {
                                "topic": "alpaca.trade_updates",
                                "partition": 0,
                                "offset": 42,
                            },
                        ],
                    ),
                    **_runtime_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].payload_json["tca_row_count"], 1)
        runtime_payloads = buckets[0].payload_json["runtime_ledger_buckets"]
        self.assertEqual(len(runtime_payloads), 1)
        self.assertEqual(
            runtime_payloads[0]["source_window_ids"],
            ["source-window-entry", "source-window-closeout"],
        )

    def test_build_observed_runtime_buckets_ignores_out_of_window_tca_rows(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[],
            execution_times=[],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 6, 1, 14, 5, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("25"),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 6, 1, 14, 5, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("25"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        bucket_started_at="2026-06-01T14:10:00+00:00",
                        bucket_ended_at="2026-06-01T14:11:00+00:00",
                        source_window_start="2026-06-01T14:10:00+00:00",
                        source_window_end="2026-06-01T14:11:00+00:00",
                    ),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(len(buckets), 1)
        self.assertEqual(buckets[0].payload_json["tca_row_count"], 0)
        self.assertEqual(buckets[0].trade_count, 0)

    def test_build_observed_runtime_buckets_quarantines_simulation_report_pnl(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("50"),
                    **_simulation_report_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"simulation_report_net_pnl": 1},
        )

    def test_build_observed_runtime_buckets_rejects_legacy_realized_pnl_basis(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("50"),
                    "post_cost_expectancy_basis": "realized_strategy_pnl",
                    "post_cost_promotion_eligible": True,
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"realized_strategy_pnl": 1},
        )

    def test_build_observed_runtime_buckets_marks_missing_post_cost_basis(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("50"),
                    "post_cost_promotion_eligible": True,
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"post_cost_basis_missing": 1},
        )

    def test_build_observed_runtime_buckets_requires_runtime_ledger_bucket_for_pnl_basis(
        self,
    ) -> None:
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                )
            ],
            decision_times=[datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc)],
            execution_times=[datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc)],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("50"),
                    **_runtime_pnl_basis(),
                }
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        self.assertEqual(buckets[0].post_cost_expectancy_bps, Decimal("0"))
        self.assertEqual(buckets[0].post_cost_promotion_sample_count, 0)
        self.assertEqual(
            buckets[0].payload_json["post_cost_expectancy_aggregation"],
            "no_runtime_ledger_post_cost_rows",
        )
        self.assertEqual(
            buckets[0].post_cost_basis_counts,
            {"realized_strategy_pnl_after_explicit_costs": 1},
        )

    def test_build_observed_runtime_buckets_weights_runtime_ledger_by_notional(
        self,
    ) -> None:
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
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="100",
                        net_strategy_pnl_after_costs="1",
                        cost_amount="0.01",
                        post_cost_expectancy_bps="100",
                    ),
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 14, 41, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("1"),
                    "post_cost_expectancy_bps": Decimal("1"),
                    "runtime_ledger_bucket": _runtime_ledger_bucket(
                        filled_notional="10000",
                        net_strategy_pnl_after_costs="1",
                        cost_amount="0.01",
                        post_cost_expectancy_bps="1",
                    ),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        expected = (Decimal("2") / Decimal("10100")) * Decimal("10000")
        self.assertEqual(buckets[0].post_cost_expectancy_bps, expected)
        self.assertEqual(
            buckets[0].payload_json["post_cost_expectancy_aggregation"],
            "runtime_ledger_notional_weighted",
        )
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_filled_notional"], "10100"
        )
        self.assertEqual(
            buckets[0].payload_json["runtime_ledger_net_strategy_pnl_after_costs"],
            "2",
        )
