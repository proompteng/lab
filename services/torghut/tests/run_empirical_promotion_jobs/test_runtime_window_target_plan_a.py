from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_empirical_promotion_jobs.support import *


class TestRunEmpiricalPromotionJobsRuntimeWindowTargetPlanA(
    RunEmpiricalPromotionJobsTestCase
):
    def test_runtime_window_target_plan_payload_accepts_top_level_gate_plan_and_fallback(
        self,
    ) -> None:
        top_level_plan = renewal._runtime_window_target_plan_from_payload(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "targets": [{"hypothesis_id": "H-PAIRS-01"}]
                }
            }
        )
        fallback_plan = renewal._runtime_window_target_plan_from_payload(
            {"targets": [{"hypothesis_id": "H-FALLBACK-01"}]}
        )

        self.assertEqual(top_level_plan["targets"][0]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(fallback_plan["targets"][0]["hypothesis_id"], "H-FALLBACK-01")

    def test_runtime_window_target_plan_payload_prefers_source_runtime_plan(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "targets": [
                        {
                            "candidate_id": "cand-empty-hpairs",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                        }
                    ]
                },
                "source_runtime_window_import_plan": {
                    "source": "live_submission_gate_runtime_ledger_source_collection",
                    "purpose": "runtime_ledger_source_collection_import",
                    "targets": [
                        {
                            "candidate_id": "cand-source-volume",
                            "hypothesis_id": "H-MICRO-01",
                            "strategy_family": "microstructure_breakout",
                            "strategy_name": (
                                "microbar-volume-continuation-long-top2-chip-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_SIM",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                            "source_collection_authorized": True,
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-micro-01.json"
                            ),
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "targets": [
                        {
                            "candidate_id": "cand-next-hpairs",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                        }
                    ]
                },
                "runtime_window_import_audit": {
                    "state": "import_due_source_activity_missing",
                    "blockers": ["paper_route_source_activity_missing"],
                },
            }
        )

        self.assertEqual(
            plan["source"], "live_submission_gate_runtime_ledger_source_collection"
        )
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "cand-source-volume")
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertEqual(
            target["runtime_window_import_audit_state"],
            "import_due_source_activity_missing",
        )
        self.assertIn(
            "paper_route_source_activity_missing",
            target["runtime_window_import_audit_blockers"],
        )

        args = SimpleNamespace(
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="SIM_DB_DSN",
            runtime_window_target_dsn_env="SIM_DB_DSN",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
            runtime_window_delay_adjusted_depth_stress_report_ref="",
            runtime_window_dependency_quorum_decision="",
            runtime_window_continuity_ok="",
            runtime_window_drift_ok="",
            runtime_window_source_account_label="",
        )
        import_targets = renewal._runtime_window_targets_from_plan(
            plan=plan,
            ref="target-plan-payload",
            args=args,
        )

        self.assertEqual(len(import_targets), 1)
        self.assertEqual(import_targets[0].candidate_id, "cand-source-volume")
        self.assertEqual(
            import_targets[0].source_kind,
            "runtime_ledger_source_collection_candidate",
        )
        self.assertIsNone(
            renewal._runtime_window_target_plan_import_blocked_result(
                target=import_targets[0],
                candidate_id=import_targets[0].candidate_id,
                manifest_path=Path("config/trading/hypotheses/h-micro-01.json"),
                window_start=datetime(2026, 6, 2, 13, 30, tzinfo=timezone.utc),
                window_end=datetime(2026, 6, 2, 20, tzinfo=timezone.utc),
                window_selection="target-plan-payload",
            )
        )

    def test_runtime_window_target_plan_payload_marks_contaminated_import_audit(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.next-paper-route-runtime-window-targets.v1"
                    ),
                    "targets": [
                        {
                            "candidate_id": "cand-contaminated",
                            "hypothesis_id": "H-CONTAMINATED",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-05-29T13:30:00+00:00",
                            "window_end": "2026-05-29T20:00:00+00:00",
                        }
                    ],
                },
                "runtime_window_import_audit": {
                    "state": "import_due_account_contamination_detected",
                    "next_action": "import_with_blockers",
                    "blockers": [
                        "paper_route_account_contamination_detected",
                        "unlinked_order_events_present",
                    ],
                    "target_blockers": [
                        {
                            "candidate_id": "cand-contaminated",
                            "hypothesis_id": "H-CONTAMINATED",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-05-29T13:30:00+00:00",
                            "window_end": "2026-05-29T20:00:00+00:00",
                            "blockers": [
                                "runtime_ledger_evidence_grade_bucket_missing"
                            ],
                        }
                    ],
                },
            }
        )

        target = plan["targets"][0]
        self.assertEqual(
            target["runtime_window_import_audit_state"],
            "import_due_account_contamination_detected",
        )
        self.assertIn(
            "paper_route_account_contamination_detected",
            target["runtime_ledger_target_metadata_blockers"],
        )
        self.assertIn(
            "unlinked_order_events_present",
            target["runtime_window_import_health_gate_blockers"],
        )
        self.assertIn(
            "runtime_ledger_evidence_grade_bucket_missing",
            target["runtime_window_import_audit_target_blockers"],
        )

    def test_runtime_window_import_audit_annotation_helper_fallbacks(
        self,
    ) -> None:
        self.assertEqual(
            renewal._extend_unique_text_items(" existing ", ["new", "existing"]),
            ["existing", "new"],
        )
        self.assertEqual(
            renewal._runtime_window_import_audit_blockers(
                {"state": "import_due_source_activity_missing"}
            ),
            ["import_due_source_activity_missing"],
        )
        self.assertTrue(
            renewal._runtime_window_audit_target_blocker_matches(
                target_blocker={
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_lookup_names": ["runtime-strategy"],
                },
                target={
                    "hypothesis_id": "H-PAIRS-01",
                    "runtime_strategy_name": "runtime-strategy",
                },
            )
        )
        self.assertFalse(
            renewal._runtime_window_audit_target_blocker_matches(
                target_blocker={"candidate_id": "different"},
                target={"candidate_id": "candidate"},
            )
        )
        self.assertFalse(
            renewal._runtime_window_audit_target_blocker_matches(
                target_blocker={"strategy_lookup_names": ["missing-strategy"]},
                target={"runtime_strategy_name": "runtime-strategy"},
            )
        )
        payload = {
            "runtime_window_import_audit": {
                "state": "import_due_source_activity_missing",
            }
        }
        self.assertEqual(
            renewal._runtime_window_target_plan_with_import_audit_blockers(
                payload=payload,
                plan={"targets": "invalid"},
            ),
            {"targets": "invalid"},
        )
        annotated = renewal._runtime_window_target_plan_with_import_audit_blockers(
            payload=payload,
            plan={
                "targets": [
                    None,
                    {
                        "candidate_id": "candidate",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "runtime-strategy",
                    },
                ]
            },
        )

        self.assertIsNone(annotated["targets"][0])
        self.assertIn(
            "import_due_source_activity_missing",
            annotated["targets"][1]["runtime_ledger_target_metadata_blockers"],
        )

    def test_runtime_window_target_plan_payload_blocks_contaminated_import_audit_without_targets(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            (
                "runtime_window_target_plan_import_blocked:"
                "import_due_account_contamination_detected:.*"
                "unlinked_order_events_present"
            ),
        ):
            renewal._runtime_window_target_plan_from_payload(
                {
                    "schema_version": "torghut.paper-route-target-plan.v1",
                    "runtime_window_import_plan": {
                        "schema_version": (
                            "torghut.next-paper-route-runtime-window-targets.v1"
                        ),
                        "targets": [],
                    },
                    "runtime_window_import_audit": {
                        "state": "import_due_account_contamination_detected",
                        "blockers": [
                            "paper_route_account_contamination_detected",
                            "unlinked_order_events_present",
                        ],
                    },
                }
            )

    def test_runtime_window_target_plan_payload_prefers_next_paper_route_plan(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "source_runtime_window_import_plan": {
                    "schema_version": ("torghut.source-runtime-window-import-plan.v1"),
                    "target_count": 5,
                    "targets": [
                        {
                            "candidate_id": "cand-source-superset",
                            "hypothesis_id": "H-SOURCE-SUPERSET",
                            "window_start": "2026-05-20T13:30:00+00:00",
                            "window_end": "2026-05-20T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "targets": [
                            {
                                "candidate_id": "cand-stale-paper",
                                "hypothesis_id": "H-STALE-PAPER",
                                "window_start": "2026-05-21T17:00:00+00:00",
                                "window_end": "2026-05-21T17:30:00+00:00",
                            }
                        ],
                    }
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                        }
                    ],
                },
                "targets": [
                    {
                        "candidate_id": "cand-top-level-audit",
                        "hypothesis_id": "H-TOP-LEVEL-AUDIT",
                        "window_start": "2026-05-13T17:00:00+00:00",
                        "window_end": "2026-05-13T17:30:00+00:00",
                    }
                ],
            }
        )

        self.assertEqual(
            plan["schema_version"], "torghut.next-paper-route-runtime-window-targets.v1"
        )
        self.assertEqual(plan["targets"][0]["hypothesis_id"], "H-PAPER-ROUTE")
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-05-26T13:30:00+00:00"
        )

    def test_runtime_window_target_plan_payload_skips_source_only_runtime_import_plan(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                    "source": "paper_route_observed_strategy_source_collection",
                    "purpose": "observed_strategy_runtime_ledger_source_collection_import",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-selected-source",
                            "hypothesis_id": "H-TSMOM-LIQ-01",
                            "strategy_family": "intraday_tsmom",
                            "strategy_name": "intraday-tsmom-v2",
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_SIM",
                            "source_kind": "runtime_ledger_source_collection_candidate",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                            "candidate_blockers": [
                                "runtime_ledger_source_collection_only"
                            ],
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "source": "paper_route_evidence_audit",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-contaminated-next",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                            "candidate_blockers": [
                                "paper_route_account_contamination_detected",
                                "foreign_order_events_present",
                            ],
                        }
                    ],
                },
            }
        )

        self.assertEqual(plan["source"], "paper_route_evidence_audit")
        self.assertEqual(plan["targets"][0]["candidate_id"], "cand-contaminated-next")
        self.assertIn(
            "paper_route_account_contamination_detected",
            plan["targets"][0]["candidate_blockers"],
        )

    def test_runtime_window_target_plan_payload_prefers_clean_after_discard(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_clean_paper_route_runtime_window_targets_after_discard": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "next_clean_session_paper_route_runtime_window_collection_after_discard",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-clean-followup",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-05T13:30:00+00:00",
                            "window_end": "2026-06-05T20:00:00+00:00",
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-contaminated-next",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                        }
                    ],
                },
            }
        )

        self.assertEqual(
            plan["purpose"],
            "next_clean_session_paper_route_runtime_window_collection_after_discard",
        )
        self.assertEqual(plan["targets"][0]["candidate_id"], "cand-clean-followup")

    def test_runtime_window_target_plan_payload_accepts_paper_route_evidence_plan(
        self,
    ) -> None:
        paper_route_plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "source_dsn_env": "SIM_DB_DSN",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                            "dependency_quorum_decision": "missing",
                            "continuity_ok": "false",
                            "drift_ok": "false",
                            "runtime_window_import_health_gate": {
                                "schema_version": "torghut.runtime-window-import-health-gate.v1",
                                "dependency_quorum_decision": "missing",
                                "continuity_ok": "false",
                                "drift_ok": "false",
                                "ready": False,
                                "blockers": [
                                    "runtime_window_import_dependency_quorum_missing"
                                ],
                            },
                            "runtime_window_import_health_gate_blockers": [
                                "runtime_window_import_dependency_quorum_missing"
                            ],
                            "runtime_window_import_promotion_blockers": [
                                "runtime_window_import_drift_missing"
                            ],
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL"],
                            "paper_route_probe_symbol_count": 1,
                            "paper_route_probe_next_session_max_notional": "25",
                            "paper_route_probe_window_start": "2026-05-26T13:30:00+00:00",
                            "paper_route_probe_window_end": "2026-05-26T20:00:00+00:00",
                            "paper_route_session_readiness_state": "waiting_for_session_open",
                            "paper_route_session_import_ready": False,
                            "paper_route_session_import_blockers": [
                                "paper_route_session_window_not_open"
                            ],
                            "paper_route_runtime_window_import_not_before": "2026-05-26T20:00:00+00:00",
                            "paper_route_runtime_import_handoff": {
                                "runner": "scripts/renew_latest_empirical_promotion_jobs.py",
                                "target_plan_endpoint": "/trading/paper-route-evidence",
                                "required_flags": [
                                    "--runtime-window-import",
                                    "--runtime-window-target-plan-url",
                                    "--runtime-window-target-plan-exclusive",
                                    "--runtime-window-target-plan-required",
                                    "--runtime-window-target-plan-settlement-seconds",
                                ],
                                "source_dsn_env": "SIM_DB_DSN",
                                "target_dsn_env": "SIM_DB_DSN",
                                "account_label": "TORGHUT_SIM",
                                "import_ready": False,
                                "import_blockers": [
                                    "paper_route_session_window_not_open"
                                ],
                            },
                            "paper_probation_authorized": True,
                            "promotion_allowed": False,
                            "final_promotion_authorized": False,
                            "final_promotion_allowed": False,
                            "max_notional": "0",
                        },
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "source_dsn_env": "SIM_DB_DSN",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                            "paper_route_probe_symbols": ["AAPL"],
                            "paper_route_probe_symbol_count": 1,
                            "paper_route_probe_next_session_max_notional": "25",
                            "paper_route_probe_window_start": "2026-05-26T13:30:00+00:00",
                            "paper_route_probe_window_end": "2026-05-26T20:00:00+00:00",
                            "paper_probation_authorized": True,
                            "promotion_allowed": False,
                            "final_promotion_authorized": False,
                            "final_promotion_allowed": False,
                            "max_notional": "0",
                        },
                    ],
                },
            }
        )
        args = SimpleNamespace(
            runtime_window_target=[],
            runtime_window_target_plan_ref=[],
            runtime_window_targets_from_registry=False,
            runtime_window_hypothesis_id="",
            runtime_window_candidate_id="",
            runtime_window_observed_stage="paper",
            runtime_window_strategy_family="",
            runtime_window_source_dsn_env="DB_DSN",
            runtime_window_target_dsn_env="",
            runtime_window_strategy_name="",
            runtime_window_account_label="TORGHUT_SIM",
            runtime_window_dataset_snapshot_ref="",
            runtime_window_source_manifest_ref="",
            runtime_window_source_kind="paper_runtime_observed",
        )

        targets = renewal._runtime_window_targets_from_plan(
            plan=paper_route_plan,
            ref="paper-route-evidence",
            args=args,
        )

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].hypothesis_id, "H-PAPER-ROUTE")
        self.assertEqual(targets[0].source_dsn_env, "SIM_DB_DSN")
        self.assertEqual(targets[0].target_dsn_env, "SIM_DB_DSN")
        self.assertEqual(targets[0].source_kind, "paper_route_probe_runtime_observed")
        self.assertEqual(targets[0].dependency_quorum_decision, "missing")
        self.assertEqual(targets[0].continuity_ok, "false")
        self.assertEqual(targets[0].drift_ok, "false")
        self.assertEqual(targets[0].window_start, "2026-05-26T13:30:00+00:00")
        assert targets[0].target_metadata is not None
        self.assertEqual(
            targets[0].target_metadata["runtime_window_import_health_gate"][
                "schema_version"
            ],
            "torghut.runtime-window-import-health-gate.v1",
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_window_import_health_gate_blockers"],
            ["runtime_window_import_dependency_quorum_missing"],
        )
        self.assertEqual(
            targets[0].target_metadata["runtime_window_import_promotion_blockers"],
            ["runtime_window_import_drift_missing"],
        )
        self.assertEqual(targets[0].target_metadata["max_notional"], "0")
        self.assertEqual(
            targets[0].target_metadata["paper_route_probe_symbols"], ["AAPL"]
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_probe_next_session_max_notional"],
            "25",
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_session_readiness_state"],
            "waiting_for_session_open",
        )
        self.assertFalse(targets[0].target_metadata["paper_route_session_import_ready"])
        self.assertEqual(
            targets[0].target_metadata["paper_route_session_import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_runtime_window_import_not_before"],
            "2026-05-26T20:00:00+00:00",
        )
        self.assertEqual(
            targets[0].target_metadata["paper_route_runtime_import_handoff"][
                "target_plan_endpoint"
            ],
            "/trading/paper-route-evidence",
        )
        self.assertFalse(targets[0].target_metadata["promotion_allowed"])
        self.assertFalse(targets[0].target_metadata["final_promotion_allowed"])

    def test_runtime_window_target_plan_payload_keeps_live_gate_source_collection(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-01T13:30:00+00:00",
                            "window_end": "2026-06-01T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "cand-source-collection",
                                "hypothesis_id": "H-SOURCE-COLLECTION",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "source-collection-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "runtime_ledger_source_collection_candidate",
                                "source_collection_authorized": True,
                                "window_start": "2026-05-13T17:00:00+00:00",
                                "window_end": "2026-05-13T17:30:00+00:00",
                            }
                        ],
                    },
                },
            }
        )

        self.assertTrue(plan["merged_live_submission_gate_source_collection"])
        self.assertEqual(plan["source_collection_target_count"], 1)
        self.assertEqual(plan["paper_route_target_count"], 1)
        self.assertEqual(plan["target_count"], 2)
        self.assertEqual(
            [target["hypothesis_id"] for target in plan["targets"]],
            ["H-SOURCE-COLLECTION", "H-PAPER-ROUTE"],
        )

    def test_runtime_window_target_plan_payload_does_not_merge_sim_gate_source_collection(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "source": "paper_route_evidence_audit",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "cand-source-collection",
                                "hypothesis_id": "H-SOURCE-COLLECTION",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "source-collection-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "runtime_ledger_source_collection_candidate",
                                "source_collection_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
                                "window_start": "2026-05-13T17:00:00+00:00",
                                "window_end": "2026-05-13T17:30:00+00:00",
                            }
                        ],
                    },
                },
            }
        )

        self.assertNotIn("merged_live_submission_gate_source_collection", plan)
        self.assertEqual(plan["source"], "paper_route_evidence_audit")
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(
            [target["hypothesis_id"] for target in plan["targets"]],
            ["H-PAPER-ROUTE"],
        )

    def test_runtime_window_target_plan_skips_aggregate_replay_source_collection(
        self,
    ) -> None:
        plan = renewal._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "cand-paper-route",
                            "hypothesis_id": "H-PAPER-ROUTE",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "aggregate-replay",
                                "hypothesis_id": "H-PAIRS-01",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "source-collection-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_account_label": "TORGHUT_REPLAY",
                                "source_dsn_env": "DB_DSN",
                                "target_dsn_env": "SIM_DB_DSN",
                                "source_kind": "runtime_ledger_source_collection_candidate",
                                "source_collection_authorized": True,
                                "source_collection_reason_codes": [
                                    "runtime_ledger_source_window_missing",
                                    "runtime_ledger_source_refs_missing",
                                    "runtime_ledger_execution_order_event_refs_missing",
                                    "runtime_ledger_source_offsets_missing",
                                    "runtime_ledger_source_materialization_missing",
                                    "runtime_ledger_authority_class_missing",
                                ],
                                "runtime_ledger_bucket_ref": (
                                    "strategy_runtime_ledger_buckets:"
                                    "rt-ledger-vwap-cap-safe-20260512-20260521-c88421d6:"
                                    "2026-05-13T17:00:00+00:00:"
                                    "2026-05-13T17:30:00+00:00"
                                ),
                                "window_start": "2026-05-13T17:00:00+00:00",
                                "window_end": "2026-05-13T17:30:00+00:00",
                            }
                        ],
                    },
                },
            }
        )

        self.assertNotIn("merged_live_submission_gate_source_collection", plan)
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(
            [target["hypothesis_id"] for target in plan["targets"]],
            ["H-PAPER-ROUTE"],
        )

    def test_runtime_window_target_plan_allows_source_collection_with_materializable_lineage(
        self,
    ) -> None:
        base_target = {
            "candidate_id": "source-backed-replay",
            "hypothesis_id": "H-PAIRS-01",
            "strategy_name": "source-collection-candidate-v1",
            "account_label": "TORGHUT_REPLAY",
            "source_account_label": "TORGHUT_REPLAY",
            "source_dsn_env": "DB_DSN",
            "source_kind": "runtime_ledger_source_collection_candidate",
            "source_collection_authorized": True,
        }

        self.assertFalse(
            renewal._runtime_window_target_plan_positive_mapping_count(
                {"execution_order_events": "not-an-int", "trade_decisions": 0}
            )
        )
        self.assertTrue(
            renewal._runtime_window_target_plan_positive_mapping_count(
                {"execution_order_events": "2"}
            )
        )

        for lineage in (
            {"source_window_ids": ["window-1"]},
            {"source_window_ids": "window-1"},
            {"source_materialization": "execution_order_events"},
            {"authority_class": "event_sourced_runtime_ledger_profit_proof"},
            {"source_row_counts": {"execution_order_events": 2}},
            {"source_refs": ["postgres:execution_order_events:event-1"]},
        ):
            target = {**base_target, **lineage}

            self.assertTrue(
                renewal._runtime_window_source_collection_target_has_materializable_lineage(
                    target
                )
            )
            self.assertTrue(
                renewal._runtime_window_source_collection_target_allowed(target)
            )

    def test_runtime_window_gate_source_collection_merge_requires_pending_or_sim_count(
        self,
    ) -> None:
        self.assertFalse(
            renewal._runtime_window_gate_allows_source_collection_merge(
                gate={"reason": "non_live_mode", "blocked_reasons": []},
                gate_plan={"source_collection_target_count": "not-an-int"},
            )
        )
        self.assertFalse(
            renewal._runtime_window_gate_allows_source_collection_merge(
                gate={"reason": "promotion_certificate_valid", "blocked_reasons": []},
                gate_plan={"source_collection_target_count": 1},
            )
        )
        self.assertTrue(
            renewal._runtime_window_gate_allows_source_collection_merge(
                gate={
                    "reason": "simple_submit_disabled",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                },
                gate_plan={"source_collection_target_count": "not-an-int"},
            )
        )
