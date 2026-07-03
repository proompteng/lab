from __future__ import annotations


from tests.submission_council.support import (
    Base,
    Decimal,
    SimpleNamespace,
    StaticPool,
    StrategyRuntimeLedgerBucket,
    SubmissionCouncilTestCase,
    _runtime_ledger_paper_probation_blockers,
    _runtime_ledger_paper_probation_import_plan,
    _runtime_ledger_repair_reason_codes,
    build_live_submission_gate_payload,
    create_engine,
    datetime,
    patch,
    sessionmaker,
    timedelta,
    timezone,
)


class TestSubmissionCouncilRuntimeLedgerRepairCandidates(SubmissionCouncilTestCase):
    def test_build_live_submission_gate_payload_surfaces_runtime_ledger_repair_candidates(
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
        now = datetime.now(timezone.utc)

        class _RegistryItem:
            def __init__(
                self,
                *,
                hypothesis_id: str,
                candidate_id: str,
                strategy_id: str,
                strategy_family: str,
                segment_dependencies: list[str] | None = None,
                paper_probation_candidate_ids: list[str] | None = None,
            ) -> None:
                self.hypothesis_id = hypothesis_id
                self._payload = {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "paper_probation_candidate_ids": list(
                        paper_probation_candidate_ids or []
                    ),
                    "strategy_id": strategy_id,
                    "strategy_family": strategy_family,
                    "lane_id": strategy_family,
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                    "segment_dependencies": list(segment_dependencies or []),
                }

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return dict(self._payload)

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[
                _RegistryItem(
                    hypothesis_id="H-CONT-01",
                    candidate_id="chip-paper-microbar-composite@execution-proof",
                    strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
                    strategy_family="intraday_continuation",
                ),
                _RegistryItem(
                    hypothesis_id="H-PAIRS-01",
                    candidate_id="c88421d619759b2cfaa6f4d0",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_family="microbar_cross_sectional_pairs",
                    paper_probation_candidate_ids=[
                        "c88421d619759b2cfaa6f4d0",
                        "3e49d7da73ac2456c3eecb02",
                    ],
                ),
                _RegistryItem(
                    hypothesis_id="H-REV-01",
                    candidate_id="rev-candidate",
                    strategy_id="microbar_prev_day_open45_reversal_long_top1_chip_v1@paper",
                    strategy_family="event_reversion",
                    segment_dependencies=["market-context"],
                ),
            ],
        )

        with session_local() as session:
            pairs_source_payload = {
                "source_window_start": (now - timedelta(minutes=45)).isoformat(),
                "source_window_end": (now - timedelta(minutes=30)).isoformat(),
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["pairs-decision-buy", "pairs-decision-sell"],
                "execution_ids": ["pairs-execution-buy", "pairs-execution-sell"],
                "execution_order_event_ids": [
                    "pairs-event-new-buy",
                    "pairs-event-fill-buy",
                ],
                "source_window_ids": [
                    "pairs-source-window-buy",
                    "pairs-source-window-sell",
                ],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            }
            reversal_source_payload = {
                "source_window_start": (now - timedelta(minutes=75)).isoformat(),
                "source_window_end": (now - timedelta(minutes=60)).isoformat(),
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-reversal-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 1,
                },
                "trade_decision_ids": ["reversal-decision"],
                "execution_ids": ["reversal-execution"],
                "execution_order_event_ids": ["reversal-event-fill"],
                "source_window_ids": ["reversal-source-window"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 200}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            }
            session.add_all(
                [
                    StrategyRuntimeLedgerBucket(
                        run_id="cont-zero-fill",
                        candidate_id="chip-paper-microbar-composite@execution-proof",
                        hypothesis_id="H-CONT-01",
                        observed_stage="paper",
                        bucket_started_at=now - timedelta(minutes=30),
                        bucket_ended_at=now - timedelta(minutes=15),
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-volume-continuation-long-top2-chip-v1",
                        strategy_family="intraday_continuation",
                        fill_count=0,
                        decision_count=9,
                        submitted_order_count=9,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=9,
                        closed_trade_count=0,
                        open_position_count=0,
                        filled_notional=Decimal("0"),
                        gross_strategy_pnl=Decimal("0"),
                        cost_amount=Decimal("0"),
                        net_strategy_pnl_after_costs=Decimal("0"),
                        post_cost_expectancy_bps=None,
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={},
                        cost_model_hash_counts={},
                        lineage_hash_counts={},
                        blockers_json=["zero_fill_runtime_ledger"],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="pairs-realized-runtime",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                        observed_stage="paper",
                        bucket_started_at=now - timedelta(minutes=45),
                        bucket_ended_at=now - timedelta(minutes=30),
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-pairs-vwap-cap-safe",
                        strategy_family="microbar_cross_sectional_pairs",
                        fill_count=2,
                        decision_count=2,
                        submitted_order_count=2,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=2,
                        open_position_count=0,
                        filled_notional=Decimal("127090.02495200"),
                        gross_strategy_pnl=Decimal("581.44720578"),
                        cost_amount=Decimal("14"),
                        net_strategy_pnl_after_costs=Decimal("567.44720578"),
                        post_cost_expectancy_bps=Decimal("44.64923238"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 2},
                        cost_model_hash_counts={"cost": 2},
                        lineage_hash_counts={"lineage": 2},
                        blockers_json=[],
                        payload_json=pairs_source_payload,
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="pairs-reversal-runtime",
                        candidate_id="3e49d7da73ac2456c3eecb02",
                        hypothesis_id="H-PAIRS-01",
                        observed_stage="paper",
                        bucket_started_at=now - timedelta(minutes=75),
                        bucket_ended_at=now - timedelta(minutes=60),
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-pairs-vwap-reversal",
                        strategy_family="microbar_cross_sectional_pairs",
                        fill_count=1,
                        decision_count=1,
                        submitted_order_count=1,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=1,
                        open_position_count=0,
                        filled_notional=Decimal("316509.62015600"),
                        gross_strategy_pnl=Decimal("555.25627600"),
                        cost_amount=Decimal("123.22325790"),
                        net_strategy_pnl_after_costs=Decimal("432.03301810"),
                        post_cost_expectancy_bps=Decimal("13.64991743"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 1},
                        cost_model_hash_counts={"cost": 1},
                        lineage_hash_counts={"lineage": 1},
                        blockers_json=[],
                        payload_json=reversal_source_payload,
                    ),
                ]
            )
            session.commit()

            with patch(
                "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=False,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        last_market_context_domain_states={"news": "stale"},
                        market_context_alert_active=True,
                        market_context_alert_reason="market_context_stale",
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
                            "capital_stage_totals": {"shadow": 2},
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
                    promotion_certificate_evidence=[
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "metric_window": self._metric_window(
                                observed_stage="paper",
                                run_id="pairs-paper-window",
                                candidate_id="c88421d619759b2cfaa6f4d0",
                                hypothesis_id="H-PAIRS-01",
                            ),
                            "promotion_decision": self._promotion_decision(
                                run_id="pairs-paper-window",
                                candidate_id="c88421d619759b2cfaa6f4d0",
                                hypothesis_id="H-PAIRS-01",
                            ),
                        },
                        {
                            "hypothesis_id": "H-REV-01",
                            "metric_window": self._metric_window(
                                observed_stage="paper",
                                run_id="rev-paper-window",
                                candidate_id="rev-candidate",
                                hypothesis_id="H-REV-01",
                            ),
                            "promotion_decision": self._promotion_decision(
                                run_id="rev-paper-window",
                                candidate_id="rev-candidate",
                                hypothesis_id="H-REV-01",
                            ),
                        },
                    ],
                    session=session,
                )

        candidates = gate["runtime_ledger_repair_candidates"]
        self.assertIsInstance(candidates, list)
        self.assertEqual(candidates[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(candidates[0]["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(candidates[0]["net_strategy_pnl_after_costs"], "567.44720578")
        self.assertEqual(
            candidates[0]["promotion_authority"], "runtime_ledger_candidate_only"
        )
        self.assertIn("runtime_ledger_stage_not_live", candidates[0]["reason_codes"])
        self.assertNotIn(
            "runtime_ledger_source_window_missing",
            candidates[0]["reason_codes"],
        )
        self.assertNotIn(
            "runtime_ledger_source_refs_missing",
            candidates[0]["reason_codes"],
        )
        self.assertNotIn(
            "runtime_ledger_candidate_mismatch", candidates[0]["reason_codes"]
        )
        self.assertEqual(
            candidates[0]["source_refs"],
            [
                "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(
            candidates[0]["source_window_ids"],
            ["pairs-source-window-buy", "pairs-source-window-sell"],
        )
        self.assertEqual(
            candidates[0]["trade_decision_ids"],
            ["pairs-decision-buy", "pairs-decision-sell"],
        )
        self.assertEqual(
            candidates[0]["execution_ids"],
            ["pairs-execution-buy", "pairs-execution-sell"],
        )
        self.assertEqual(
            candidates[0]["execution_order_event_ids"],
            ["pairs-event-new-buy", "pairs-event-fill-buy"],
        )
        self.assertEqual(
            candidates[0]["source_offsets"], pairs_source_payload["source_offsets"]
        )
        self.assertEqual(
            candidates[0]["source_materialization"], "execution_order_events"
        )
        self.assertEqual(
            candidates[0]["authority_class"], "runtime_order_feed_execution_source"
        )
        self.assertEqual(
            candidates[0]["authority_reason"],
            "event_sourced_runtime_ledger_profit_proof",
        )
        paper_candidates = gate["runtime_ledger_paper_probation_candidates"]
        self.assertEqual(gate["paper_probation_eligible_total"], 2)
        self.assertEqual(gate["runtime_ledger_paper_probation_eligible_total"], 2)
        self.assertTrue(gate["allowed"])
        self.assertNotIn(
            "paper_probation_evidence_collection_only", gate["blocked_reasons"]
        )
        self.assertNotIn("segment_market-context_blocked", gate["blocked_reasons"])
        self.assertNotIn("market_context_stale", gate["blocked_reasons"])
        self.assertNotIn("market_context_domain_news_stale", gate["blocked_reasons"])
        self.assertEqual(len(paper_candidates), 2)
        self.assertEqual(paper_candidates[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(paper_candidates[1]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(
            paper_candidates[1]["candidate_id"], "3e49d7da73ac2456c3eecb02"
        )
        self.assertEqual(
            paper_candidates[0]["paper_probation_scope"], "evidence_collection_only"
        )
        self.assertEqual(paper_candidates[0]["proof_mode"], "probation")
        self.assertTrue(paper_candidates[0]["evidence_collection_ok"])
        self.assertTrue(paper_candidates[0]["canary_collection_authorized"])
        self.assertTrue(paper_candidates[0]["bounded_live_paper_collection_authorized"])
        self.assertFalse(paper_candidates[0]["capital_promotion_allowed"])
        self.assertFalse(paper_candidates[0]["final_authority_ok"])
        self.assertFalse(paper_candidates[0]["final_promotion_allowed"])
        self.assertTrue(paper_candidates[0]["bounded_evidence_collection_authorized"])
        self.assertEqual(paper_candidates[0]["target_notional"], "25")
        self.assertEqual(paper_candidates[0]["max_notional"], "25")
        import_plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertIsInstance(import_plan, dict)
        self.assertEqual(
            import_plan["schema_version"],
            "torghut.runtime-ledger-paper-probation-import-plan.v1",
        )
        self.assertEqual(import_plan["target_count"], 2)
        self.assertEqual(import_plan["skipped_target_count"], 0)
        self.assertEqual(import_plan["proof_mode"], "probation")
        self.assertTrue(import_plan["evidence_collection_ok"])
        self.assertTrue(import_plan["canary_collection_authorized"])
        self.assertTrue(import_plan["bounded_live_paper_collection_authorized"])
        self.assertFalse(import_plan["capital_promotion_allowed"])
        self.assertFalse(import_plan["final_authority_ok"])
        self.assertFalse(import_plan["final_promotion_allowed"])
        target = import_plan["targets"][0]
        self.assertEqual(target["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(target["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(target["observed_stage"], "paper")
        self.assertEqual(target["strategy_family"], "microbar_cross_sectional_pairs")
        self.assertEqual(target["strategy_name"], "microbar-pairs-vwap-cap-safe")
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-pairs-vwap-cap-safe"
        )
        self.assertIn("microbar-pairs-vwap-cap-safe", target["strategy_lookup_names"])
        self.assertEqual(target["account_label"], "TORGHUT_SIM")
        self.assertEqual(
            import_plan["targets"][1]["candidate_id"], "3e49d7da73ac2456c3eecb02"
        )
        self.assertEqual(
            import_plan["targets"][1]["strategy_name"],
            "microbar-pairs-vwap-reversal",
        )
        self.assertEqual(
            target["source_dsn_env"], "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN"
        )
        self.assertEqual(target["source_kind"], "durable_runtime_ledger_bucket")
        self.assertEqual(
            target["source_manifest_ref"], "config/trading/hypotheses/h-pairs-01.json"
        )
        self.assertEqual(
            target["dataset_snapshot_ref"], "portfolio-profit-autoresearch-500-v1"
        )
        self.assertEqual(target["paper_probation_authorized"], True)
        self.assertEqual(
            target["paper_probation_authorization_scope"],
            "evidence_collection_only",
        )
        self.assertEqual(target["proof_mode"], "probation")
        self.assertTrue(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["canary_collection_authorized"])
        self.assertTrue(target["bounded_live_paper_collection_authorized"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(target["target_notional"], "25")
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "25")
        self.assertEqual(target["max_notional"], "25")
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["final_authority_ok"])
        self.assertEqual(target["promotion_allowed"], False)
        self.assertEqual(target["final_promotion_authorized"], False)
        self.assertEqual(target["final_promotion_allowed"], False)
        self.assertIn("runtime_ledger_stage_not_live", target["candidate_blockers"])
        self.assertIn(
            "live_runtime_ledger_required", target["final_promotion_blockers"]
        )
        self.assertEqual(
            target["source_window_ids"],
            ["pairs-source-window-buy", "pairs-source-window-sell"],
        )
        self.assertEqual(
            target["trade_decision_ids"],
            ["pairs-decision-buy", "pairs-decision-sell"],
        )
        self.assertEqual(
            target["execution_ids"],
            ["pairs-execution-buy", "pairs-execution-sell"],
        )
        self.assertEqual(
            target["execution_order_event_ids"],
            ["pairs-event-new-buy", "pairs-event-fill-buy"],
        )
        self.assertEqual(
            target["source_offsets"], pairs_source_payload["source_offsets"]
        )
        self.assertEqual(target["source_materialization"], "execution_order_events")
        self.assertEqual(
            target["authority_class"], "runtime_order_feed_execution_source"
        )
        self.assertEqual(
            target["authority_reason"], "event_sourced_runtime_ledger_profit_proof"
        )
        self.assertNotIn("runtime_ledger_artifact_refs", target)
        self.assertNotIn("runtime_ledger_artifact_row_count", target)
        self.assertEqual(candidates[1]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(candidates[1]["candidate_id"], "3e49d7da73ac2456c3eecb02")
        self.assertTrue(
            any(candidate["hypothesis_id"] == "H-CONT-01" for candidate in candidates)
        )

    def test_runtime_ledger_repair_reason_codes_require_source_authority(self) -> None:
        payload = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "fill_count": 2,
            "submitted_order_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "127090.02495200",
            "net_strategy_pnl_after_costs": "567.44720578",
            "post_cost_expectancy_bps": "44.64923238",
            "ledger_schema_version": "torghut.runtime-ledger-bucket.v1",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "blockers": [],
        }

        reasons = _runtime_ledger_repair_reason_codes(
            payload,
            manifest={"candidate_id": "c88421d619759b2cfaa6f4d0"},
        )

        self.assertIn("runtime_ledger_source_window_missing", reasons)
        self.assertIn("runtime_ledger_source_refs_missing", reasons)
        self.assertIn("runtime_ledger_source_window_ids_missing", reasons)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", reasons)
        self.assertIn("runtime_ledger_source_offsets_missing", reasons)
        self.assertIn("runtime_ledger_stage_not_live", reasons)

        source_backed_reasons = _runtime_ledger_repair_reason_codes(
            {
                **payload,
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["decision-buy", "decision-sell"],
                "execution_ids": ["execution-buy", "execution-sell"],
                "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
                "source_window_ids": ["source-window-buy", "source-window-sell"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            },
            manifest={"candidate_id": "c88421d619759b2cfaa6f4d0"},
        )

        self.assertNotIn(
            "runtime_ledger_source_window_missing",
            source_backed_reasons,
        )
        self.assertNotIn("runtime_ledger_source_refs_missing", source_backed_reasons)
        self.assertNotIn(
            "runtime_ledger_source_window_ids_missing", source_backed_reasons
        )
        self.assertNotIn(
            "runtime_ledger_execution_order_event_refs_missing",
            source_backed_reasons,
        )
        self.assertEqual(source_backed_reasons, ["runtime_ledger_stage_not_live"])

    def test_paper_probation_blockers_require_source_fills_and_explicit_costs(
        self,
    ) -> None:
        candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_id": "microbar_cross_sectional_pairs_v1@research",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_SIM",
            "observed_stage": "paper",
            "bucket_started_at": "2026-05-29T14:30:00+00:00",
            "bucket_ended_at": "2026-05-29T15:00:00+00:00",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 0,
            "closed_trade_count": 0,
            "open_position_count": 0,
            "filled_notional": "0",
            "net_strategy_pnl_after_costs": "12.50",
            "post_cost_expectancy_bps": "125",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "lineage_hash_counts": {"lineage": 2},
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        blockers = _runtime_ledger_paper_probation_blockers(candidate)

        self.assertIn("runtime_ledger_fills_missing", blockers)
        self.assertIn("runtime_ledger_filled_notional_missing", blockers)
        self.assertIn("runtime_ledger_closed_round_trips_missing", blockers)
        self.assertIn("runtime_ledger_explicit_costs_missing", blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", blockers)
        self.assertIn("runtime_ledger_source_refs_missing", blockers)
        plan = _runtime_ledger_paper_probation_import_plan([candidate])
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertFalse(plan["canary_collection_authorized"])
        self.assertFalse(plan["bounded_live_paper_collection_authorized"])
        skipped = plan["skipped_targets"][0]
        self.assertEqual(
            skipped["reason"],
            "runtime_ledger_paper_probation_prerequisites_not_satisfied",
        )
        self.assertIn("runtime_ledger_source_refs_missing", skipped["blockers"])

        malformed = {
            "observed_stage": "exact_replay",
            "open_position_count": 1,
            "net_strategy_pnl_after_costs": "-1",
            "post_cost_expectancy_bps": "-1",
            "reason_codes": [
                "runtime_ledger_stage_not_live",
                "exact_replay_candidate_only",
            ],
        }

        malformed_blockers = _runtime_ledger_paper_probation_blockers(malformed)

        self.assertIn("exact_replay_candidate_only", malformed_blockers)
        self.assertIn("runtime_ledger_stage_not_paper", malformed_blockers)
        self.assertIn("runtime_ledger_pnl_basis_missing", malformed_blockers)
        self.assertIn("runtime_ledger_decisions_missing", malformed_blockers)
        self.assertIn("runtime_order_lifecycle_missing", malformed_blockers)
        self.assertIn("unclosed_position", malformed_blockers)
        self.assertIn("post_cost_pnl_non_positive", malformed_blockers)
        self.assertIn("post_cost_expectancy_non_positive", malformed_blockers)
        self.assertIn(
            "runtime_ledger_execution_policy_hash_missing", malformed_blockers
        )
        self.assertIn("runtime_ledger_lineage_hash_missing", malformed_blockers)
