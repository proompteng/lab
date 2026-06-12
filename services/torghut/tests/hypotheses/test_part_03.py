from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.hypotheses.support import *


class TestHypothesisReadinessPart3(_TestHypothesisReadinessBase):
    def test_compile_hypothesis_runtime_statuses_blocks_bounded_hpairs_collection_on_stale_signal_lag(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=3,
                evidence_checks=2,
                signal_lag_seconds=9_958,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary=_hpairs_route_repair_tca_summary(),
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
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
        self.assertIn("signal_lag_exceeded", hpairs["reasons"])
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertFalse(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "wait_for_fresh_signal_window",
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_blockers"],
            ["signal_lag_exceeded"],
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_liveness"][
                "fresh_signal_window"
            ],
            False,
        )

    def test_compile_hypothesis_runtime_statuses_does_not_ready_bounded_hpairs_collection_while_market_closed(
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
            tca_summary=_hpairs_route_repair_tca_summary(),
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 23, 17, tzinfo=timezone.utc),
            market_session_open=False,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertFalse(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "wait_for_market_session_open",
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_blockers"],
            ["market_session_closed"],
        )

    def test_compile_hypothesis_runtime_statuses_selects_clean_current_hpairs_route_tca(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=2770,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=14,
            evidence_report={
                "ok": True,
                "checked_at": "2026-06-01T19:15:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "4",
                "avg_realized_shortfall_bps": "1",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
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
        self.assertEqual(observed["tca_order_count"], 2)
        self.assertEqual(observed["route_tca_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(observed["route_tca_repair_symbols"], [])
        self.assertNotIn("route_universe_empty", hpairs["reasons"])

    def test_compile_hypothesis_runtime_statuses_keeps_high_slippage_hpairs_tca_repair_only(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=2770,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=14,
            evidence_report={
                "ok": True,
                "checked_at": "2026-06-01T19:15:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "24.34",
                "avg_realized_shortfall_bps": "24.34",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "24.34",
                        "avg_realized_shortfall_bps": "24.34",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "24.34",
                        "avg_realized_shortfall_bps": "24.34",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_kind": "live_paper_execution_tca",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
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
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertEqual(hpairs["promotion_contract"]["max_avg_abs_slippage_bps"], "8")
        self.assertIn("route_universe_empty", hpairs["reasons"])
        self.assertEqual(observed["tca_order_count"], 0)
        self.assertEqual(observed["route_tca_symbols"], [])
        self.assertEqual(observed["route_tca_repair_symbols"], ["AAPL", "AMZN"])
        self.assertIn(
            "route_tca_avg_abs_slippage_above_guardrail",
            observed["route_tca_blocking_reason_codes"],
        )

    def test_compile_hypothesis_runtime_statuses_blocks_stale_tca_evidence(
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
                "last_computed_at": "2026-03-06T15:00:00+00:00",
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
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("tca_evidence_stale", cont["reasons"])
        self.assertEqual(cont["observed"]["tca_age_minutes"], 60)

    def test_compile_hypothesis_runtime_statuses_demotes_closed_session_freshness_holds(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=9_900,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 120,
                "avg_abs_slippage_bps": 20,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:00:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                "H-MICRO-01",
                "H-BREAKOUT-01",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 10_000},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 23, 0, tzinfo=timezone.utc),
            market_session_open=False,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertNotIn("signal_lag_exceeded", cont["reasons"])
        self.assertNotIn("tca_evidence_stale", cont["reasons"])
        self.assertIn("slippage_budget_exceeded", cont["reasons"])
        self.assertIn("closed_session_signal_hold", cont["informational_reasons"])
        self.assertIn("closed_session_tca_evidence_hold", cont["informational_reasons"])
        self.assertIn(
            "closed_session_runtime_ledger_evidence_hold",
            cont["informational_reasons"],
        )
        self.assertEqual(cont["observed"]["market_session_open"], False)

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
        )
        self.assertEqual(summary["reason_totals"]["slippage_budget_exceeded"], 1)
        self.assertEqual(
            summary["informational_reason_totals"]["closed_session_signal_hold"], 5
        )

    def test_compile_hypothesis_runtime_statuses_reports_closed_session_market_context_hold_for_context_manifest(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-context-01.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-CONTEXT-01",
                        lane_id="context-dependent",
                        strategy_family="context_dependent",
                        required_dependency_capabilities=["market_context_freshness"],
                        candidate_id="candidate-context",
                        strategy_id="context_strategy@paper",
                        max_market_context_freshness_seconds=120,
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

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
                    "order_count": 120,
                    "avg_abs_slippage_bps": 4,
                    "avg_realized_shortfall_bps": -12,
                    "last_computed_at": "2026-03-06T15:00:00+00:00",
                },
                runtime_ledger_summary=_runtime_ledger_summary(
                    "H-CONTEXT-01",
                    candidate_id="candidate-context",
                    submitted_order_count=120,
                    post_cost_expectancy_bps="12",
                ),
                market_context_status={"last_freshness_seconds": 10_000},
                jangar_dependency_quorum=JangarDependencyQuorumStatus(
                    decision="allow",
                    reasons=[],
                    message="ok",
                ),
                now=datetime(2026, 3, 6, 23, 0, tzinfo=timezone.utc),
                market_session_open=False,
            )

        context_status = statuses[0]
        self.assertEqual(context_status["hypothesis_id"], "H-CONTEXT-01")
        self.assertNotIn("market_context_stale", context_status["reasons"])
        self.assertIn(
            "closed_session_market_context_hold",
            context_status["informational_reasons"],
        )

    def test_compile_hypothesis_runtime_statuses_isolates_dependency_capabilities_between_hypotheses(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-a.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-A-01",
                        lane_id="lane-a",
                        strategy_family="lanes-scope-a",
                        required_dependency_capabilities=[
                            "jangar_dependency_quorum",
                            "signal_continuity",
                        ],
                        required_feature_rows=True,
                    ),
                ),
                encoding="utf-8",
            )
            (root / "h-b.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-B-01",
                        lane_id="lane-b",
                        strategy_family="lanes-scope-b",
                        required_dependency_capabilities=["feature_coverage"],
                        required_feature_rows=True,
                        initial_state="blocked",
                    ),
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)

            registry = load_hypothesis_registry()
            self.assertTrue(registry.loaded)
            self.assertEqual(len(registry.items), 2)
            self.assertEqual(len(registry.errors), 0)

            statuses = compile_hypothesis_runtime_statuses(
                registry=registry,
                state=_state(
                    feature_rows=5,
                    drift_checks=3,
                    evidence_checks=2,
                    signal_lag_seconds=15,
                    signal_continuity_alert_active=True,
                    evidence_report={
                        "ok": True,
                        "checked_at": "2026-03-06T15:45:00+00:00",
                    },
                ),
                tca_summary={
                    "order_count": 45,
                    "avg_abs_slippage_bps": 4,
                    "avg_realized_shortfall_bps": -8,
                    "last_computed_at": "2026-03-06T15:50:00+00:00",
                },
                market_context_status={"last_freshness_seconds": 60},
                jangar_dependency_quorum=JangarDependencyQuorumStatus(
                    decision="delay",
                    reasons=["workflow_backoff_warning"],
                    message="degraded",
                ),
                now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            )

        status_a = next(item for item in statuses if item["hypothesis_id"] == "H-A-01")
        status_b = next(item for item in statuses if item["hypothesis_id"] == "H-B-01")
        self.assertIn("jangar_dependency_delay", status_a["reasons"])
        self.assertIn("signal_continuity_alert_active", status_a["reasons"])
        self.assertNotIn("jangar_dependency_delay", status_b["reasons"])
        self.assertNotIn("signal_continuity_alert_active", status_b["reasons"])
        self.assertIn("dependency_capabilities", status_a)
        self.assertIn("required", status_a["dependency_capabilities"])
        self.assertEqual(
            status_a["dependency_capabilities"]["required"],
            ["jangar_dependency_quorum", "signal_continuity"],
        )

    def test_compile_hypothesis_runtime_statuses_projects_manifest_lineage(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-micro.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-MICRO-01",
                        lane_id="microstructure-breakout",
                        strategy_family="microstructure_breakout",
                        candidate_id="chip-paper-microbar-composite@execution-proof",
                        strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
                        dataset_snapshot_ref="torghut-chip-full-day-20260505-4c330ce9-r1",
                        required_dependency_capabilities=[],
                        required_feature_rows=False,
                        require_drift_checks=False,
                        require_evidence_continuity=False,
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

            statuses = compile_hypothesis_runtime_statuses(
                registry=registry,
                state=_state(signal_lag_seconds=15),
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

        micro = statuses[0]
        self.assertEqual(
            micro["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            micro["strategy_id"],
            "microbar_volume_continuation_long_top2_chip_v1@paper",
        )
        self.assertEqual(
            micro["dataset_snapshot_ref"],
            "torghut-chip-full-day-20260505-4c330ce9-r1",
        )
        self.assertEqual(
            micro["lineage_ref"],
            {
                "status": "manifest_declared",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "hypothesis_id": "H-MICRO-01",
                "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                "lane_id": "microstructure-breakout",
                "strategy_family": "microstructure_breakout",
            },
        )

    def test_summarize_hypothesis_runtime_statuses_reports_state_totals(self) -> None:
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
                decision="unknown",
                reasons=["jangar_control_plane_status_url_missing"],
                message="not configured",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        summary = summarize_hypothesis_runtime_statuses(
            statuses,
            registry=registry,
            dependency_quorum=JangarDependencyQuorumStatus(
                decision="unknown",
                reasons=["jangar_control_plane_status_url_missing"],
                message="not configured",
            ),
        )

        self.assertEqual(summary["hypotheses_total"], 5)
        self.assertEqual(
            summary["candidate_dossier_version"],
            "torghut.hypothesis-candidate-dossier.v1",
        )
        self.assertEqual(len(summary["ranked_candidates"]), 5)
        self.assertIsNotNone(summary["selected_candidate"])
        self.assertEqual(summary["selected_candidate"]["hypothesis_id"], "H-MICRO-01")
        self.assertEqual(
            summary["selected_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            summary["selected_candidate"]["next_blocker"],
            "delay_adjusted_depth_stress_missing",
        )
        self.assertEqual(summary["state_totals"], {"blocked": 4, "shadow": 1})
        self.assertEqual(summary["capital_stage_totals"], {"shadow": 5})
        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["rollback_required_total"], 0)
        self.assertEqual(
            summary["dependency_quorum"],
            {
                "decision": "unknown",
                "reasons": ["jangar_control_plane_status_url_missing"],
                "message": "not configured",
            },
        )

    def test_load_hypothesis_registry_fails_closed_on_duplicate_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            duplicate_payload = {
                "schema_version": "torghut.hypothesis-manifest.v1",
                "hypothesis_id": "H-CONT-01",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "initial_state": "shadow",
                "expected_gross_edge_bps": "6",
                "max_allowed_slippage_bps": "12",
                "min_sample_count_for_live_canary": 40,
                "min_sample_count_for_scale_up": 80,
                "max_rolling_drawdown_bps": "150",
            }
            (root / "one.json").write_text(
                json.dumps(duplicate_payload), encoding="utf-8"
            )
            (root / "two.json").write_text(
                json.dumps(duplicate_payload), encoding="utf-8"
            )
            settings.trading_hypothesis_registry_path = str(root)

            result = load_hypothesis_registry()

        self.assertFalse(result.loaded)
        self.assertEqual(result.items, [])
        self.assertEqual(len(result.errors), 1)
        self.assertIn("duplicate hypothesis_id H-CONT-01", result.errors[0])

    def test_default_hypothesis_registry_self_governs_without_jangar_quorum(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        registry = load_hypothesis_registry()

        self.assertTrue(registry.loaded)
        self.assertFalse(
            hypothesis_registry_requires_dependency_capability(
                registry,
                "jangar_dependency_quorum",
            )
        )
        with patch("app.trading.hypotheses.urlopen") as urlopen_mock:
            status = resolve_hypothesis_dependency_quorum(registry)

        urlopen_mock.assert_not_called()
        self.assertEqual(status.decision, "allow")
        self.assertEqual(status.reasons, ["torghut_dependency_quorum_not_required"])

    def test_hypothesis_registry_dependency_check_rejects_blank_capability(
        self,
    ) -> None:
        registry = load_hypothesis_registry()

        self.assertFalse(
            hypothesis_registry_requires_dependency_capability(registry, "")
        )

    def test_resolve_hypothesis_dependency_quorum_fetches_when_manifest_requires_it(
        self,
    ) -> None:
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0
        settings.trading_jangar_control_plane_timeout_seconds = 1.0
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "h-cont-01.json").write_text(
                json.dumps(
                    _hypothesis_manifest_payload(
                        hypothesis_id="H-CONT-01",
                        lane_id="continuation",
                        strategy_family="intraday_continuation",
                        required_dependency_capabilities=[
                            "jangar_dependency_quorum",
                            "signal_continuity",
                        ],
                    )
                ),
                encoding="utf-8",
            )
            settings.trading_hypothesis_registry_path = str(root)
            registry = load_hypothesis_registry()

        self.assertTrue(
            hypothesis_registry_requires_dependency_capability(
                registry,
                "jangar_dependency_quorum",
            )
        )
        with patch(
            "app.trading.hypotheses.urlopen",
            return_value=_FakeHttpResponse(
                {
                    "dependency_quorum": {
                        "decision": "delay",
                        "reasons": ["workflow_backoff_warning"],
                        "message": "degraded",
                    }
                }
            ),
        ) as urlopen_mock:
            status = resolve_hypothesis_dependency_quorum(registry)

        urlopen_mock.assert_called_once()
        self.assertEqual(status.decision, "delay")
        self.assertEqual(status.reasons, ["workflow_backoff_warning"])
