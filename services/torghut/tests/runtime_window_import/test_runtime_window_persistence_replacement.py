from __future__ import annotations

from tests.runtime_window_import.support import (
    Decimal,
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    VNextDatasetSnapshot,
    _runtime_ledger_bucket,
    _runtime_pnl_basis,
    _TestRuntimeWindowImportBase,
    build_observed_runtime_buckets,
    datetime,
    persist_observed_runtime_windows,
    select,
    timedelta,
    timezone,
    uuid4,
)


class TestRuntimeWindowPersistenceReplacement(_TestRuntimeWindowImportBase):
    def test_persist_observed_runtime_windows_creates_governance_rows(self) -> None:
        event_id = uuid4()
        buckets = build_observed_runtime_buckets(
            bucket_ranges=[
                (
                    datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    6,
                ),
                (
                    datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                    6,
                ),
            ],
            decision_times=[
                datetime(2026, 3, 6, 14, 35, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 5, tzinfo=timezone.utc),
            ],
            execution_times=[
                datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
            ],
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("3"),
                    "runtime_ledger_bucket": {
                        "bucket_started_at": "2026-03-06T14:35:00+00:00",
                        "bucket_ended_at": "2026-03-06T14:36:00+00:00",
                        "account_label": "paper",
                        "strategy_id": "intraday_tsmom_v1@paper",
                        "fill_count": 2,
                        "decision_count": 2,
                        "submitted_order_count": 2,
                        "closed_trade_count": 1,
                        "filled_notional": "200",
                        "gross_strategy_pnl": "1",
                        "cost_amount": "0.10",
                        "net_strategy_pnl_after_costs": "0.90",
                        "post_cost_expectancy_bps": "45",
                        "ledger_schema_version": "torghut.exact_replay_ledger.v1",
                        "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "execution_policy_hash_counts": {"policy-sha": 2},
                        "cost_model_hash_counts": {"cost-sha": 2},
                        "lineage_hash_counts": {"lineage-sha": 2},
                        "execution_order_event_ids": [str(event_id)],
                        "blockers": [],
                    },
                    **_runtime_pnl_basis(),
                },
                {
                    "computed_at": datetime(2026, 3, 6, 15, 6, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("5"),
                    "post_cost_expectancy_bps": Decimal("2"),
                    **_runtime_pnl_basis(),
                },
            ],
            continuity_ok=True,
            drift_ok=True,
            dependency_quorum_decision="allow",
        )

        with self.session_local() as session:
            session.add_all(
                [
                    TigerBeetleAccountRef(
                        cluster_id=2001,
                        account_id="100100100100100100100100100100100101",
                        account_key="TORGHUT_SIM:cash",
                        ledger=840001,
                        code=1001,
                        account_label="paper",
                    ),
                    TigerBeetleAccountRef(
                        cluster_id=2001,
                        account_id="100100100100100100100100100100100102",
                        account_key="TORGHUT_SIM:AAPL:position",
                        ledger=840001,
                        code=1002,
                        account_label="paper",
                        symbol="AAPL",
                    ),
                ]
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id="340282366920938463463374607431768211",
                    transfer_kind="fill_post",
                    ledger=840001,
                    code=2001,
                    amount=Decimal("200000000"),
                    status="created",
                    execution_order_event_id=event_id,
                    event_fingerprint="runtime-fill-event",
                    payload_json={
                        "debit_account_id": "100100100100100100100100100100100101",
                        "credit_account_id": "100100100100100100100100100100100102",
                    },
                )
            )
            session.flush()
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-1",
                candidate_id="cand-1",
                hypothesis_id="H-CONT-01",
                observed_stage="live",
                strategy_family="intraday_continuation",
                source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                buckets=buckets,
                runtime_observation_payload={
                    "dataset_snapshot_ref": "torghut-runtime-window-cand-1",
                    "artifact_refs": ["s3://torghut-runtime/cand-1/report.json"],
                    "source_kind": "live_runtime_observed",
                },
            )
            session.commit()

            hypotheses = session.execute(select(StrategyHypothesis)).scalars().all()
            versions = (
                session.execute(select(StrategyHypothesisVersion)).scalars().all()
            )
            windows = (
                session.execute(select(StrategyHypothesisMetricWindow)).scalars().all()
            )
            allocations = (
                session.execute(select(StrategyCapitalAllocation)).scalars().all()
            )
            decisions = (
                session.execute(select(StrategyPromotionDecision)).scalars().all()
            )
            ledger_buckets = (
                session.execute(select(StrategyRuntimeLedgerBucket)).scalars().all()
            )
            datasets = session.execute(select(VNextDatasetSnapshot)).scalars().all()

        self.assertEqual(len(hypotheses), 1)
        self.assertEqual(len(versions), 1)
        self.assertEqual(len(windows), 2)
        self.assertEqual(len(allocations), 1)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(len(ledger_buckets), 1)
        self.assertEqual(len(datasets), 1)
        self.assertEqual(
            ledger_buckets[0].pnl_basis,
            "realized_strategy_pnl_after_explicit_costs",
        )
        self.assertEqual(ledger_buckets[0].filled_notional, Decimal("200"))
        self.assertEqual(
            ledger_buckets[0].lineage_hash_counts,
            {"lineage-sha": 2},
        )
        payload = ledger_buckets[0].payload_json
        self.assertIsInstance(payload, dict)
        tigerbeetle_refs = payload.get("tigerbeetle")
        self.assertIsInstance(tigerbeetle_refs, dict)
        self.assertEqual(
            tigerbeetle_refs.get("account_ids"),
            [
                "100100100100100100100100100100100101",
                "100100100100100100100100100100100102",
            ],
        )
        self.assertEqual(
            tigerbeetle_refs.get("account_keys"),
            ["TORGHUT_SIM:AAPL:position", "TORGHUT_SIM:cash"],
        )
        self.assertEqual(tigerbeetle_refs.get("missing_account_ids"), [])
        self.assertEqual(
            tigerbeetle_refs.get("transfer_ids"),
            ["340282366920938463463374607431768211"],
        )
        self.assertEqual(
            payload.get("tigerbeetle_account_ids"),
            tigerbeetle_refs.get("account_ids"),
        )
        self.assertEqual(
            payload.get("tigerbeetle_account_keys"),
            tigerbeetle_refs.get("account_keys"),
        )
        self.assertEqual(
            payload.get("tigerbeetle_transfer_ids"),
            tigerbeetle_refs.get("transfer_ids"),
        )
        self.assertIn("postgres:tigerbeetle_account_refs", payload.get("source_refs"))
        self.assertIn("postgres:tigerbeetle_transfer_refs", payload.get("source_refs"))
        self.assertEqual(
            payload.get("source_row_counts", {}).get("tigerbeetle_account_refs"),
            2,
        )
        self.assertEqual(
            payload.get("source_row_counts", {}).get("tigerbeetle_transfer_refs"),
            1,
        )
        target_tigerbeetle_refs = summary["runtime_materialization_target"].get(
            "tigerbeetle"
        )
        self.assertIsInstance(target_tigerbeetle_refs, dict)
        self.assertEqual(
            target_tigerbeetle_refs.get("schema_version"),
            "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
        )
        self.assertEqual(target_tigerbeetle_refs.get("account_count"), 2)
        self.assertEqual(target_tigerbeetle_refs.get("transfer_count"), 1)
        self.assertEqual(
            target_tigerbeetle_refs.get("account_ids"),
            tigerbeetle_refs.get("account_ids"),
        )
        self.assertEqual(
            target_tigerbeetle_refs.get("transfer_ids"),
            tigerbeetle_refs.get("transfer_ids"),
        )
        self.assertEqual(
            target_tigerbeetle_refs.get("runtime_ledger_buckets"),
            [
                {
                    "runtime_ledger_bucket_id": str(ledger_buckets[0].id),
                    "account_ids": tigerbeetle_refs.get("account_ids"),
                    "account_keys": tigerbeetle_refs.get("account_keys"),
                    "transfer_ids": tigerbeetle_refs.get("transfer_ids"),
                    "missing_account_ids": [],
                }
            ],
        )
        self.assertEqual(datasets[0].candidate_id, "cand-1")
        self.assertEqual(datasets[0].artifact_ref, "torghut-runtime-window-cand-1")
        self.assertEqual(datasets[0].source, "live_runtime_observed")
        self.assertEqual(summary["market_session_samples"], 12)
        self.assertEqual(summary["latest_three_within_budget"], True)
        self.assertEqual(summary["promotion_allowed"], False)
        self.assertIn(
            "sample_count_below_canary_minimum",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            summary["promotion_blocking_reasons"],
        )
        self.assertEqual(summary["proof_status"], "blocked")
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            [item["blocker"] for item in summary["proof_blockers"]],
        )
        self.assertNotIn(
            "sample_count_below_canary_minimum",
            [item["blocker"] for item in summary["proof_blockers"]],
        )
        self.assertEqual(decisions[0].allowed, False)
        self.assertEqual(decisions[0].state, "shadow")

    def test_persist_observed_runtime_windows_replaces_overlapping_ledger_buckets(
        self,
    ) -> None:
        def buckets_for(net_pnl: str):
            return build_observed_runtime_buckets(
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
                        "computed_at": datetime(
                            2026, 3, 6, 14, 36, tzinfo=timezone.utc
                        ),
                        "abs_slippage_bps": Decimal("1"),
                        "post_cost_expectancy_bps": Decimal("40"),
                        "runtime_ledger_bucket": _runtime_ledger_bucket(
                            bucket_started_at="2026-03-06T14:35:00+00:00",
                            bucket_ended_at="2026-03-06T14:36:00+00:00",
                            account_label="TORGHUT_SIM",
                            strategy_id="microbar-cross-sectional-pairs-v1",
                            net_strategy_pnl_after_costs=net_pnl,
                        ),
                        **_runtime_pnl_basis(),
                    }
                ],
                continuity_ok=True,
                drift_ok=True,
                dependency_quorum_decision="allow",
            )

        with self.session_local() as session:
            old_summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-dedupe-old",
                candidate_id="cand-dedupe",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets_for("0.80"),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                },
            )
            new_summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-live-dedupe-new",
                candidate_id="cand-dedupe",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets_for("1.25"),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                },
            )
            session.commit()
            ledger_rows = (
                session.execute(
                    select(StrategyRuntimeLedgerBucket).order_by(
                        StrategyRuntimeLedgerBucket.created_at
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(old_summary["replaced_runtime_ledger_bucket_count"], 0)
        self.assertEqual(new_summary["replaced_runtime_ledger_bucket_count"], 1)
        self.assertEqual(len(ledger_rows), 1)
        self.assertEqual(ledger_rows[0].run_id, "import-live-dedupe-new")
        self.assertEqual(ledger_rows[0].net_strategy_pnl_after_costs, Decimal("1.25"))

    def test_persist_observed_runtime_windows_replaces_stale_open_bucket_from_source_window(
        self,
    ) -> None:
        def buckets_for(
            *,
            computed_at: datetime,
            bucket_started_at: str,
            bucket_ended_at: str,
            source_window_start: str,
            source_window_end: str,
            closed_trade_count: int,
            open_position_count: int,
            net_pnl: str,
        ):
            return build_observed_runtime_buckets(
                bucket_ranges=[
                    (
                        computed_at - timedelta(minutes=1),
                        computed_at + timedelta(minutes=1),
                        6,
                    )
                ],
                decision_times=[computed_at - timedelta(seconds=30)],
                execution_times=[computed_at],
                tca_rows=[
                    {
                        "computed_at": computed_at,
                        "abs_slippage_bps": Decimal("1"),
                        "post_cost_expectancy_bps": Decimal("40"),
                        "runtime_ledger_bucket": _runtime_ledger_bucket(
                            bucket_started_at=bucket_started_at,
                            bucket_ended_at=bucket_ended_at,
                            source_window_start=source_window_start,
                            source_window_end=source_window_end,
                            account_label="TORGHUT_SIM",
                            strategy_id="microbar-cross-sectional-pairs-v1",
                            closed_trade_count=closed_trade_count,
                            open_position_count=open_position_count,
                            net_strategy_pnl_after_costs=net_pnl,
                        ),
                        **_runtime_pnl_basis(),
                    }
                ],
                continuity_ok=True,
                drift_ok=True,
                dependency_quorum_decision="allow",
            )

        with self.session_local() as session:
            old_summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-source-window-old-open",
                candidate_id="cand-source-window",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets_for(
                    computed_at=datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    bucket_started_at="2026-03-06T14:35:00+00:00",
                    bucket_ended_at="2026-03-06T14:36:00+00:00",
                    source_window_start="2026-03-06T14:35:00+00:00",
                    source_window_end="2026-03-06T14:36:00+00:00",
                    closed_trade_count=0,
                    open_position_count=1,
                    net_pnl="0",
                ),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                },
            )
            new_summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-source-window-new-close",
                candidate_id="cand-source-window",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=buckets_for(
                    computed_at=datetime(2026, 3, 6, 14, 56, tzinfo=timezone.utc),
                    bucket_started_at="2026-03-06T14:55:00+00:00",
                    bucket_ended_at="2026-03-06T14:56:00+00:00",
                    source_window_start="2026-03-06T14:35:00+00:00",
                    source_window_end="2026-03-06T14:56:00+00:00",
                    closed_trade_count=1,
                    open_position_count=0,
                    net_pnl="1.25",
                ),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                },
            )
            session.commit()
            ledger_rows = (
                session.execute(
                    select(StrategyRuntimeLedgerBucket).order_by(
                        StrategyRuntimeLedgerBucket.created_at
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(old_summary["replaced_runtime_ledger_bucket_count"], 0)
        self.assertEqual(new_summary["replaced_runtime_ledger_bucket_count"], 1)
        self.assertEqual(len(ledger_rows), 1)
        self.assertEqual(ledger_rows[0].run_id, "import-source-window-new-close")
        self.assertEqual(ledger_rows[0].open_position_count, 0)
        self.assertEqual(ledger_rows[0].closed_trade_count, 1)

    def test_persist_observed_runtime_windows_dedupes_readback_when_fresh_late_source_bucket_arrives(
        self,
    ) -> None:
        def source_buckets():
            return build_observed_runtime_buckets(
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
                        "computed_at": datetime(2026, 6, 1, 14, 4, tzinfo=timezone.utc),
                        "abs_slippage_bps": Decimal("1"),
                        "post_cost_expectancy_bps": None,
                        "runtime_ledger_bucket": _runtime_ledger_bucket(
                            bucket_started_at="2026-06-01T13:41:00+00:00",
                            bucket_ended_at="2026-06-01T13:41:00.000001+00:00",
                            source_window_start="2026-06-01T13:41:00+00:00",
                            source_window_end="2026-06-01T13:41:00.000001+00:00",
                            runtime_ledger_readback_source=(
                                "strategy_runtime_ledger_buckets"
                            ),
                            source_window_ids=["source-window-late-close"],
                            execution_ids=["execution-late-close"],
                            trade_decision_ids=["decision-late-close"],
                            execution_order_event_ids=["event-late-close"],
                            fill_count=1,
                            closed_trade_count=0,
                            open_position_count=1,
                            filled_notional="100",
                            net_strategy_pnl_after_costs="0",
                        ),
                        **_runtime_pnl_basis(),
                    },
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
                            source_decision_mode_counts={"route_acquisition_probe": 2},
                            source_decision_mode="route_acquisition_probe",
                            profit_proof_eligible=False,
                            closed_trade_count=1,
                            open_position_count=0,
                            filled_notional="200",
                            net_strategy_pnl_after_costs="0.50",
                        ),
                        **_runtime_pnl_basis(),
                    },
                ],
                continuity_ok=True,
                drift_ok=True,
                dependency_quorum_decision="allow",
            )

        with self.session_local() as session:
            first_summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-late-linked-fill-idempotent",
                candidate_id="cand-late-linked-fill",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=source_buckets(),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": False,
                },
            )
            second_summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-late-linked-fill-idempotent",
                candidate_id="cand-late-linked-fill",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=source_buckets(),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": False,
                },
            )
            session.commit()
            ledger_rows = (
                session.execute(select(StrategyRuntimeLedgerBucket)).scalars().all()
            )

        self.assertEqual(
            first_summary["runtime_materialization_target"][
                "runtime_ledger_bucket_count"
            ],
            1,
        )
        self.assertEqual(
            second_summary["runtime_materialization_target"][
                "runtime_ledger_bucket_count"
            ],
            1,
        )
        self.assertEqual(
            second_summary["current_runtime_ledger_bucket_replacement_count"], 1
        )
        self.assertEqual(len(ledger_rows), 1)
        self.assertEqual(ledger_rows[0].closed_trade_count, 1)
        self.assertEqual(ledger_rows[0].open_position_count, 0)
        self.assertEqual(ledger_rows[0].filled_notional, Decimal("200"))
        self.assertIn(
            "source_decision_mode_not_profit_proof_eligible",
            ledger_rows[0].blockers_json,
        )
        self.assertNotIn("runtime_ledger_readback_source", ledger_rows[0].payload_json)

    def test_persist_observed_runtime_windows_prefers_post_window_closeout_over_stale_readback(
        self,
    ) -> None:
        def source_buckets():
            return build_observed_runtime_buckets(
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
                        "computed_at": datetime(
                            2026, 6, 1, 13, 55, tzinfo=timezone.utc
                        ),
                        "abs_slippage_bps": Decimal("1"),
                        "post_cost_expectancy_bps": None,
                        "runtime_ledger_bucket": _runtime_ledger_bucket(
                            bucket_started_at="2026-06-01T13:41:00+00:00",
                            bucket_ended_at="2026-06-01T13:55:00.000001+00:00",
                            source_window_start="2026-06-01T13:41:00+00:00",
                            source_window_end="2026-06-01T13:55:00.000001+00:00",
                            runtime_ledger_readback_source=(
                                "strategy_runtime_ledger_buckets"
                            ),
                            source_window_ids=["source-window-entry"],
                            execution_ids=["execution-entry"],
                            trade_decision_ids=["decision-entry"],
                            execution_order_event_ids=["event-fill-entry"],
                            fill_count=1,
                            closed_trade_count=0,
                            open_position_count=1,
                            filled_notional="100",
                            net_strategy_pnl_after_costs="0",
                        ),
                        **_runtime_pnl_basis(),
                    },
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
                            execution_ids=[
                                "execution-entry",
                                "execution-closeout",
                            ],
                            trade_decision_ids=[
                                "decision-entry",
                                "decision-closeout",
                            ],
                            execution_order_event_ids=[
                                "event-fill-entry",
                                "event-fill-closeout",
                            ],
                            closed_trade_count=1,
                            open_position_count=0,
                            filled_notional="200",
                            net_strategy_pnl_after_costs="0.50",
                        ),
                        **_runtime_pnl_basis(),
                    },
                ],
                continuity_ok=True,
                drift_ok=True,
                dependency_quorum_decision="allow",
            )

        with self.session_local() as session:
            summary = persist_observed_runtime_windows(
                session=session,
                run_id="import-post-window-closeout",
                candidate_id="cand-post-window-closeout",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=source_buckets(),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": False,
                },
            )
            session.commit()
            ledger_rows = (
                session.execute(select(StrategyRuntimeLedgerBucket)).scalars().all()
            )

        self.assertEqual(
            summary["runtime_materialization_target"]["runtime_ledger_bucket_count"],
            1,
        )
        self.assertEqual(len(ledger_rows), 1)
        self.assertEqual(ledger_rows[0].closed_trade_count, 1)
        self.assertEqual(ledger_rows[0].open_position_count, 0)
        self.assertEqual(ledger_rows[0].filled_notional, Decimal("200"))
        self.assertEqual(
            ledger_rows[0].bucket_ended_at.replace(tzinfo=timezone.utc),
            datetime(2026, 6, 1, 14, 5, 0, 1, tzinfo=timezone.utc),
        )
        self.assertNotIn("runtime_ledger_readback_source", ledger_rows[0].payload_json)
