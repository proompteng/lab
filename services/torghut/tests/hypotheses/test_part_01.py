from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.hypotheses.support import *


class TestHypothesisReadinessPart1(_TestHypothesisReadinessBase):
    def test_route_tca_helper_edge_cases_are_defensive(self) -> None:
        self.assertIsNone(_optional_decimal(None))
        self.assertEqual(_optional_decimal(Decimal("1.25")), Decimal("1.25"))
        self.assertEqual(_optional_decimal("2.50"), Decimal("2.50"))
        self.assertIsNone(_optional_decimal("not-a-decimal"))
        self.assertIsNone(_optional_decimal([]))
        self.assertIsNone(_optional_bool(None))
        self.assertTrue(_optional_bool(True))
        self.assertFalse(_optional_bool(False))
        self.assertTrue(_optional_bool(1))
        self.assertFalse(_optional_bool(0))
        self.assertTrue(_optional_bool("passed"))
        self.assertFalse(_optional_bool("blocked"))
        self.assertIsNone(_optional_bool("unknown"))
        self.assertEqual(_sequence("AAPL"), ())
        self.assertIsNone(
            _weighted_decimal_average(
                [{"order_count": 0, "avg_abs_slippage_bps": Decimal("4")}],
                "avg_abs_slippage_bps",
            )
        )
        self.assertIsNone(
            _weighted_decimal_average(
                [{"order_count": 2, "avg_abs_slippage_bps": None}],
                "avg_abs_slippage_bps",
            )
        )

    def test_load_hypothesis_registry_reads_directory_payloads(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-cont-01.json").write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.hypothesis-manifest.v1",
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "paper_probation_candidate_ids": [
                            " secondary-candidate ",
                            "primary-candidate",
                            "primary-candidate",
                        ],
                        "initial_state": "shadow",
                        "expected_gross_edge_bps": "6",
                        "max_allowed_slippage_bps": "12",
                        "min_sample_count_for_live_canary": 40,
                        "min_sample_count_for_scale_up": 80,
                        "max_rolling_drawdown_bps": "150",
                    }
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertTrue(result.loaded)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].hypothesis_id, "H-CONT-01")
        self.assertEqual(
            result.items[0].paper_probation_candidate_ids,
            ["primary-candidate", "secondary-candidate"],
        )
        self.assertEqual(result.errors, [])

    def test_compile_hypothesis_runtime_statuses_stays_shadow_without_feature_and_evidence(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("feature_rows_missing", cont["reasons"])
        self.assertNotIn("evidence_continuity_missing", cont["reasons"])
        self.assertNotIn("drift_checks_missing", cont["reasons"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("required_feature_set_unavailable", micro["reasons"])

    def test_compile_hypothesis_runtime_statuses_uses_persisted_feature_readiness(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(feature_rows=0),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={"equity_ta_rows": 12, "equity_ta_symbols": 6},
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertNotIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("feature_rows_missing", micro["reasons"])
        self.assertNotIn("required_feature_set_unavailable", micro["reasons"])
        self.assertNotIn("signal_lag_exceeded", micro["reasons"])
        self.assertEqual(cont["observed"]["signal_lag_seconds"], None)
        self.assertEqual(cont["observed"]["feature_batch_rows_total"], 12)

    def test_compile_hypothesis_runtime_statuses_uses_persisted_drift_readiness(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(feature_rows=12, drift_checks=0),
            tca_summary={
                "order_count": 0,
                "avg_abs_slippage_bps": 0,
                "avg_realized_shortfall_bps": 0,
            },
            market_context_status={"last_freshness_seconds": None},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={"drift_detection_checks_total": 3},
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertNotIn("drift_checks_missing", micro["reasons"])
        self.assertEqual(micro["observed"]["drift_detection_checks_total"], 3)

    def test_compile_hypothesis_runtime_statuses_promotes_canary_when_thresholds_are_met(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "canary_live")
        self.assertEqual(cont["capital_stage"], "0.25x canary")
        self.assertEqual(cont["capital_multiplier"], "0.25")
        self.assertTrue(cont["promotion_eligible"])
        self.assertEqual(cont["observed"]["tca_age_minutes"], 10)

    def test_compile_hypothesis_runtime_statuses_requires_live_runtime_ledger_profit_authority(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                observed_stage="paper",
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("runtime_ledger_stage_not_live", cont["reasons"])
        self.assertEqual(cont["observed"]["runtime_ledger_observed_stage"], "paper")
        self.assertNotIn("post_cost_expectancy_non_positive", cont["reasons"])

    def test_compile_hypothesis_runtime_statuses_blocks_stale_runtime_ledger_profit_authority(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T16:35:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T16:35:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 40, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertEqual(cont["state"], "shadow")
        self.assertIn("runtime_ledger_evidence_stale", cont["reasons"])
        self.assertEqual(cont["observed"]["runtime_ledger_age_minutes"], 45)

    def test_compile_hypothesis_runtime_statuses_blocks_runtime_ledger_missing_window_bounds(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-CONT-01": {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-CONT-01"],
                        "observed_stage": "live",
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"],
                        "submitted_order_count": 45,
                        "closed_trade_count": 8,
                        "filled_notional": "100000",
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                }
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertIn("runtime_ledger_window_bounds_missing", cont["reasons"])
        self.assertIsNone(cont["observed"]["runtime_ledger_bucket_started_at"])
        self.assertIsNone(cont["observed"]["runtime_ledger_bucket_ended_at"])

    def test_htsmom_liq_manifest_keeps_candidate_identity_but_blocks_paper_ledger(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        liq_manifest = next(
            item for item in registry.items if item.hypothesis_id == "H-TSMOM-LIQ-01"
        )
        self.assertEqual(liq_manifest.candidate_id, "H-TSMOM-LIQ-01")
        self.assertIn(
            "ca4e6e3c7d639e3363dc5860",
            liq_manifest.paper_probation_candidate_ids,
        )
        self.assertEqual(liq_manifest.strategy_family, "intraday_tsmom_consistent")

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=5,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=15,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-03-06T15:45:00+00:00",
                },
            ),
            tca_summary={
                "order_count": 90,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-TSMOM-LIQ-01",
                submitted_order_count=90,
                observed_stage="paper",
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        liq = next(
            item for item in statuses if item["hypothesis_id"] == "H-TSMOM-LIQ-01"
        )
        self.assertFalse(liq["promotion_eligible"])
        self.assertIn("runtime_ledger_stage_not_live", liq["reasons"])
        self.assertNotIn("runtime_ledger_candidate_id_mismatch", liq["reasons"])

    def test_hpairs_manifest_declares_balanced_evidence_universe(self) -> None:
        registry = load_hypothesis_registry()
        hpairs_manifest = next(
            item for item in registry.items if item.hypothesis_id == "H-PAIRS-01"
        )

        self.assertEqual(hpairs_manifest.evidence_universe_symbols, ["AAPL", "AMZN"])
        self.assertTrue(hpairs_manifest.require_pair_balance)

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=5,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=15,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:45:00+00:00",
                },
            ),
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "3",
                "last_computed_at": "2026-06-01T19:50:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "3",
                        "last_computed_at": "2026-06-01T19:50:00+00:00",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "3",
                        "last_computed_at": "2026-06-01T19:50:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 55, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )
        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )

        self.assertEqual(
            hpairs["lineage_ref"]["evidence_universe_symbols"], ["AAPL", "AMZN"]
        )
        self.assertTrue(hpairs["lineage_ref"]["require_pair_balance"])
        observed = hpairs["observed"]
        self.assertEqual(observed["evidence_universe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(observed["evidence_universe_symbol_count"], 2)
        self.assertEqual(observed["pair_contract_blockers"], [])

    def test_hpairs_route_tca_ignores_unrelated_tsmom_symbols_without_lineage(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=14,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 4,
                "avg_abs_slippage_bps": "12",
                "avg_realized_shortfall_bps": "1",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 0,
                        "avg_abs_slippage_bps": None,
                        "avg_realized_shortfall_bps": None,
                        "last_computed_at": None,
                    },
                    {
                        "symbol": "INTC",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "2",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                    },
                    {
                        "symbol": "NVDA",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "2",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertEqual(observed["route_tca_symbols"], ["AAPL"])
        self.assertEqual(observed["route_tca_repair_symbols"], ["AMZN"])
        self.assertEqual(observed["route_tca_excluded_symbol_count"], 2)
        self.assertIn(
            "route_tca_out_of_scope_symbol",
            observed["route_tca_blocking_reason_codes"],
        )
        diagnostic_symbols = [
            diagnostic["symbol"]
            for diagnostic in observed["route_tca_symbol_diagnostics"]
        ]
        self.assertEqual(diagnostic_symbols, ["AAPL", "AMZN"])

    def test_pairs_manifest_fails_closed_without_balanced_evidence_universe(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            manifest_path = Path(tmpdir) / "h-pairs-incomplete.json"
            manifest_path.write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-PAIRS-INCOMPLETE",
                        lane_id="microbar-cross-sectional-pairs",
                        strategy_family="microbar_cross_sectional_pairs",
                        required_dependency_capabilities=[],
                        candidate_id="candidate-h-pairs-incomplete",
                        strategy_id="microbar_cross_sectional_pairs_v1@research",
                        initial_state="blocked",
                    )
                ),
                encoding="utf-8",
            )
            registry = load_hypothesis_registry(path_value=str(manifest_path))

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=5,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=15,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:45:00+00:00",
                },
            ),
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "3",
                "last_computed_at": "2026-06-01T19:50:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-PAIRS-INCOMPLETE": {
                        "hypothesis_id": "H-PAIRS-INCOMPLETE",
                        "candidate_id": "candidate-h-pairs-incomplete",
                        "observed_stage": "live",
                        "bucket_started_at": "2026-06-01T19:00:00+00:00",
                        "bucket_ended_at": "2026-06-01T19:45:00+00:00",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "fill_count": 120,
                        "submitted_order_count": 120,
                        "closed_trade_count": 60,
                        "open_position_count": 0,
                        "filled_notional": "100000",
                        "net_strategy_pnl_after_costs": "100",
                        "post_cost_expectancy_bps": "12",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                }
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 55, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = statuses[0]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertEqual(hpairs["state"], "blocked")
        self.assertIn("evidence_universe_symbols_missing", hpairs["reasons"])
        self.assertIn("pair_balance_not_declared", hpairs["reasons"])
        self.assertEqual(
            hpairs["observed"]["pair_contract_blockers"],
            ["evidence_universe_symbols_missing", "pair_balance_not_declared"],
        )

    def test_compile_hypothesis_runtime_statuses_prefers_target_live_bucket_over_newer_paper(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        candidate_id = _MANIFEST_CANDIDATE_IDS["H-CONT-01"]
        strategy_family = _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"]
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-CONT-01": {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": candidate_id,
                        "observed_stage": "paper",
                        "strategy_family": strategy_family,
                        "bucket_started_at": "2026-03-06T15:45:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:55:00+00:00",
                        "submitted_order_count": 45,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                },
                "runtime_ledger_buckets": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": candidate_id,
                        "observed_stage": "live",
                        "strategy_family": strategy_family,
                        "bucket_started_at": "2026-03-06T15:15:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:30:00+00:00",
                        "submitted_order_count": 45,
                        "closed_trade_count": 8,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                    }
                ],
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertTrue(cont["promotion_eligible"])
        self.assertEqual(cont["observed"]["runtime_ledger_observed_stage"], "live")
        self.assertEqual(
            cont["observed"]["runtime_ledger_bucket_ended_at"],
            "2026-03-06T15:30:00+00:00",
        )

    def test_compile_hypothesis_runtime_statuses_blocks_mismatched_runtime_ledger_candidate(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                candidate_id="unrelated-candidate",
                submitted_order_count=45,
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertIn("runtime_ledger_candidate_id_mismatch", cont["reasons"])
        self.assertEqual(
            cont["observed"]["runtime_ledger_candidate_id"], "unrelated-candidate"
        )
