from __future__ import annotations

from tests.assemble_runtime_ledger_proof_packet.support import (
    Decimal,
    _TestRuntimeLedgerProofPacketBase,
    _completion,
    _paper_route_evidence,
    _runtime_import,
    _status,
    json,
    packet,
)


class TestAuthorityOneDayBlockersAreStableJsonCodes(_TestRuntimeLedgerProofPacketBase):
    def test_authority_one_day_blockers_are_stable_json_codes(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(trading_days=1, net_pnl="600"),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertFalse(result["final_authority_ok"])
        self.assertEqual(
            result["checks"]["runtime_ledger_post_cost_profit_target"]["blockers"],
            [
                "runtime_ledger_net_pnl_below_target",
                "runtime_ledger_trading_days_below_target",
            ],
        )
        self.assertIn(
            "runtime_ledger_trading_days_below_target",
            result["authority_blockers"],
        )
        json_payload = json.loads(json.dumps(result, sort_keys=True))
        self.assertEqual(
            json_payload["checks"]["runtime_ledger_post_cost_profit_target"][
                "blockers"
            ],
            [
                "runtime_ledger_net_pnl_below_target",
                "runtime_ledger_trading_days_below_target",
            ],
        )

    def test_packet_waits_before_paper_route_window_is_importable(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(
                import_ready=False,
                import_blockers=["paper_route_session_window_not_open"],
            ),
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["promotion_authority"]["blocking_reasons"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertFalse(
            result["checks"]["runtime_window_import_proof"]["observed"][
                "runtime_import_due"
            ]
        )

    def test_waiting_packet_prioritizes_wait_action_over_drift_repair(
        self,
    ) -> None:
        evidence = _paper_route_evidence(
            import_ready=False,
            import_blockers=["paper_route_session_window_not_open"],
        )
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["drift_ok"] = "false"
        target["drift_reason"] = "drift_live_promotion_ineligible"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "drift_ok": "false",
            "drift_reason": "drift_live_promotion_ineligible",
            "blockers": [],
            "promotion_blockers": ["drift_checks_not_ok"],
        }
        target["runtime_window_import_health_gate_blockers"] = []

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=evidence,
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertIn(
            "drift_checks_not_ok",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertNotIn(
            "repair_runtime_window_import_health_gate",
            result["required_actions"],
        )

    def test_waiting_packet_defers_doc29_completion_blockers_until_import_due(
        self,
    ) -> None:
        completion = _completion(status="blocked")
        gate = completion["gates"][0]
        assert isinstance(gate, dict)
        gate["blocking_reasons"] = ["live_scale_runtime_ledger_summary_incomplete"]
        gate["blocked_reason"] = "live_canary_not_satisfied"

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(
                import_ready=False,
                import_blockers=["paper_route_session_window_not_open"],
            ),
            completion_status=completion,
            generated_at="2026-05-25T21:05:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["post_cost_proof_authority"]["blocking_reasons"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_regular_session_runtime_window"],
        )
        self.assertEqual(
            result["checks"]["doc29_live_scale_gate"]["status"],
            "deferred_until_paper_route_runtime_window_import_is_due",
        )
        self.assertEqual(
            result["checks"]["doc29_live_scale_gate"]["observed"]["blockers"],
            [
                "live_scale_runtime_ledger_summary_incomplete",
                "live_canary_not_satisfied",
            ],
        )
        self.assertNotIn(
            "live_canary_not_satisfied",
            result["post_cost_proof_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_with_source_activity_audit_before_generic_import_missing(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                import_audit={
                    "schema_version": (
                        "torghut.paper-route-runtime-window-import-audit.v1"
                    ),
                    "state": "import_due_source_activity_missing",
                    "next_action": "inspect_paper_route_source_activity_before_import",
                    "import_ready": True,
                    "blockers": [
                        "paper_route_source_activity_missing",
                        "source_decisions_missing",
                        "source_executions_missing",
                        "source_tca_missing",
                    ],
                    "target_blockers": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "c88421d619759b2cfaa6f4d0",
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "blockers": [
                                "source_decisions_missing",
                                "runtime_ledger_bucket_missing",
                            ],
                        }
                    ],
                    "counts": {
                        "source_plan_target_count": 1,
                        "next_runtime_window_target_count": 1,
                        "targets_with_source_activity": 0,
                        "targets_with_runtime_ledger": 0,
                        "targets_with_evidence_grade_runtime_ledger": 0,
                        "targets_with_promotion_decision": 0,
                    },
                },
            ),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "paper_route_source_activity",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "paper_route_source_activity_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "source_decisions_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "inspect_paper_route_source_activity_before_import",
            result["required_actions"],
        )
        self.assertEqual(
            result["checks"]["runtime_window_import_proof"]["observed"][
                "import_audit_state"
            ],
            "import_due_source_activity_missing",
        )
        self.assertEqual(
            result["evidence"]["paper_route_runtime_window_import_audit"]["state"],
            "import_due_source_activity_missing",
        )
        self.assertEqual(
            result["evidence"]["paper_route_runtime_window_import_audit"][
                "target_blockers"
            ][0]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )
        self.assertEqual(
            result["checks"]["paper_route_runtime_window_import_audit"]["observed"][
                "target_blockers"
            ][0]["paper_route_probe_symbols"],
            ["AAPL", "AMZN"],
        )

    def test_packet_requires_import_audit_when_paper_route_import_is_due(
        self,
    ) -> None:
        paper = _paper_route_evidence(import_ready=True)
        paper.pop("runtime_window_import_audit")

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=paper,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_window_import_audit_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "inspect_paper_route_evidence_audit",
            result["required_actions"],
        )

    def test_packet_blocks_when_paper_route_import_health_gate_is_not_ready(
        self,
    ) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["dependency_quorum_decision"] = "missing"
        target["continuity_ok"] = "false"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "missing",
            "continuity_ok": "false",
            "drift_ok": "true",
            "blockers": ["dependency_quorum_not_allow", "continuity_not_ok"],
        }
        target["runtime_window_import_health_gate_blockers"] = [
            "dependency_quorum_not_allow",
            "continuity_not_ok",
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "paper_route_import_health_gate",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "dependency_quorum_not_allow",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "repair_runtime_window_import_health_gate",
            result["required_actions"],
        )
        health_gate = result["evidence"]["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 0)
        self.assertEqual(health_gate["blocked_target_count"], 1)

    def test_packet_treats_drift_only_as_promotion_not_import_blocker(self) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(plan, dict)
        target = plan["targets"][0]
        assert isinstance(target, dict)
        target["continuity_reason"] = "signal_continuity_nominal"
        target["drift_ok"] = "false"
        target["drift_reason"] = "drift_live_promotion_ineligible"
        target["runtime_window_import_health_gate"] = {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "dependency_quorum_decision": "allow",
            "continuity_ok": "true",
            "continuity_reason": "signal_continuity_nominal",
            "drift_ok": "false",
            "drift_reason": "drift_live_promotion_ineligible",
            "blockers": [],
            "promotion_blockers": [],
        }
        target["runtime_window_import_health_gate_blockers"] = []

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=evidence,
            runtime_window_import=_runtime_import(),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["post_cost_proof_authority"]["allowed"], result)
        self.assertFalse(result["promotion_authority"]["allowed"], result)
        self.assertFalse(result["capital_promotion_authority"]["allowed"], result)
        self.assertIn(
            "paper_route_promotion_health_gate",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "drift_not_ok",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "repair_runtime_window_import_health_gate",
            result["required_actions"],
        )
        health_gate = result["evidence"]["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertTrue(health_gate["ready"])
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blocked_target_count"], 0)
        self.assertEqual(health_gate["blockers"], [])
        self.assertEqual(health_gate["promotion_blockers"], ["drift_not_ok"])
        self.assertEqual(
            health_gate["continuity_reasons"], ["signal_continuity_nominal"]
        )
        self.assertEqual(
            health_gate["drift_reasons"], ["drift_live_promotion_ineligible"]
        )
        self.assertEqual(
            health_gate["targets"][0]["drift_reason"],
            "drift_live_promotion_ineligible",
        )

    def test_packet_blocks_non_authoritative_import_and_weak_daily_profit(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(
                proof_status="blocked",
                proof_blockers=["runtime_without_runtime_ledger_profit_proof"],
                authoritative=False,
            ),
            completion_status=_completion(net_pnl="600", trading_days=3),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_without_runtime_ledger_profit_proof",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_floor",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_missing_runtime_ledger_risk_quality_when_import_due(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                drawdown_pct=None,
                max_intraday_drawdown=None,
                best_day_share=None,
                symbol_concentration_share=None,
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_ledger_risk_quality",
            result["promotion_authority"]["failed_checks"],
        )
        self.assertIn(
            "runtime_ledger_drawdown_pct_equity_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_best_day_share_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_symbol_concentration_share_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "improve_runtime_ledger_drawdown_concentration_or_position_sizing",
            result["required_actions"],
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_risk_quality"]["observed"][
                "drawdown_pct_equity"
            ],
            None,
        )

    def test_packet_blocks_excessive_runtime_ledger_risk_quality(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(),
            completion_status=_completion(
                drawdown_pct="0.13",
                max_intraday_drawdown="1600",
                best_day_share="0.40",
                symbol_concentration_share="0.75",
            ),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn(
            "runtime_ledger_drawdown_pct_equity_above_limit",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_best_day_share_above_limit",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_symbol_concentration_share_above_limit",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_risk_quality"]["expected"],
            {
                "max_drawdown_pct_equity": "0.03",
                "max_intraday_drawdown": "1500",
                "max_best_day_share": "0.25",
                "max_symbol_concentration_share": "0.35",
            },
        )

    def test_packet_blocks_incomplete_identity_unbacked_refs_and_lifecycle_gaps(
        self,
    ) -> None:
        paper = _paper_route_evidence()
        target = paper["next_paper_route_runtime_window_targets"]["targets"][0]
        assert isinstance(target, dict)
        target["candidate_id"] = ""
        completion = _completion(
            status="blocked",
            net_pnl="bad",
            trading_days=0,
            expectancy_bps="0",
            ledger_refs=[],
            unbacked_refs=["hypothesis_metric_windows:H-PAIRS-01:2026-05-26"],
        )
        gate = completion["gates"][0]
        assert isinstance(gate, dict)
        gate["blocking_reasons"] = ["live_scale_runtime_ledger_summary_incomplete"]
        gate["blocked_reason"] = "live_canary_not_satisfied"
        summary = gate["runtime_ledger_summary"]
        assert isinstance(summary, dict)
        summary["runtime_ledger_bucket_count"] = 0
        summary["runtime_ledger_fill_count"] = 0
        summary["runtime_ledger_closed_trade_count"] = 0
        summary["runtime_ledger_filled_notional"] = "0"

        result = packet.build_runtime_ledger_proof_packet(
            _status(blockers=["simple_submit_disabled"]),
            proof_mode="authority",
            paper_route_evidence=paper,
            runtime_window_import={"runtime_window_import": _runtime_import()},
            completion_status=completion,
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=1,
            generated_at="2026-05-26T21:05:00+00:00",
        )

        blockers = result["promotion_authority"]["blocking_reasons"]
        self.assertEqual(result["verdict"], "blocked")
        self.assertIn("simple_submit_disabled", blockers)
        self.assertIn("paper_route_target_identity_incomplete", blockers)
        self.assertIn("live_scale_runtime_ledger_summary_incomplete", blockers)
        self.assertIn("live_canary_not_satisfied", blockers)
        self.assertIn("runtime_ledger_db_refs_missing_or_unbacked", blockers)
        self.assertIn("runtime_ledger_bucket_count_zero", blockers)
        self.assertIn("runtime_ledger_fill_count_zero", blockers)
        self.assertIn("runtime_ledger_closed_trade_count_zero", blockers)
        self.assertIn("runtime_ledger_filled_notional_missing", blockers)
        self.assertIn("runtime_ledger_post_cost_expectancy_not_positive", blockers)
        self.assertIn("runtime_ledger_net_pnl_below_target", blockers)
        self.assertIn("runtime_ledger_trading_days_below_target", blockers)
        self.assertIn(
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_floor", blockers
        )
        self.assertIn(
            "keep_promotion_blocked_until_live_gate_and_proof_floor_pass",
            result["required_actions"],
        )
        self.assertIn(
            "repair_runtime_ledger_lifecycle_cost_or_lineage_evidence",
            result["required_actions"],
        )
        self.assertIn(
            "collect_or_improve_post_cost_runtime_profit_evidence",
            result["required_actions"],
        )

    def test_packet_surfaces_runtime_import_materialization_summary(self) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation.update(
            {
                "runtime_ledger_tca_row_count": 2,
                "runtime_ledger_tca_runtime_bucket_row_count": 1,
                "runtime_ledger_tca_profit_proof_count": 1,
                "runtime_ledger_tca_authoritative_bucket_count": 1,
                "runtime_ledger_source_execution_materialized_bucket_count": 1,
                "runtime_ledger_execution_reconstruction_bucket_count": 0,
                "runtime_ledger_materialization_pnl_derivations": [
                    "source_execution_lifecycle_materialized_runtime_ledger"
                ],
                "runtime_ledger_materialization_blockers": [],
            }
        )

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertTrue(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(
            materialization[
                "runtime_ledger_source_execution_materialized_bucket_count"
            ],
            1,
        )
        self.assertEqual(
            materialization["authoritative_runtime_ledger_profit_proof_count"],
            1,
        )
        self.assertEqual(
            materialization["non_authoritative_runtime_ledger_profit_proof_count"],
            0,
        )
        self.assertEqual(
            materialization["pnl_derivations"],
            ["source_execution_lifecycle_materialized_runtime_ledger"],
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 0)
        self.assertEqual(
            materialization["materialized_targets"][0]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )
        self.assertTrue(materialization["materialized_targets"][0]["materialized"])
        self.assertEqual(
            materialization["materialized_targets"][0]["readback"][
                "runtime_ledger_bucket_refs"
            ],
            ["strategy_runtime_ledger_buckets:runtime-ledger-bucket-1"],
        )
        self.assertEqual(
            materialization["materialized_targets"][0]["readback"]["source_refs"],
            [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        self.assertEqual(
            materialization["materialized_targets"][0][
                "runtime_ledger_profit_distance_readback"
            ]["observed_mean_daily_net_pnl"],
            "650",
        )

    def test_packet_blocks_authority_when_runtime_import_readback_missing(self) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(readback=False),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_window_import_readback_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_window_import_readback_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_authority_when_runtime_import_readback_lacks_source_refs(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        target = runtime_import["imports"][0]["summary"][
            "runtime_materialization_target"
        ]
        assert isinstance(target, dict)
        readback = target["readback"]
        assert isinstance(readback, dict)
        readback["source_refs"] = []

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(result["ok"])
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertIn(
            "runtime_window_import_readback_source_refs_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_readback_source_refs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_runtime_import_profit_proof_blockers(self) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation["runtime_ledger_profit_proof_blockers"] = [
            "runtime_ledger_source_window_missing",
            "runtime_ledger_source_refs_missing",
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=runtime_import,
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        materialization = result["evidence"]["runtime_window_import"]["materialization"]
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_ledger_source_window_missing", materialization["blockers"]
        )
        self.assertIn("runtime_ledger_source_refs_missing", materialization["blockers"])
        self.assertIn(
            "runtime_ledger_source_window_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
