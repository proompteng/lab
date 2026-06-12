from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.renew_latest_empirical_promotion_jobs.support import *


class TestRenewLatestEmpiricalPromotionJobsRuntimeLedgerPart1(
    _TestRenewLatestEmpiricalPromotionJobsRuntimeLedgerBase
):
    def test_explicit_live_target_does_not_suppress_paper_plan_target(self) -> None:
        paper_target = renew.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="paper_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        args = argparse.Namespace(
            runtime_window_target=[
                (
                    "hypothesis_id=H-PAIRS-01,"
                    "candidate_id=c88421d619759b2cfaa6f4d0,"
                    "observed_stage=live,"
                    "strategy_family=microbar_cross_sectional_pairs,"
                    "strategy_name=microbar-cross-sectional-pairs-v1,"
                    "account_label=PA3SX7FYNUTF,"
                    "source_account_label=PA3SX7FYNUTF,"
                    "source_dsn_env=DB_DSN,"
                    "target_dsn_env=DB_DSN,"
                    "source_kind=live_runtime_observed,"
                    "source_manifest_ref=config/trading/hypotheses/h-pairs-01.json"
                )
            ],
            runtime_window_target_plan_required=False,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
        )

        with patch.object(
            renew, "_runtime_window_plan_targets", return_value=[paper_target]
        ):
            targets = renew._runtime_window_targets(args)

        self.assertEqual(len(targets), 2)
        self.assertEqual(
            {(target.observed_stage, target.account_label) for target in targets},
            {("live", "PA3SX7FYNUTF"), ("paper", "TORGHUT_SIM")},
        )

    def test_latest_source_activity_window_queries_source_account_alias(self) -> None:
        target = renew.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            source_account_label="PA3SX7FYNUTF",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="paper_runtime_observed",
            delay_adjusted_depth_stress_report_ref="",
        )
        executed_params: list[object] = []
        earliest = datetime(2026, 6, 4, 13, 31, tzinfo=timezone.utc)
        latest = datetime(2026, 6, 4, 19, 59, tzinfo=timezone.utc)

        class Cursor:
            def __enter__(self) -> "Cursor":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def execute(self, _query: str, params: tuple[object, ...]) -> None:
                executed_params.extend(params)

            def fetchone(self) -> tuple[datetime, datetime]:
                return earliest, latest

        class Connection:
            def __enter__(self) -> "Connection":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def cursor(self) -> Cursor:
                return Cursor()

        with (
            patch.dict("os.environ", {"SIM_DB_DSN": "postgresql://torghut/source"}),
            patch.object(renew.psycopg, "connect", return_value=Connection()),
        ):
            window = renew._latest_source_activity_window(
                target=target,
                runtime_manifest={"strategy_name": "microbar-cross-sectional-pairs-v1"},
            )

        self.assertEqual(
            window,
            (
                datetime(2026, 6, 4, 13, 30, tzinfo=timezone.utc),
                datetime(2026, 6, 4, 20, 0, tzinfo=timezone.utc),
            ),
        )
        self.assertEqual(executed_params[1], "PA3SX7FYNUTF")
        self.assertEqual(target.account_label, "TORGHUT_SIM")

    def test_explicit_runtime_window_target_preserves_metadata_and_gates(self) -> None:
        args = argparse.Namespace(
            runtime_window_target=[
                json.dumps(
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "observed_stage": "paper",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "account_label": "TORGHUT_REPLAY",
                        "source_account_label": "TORGHUT_REPLAY",
                        "source_dsn_env": "SIM_DB_DSN",
                        "target_dsn_env": "SIM_DB_DSN",
                        "source_kind": "runtime_ledger_source_collection_candidate",
                        "source_manifest_ref": (
                            "config/trading/hypotheses/h-pairs-01.json"
                        ),
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "drift_ok": "true",
                        "artifact_refs": ["runtime-ledger-proof.json"],
                        "source_collection_authorized": True,
                        "source_collection_reason_codes": [
                            "runtime_ledger_source_window_missing"
                        ],
                    }
                )
            ],
            runtime_window_target_plan_required=False,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
        )

        targets = renew._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        target = targets[0]
        self.assertEqual(target.dependency_quorum_decision, "allow")
        self.assertEqual(target.continuity_ok, "true")
        self.assertEqual(target.drift_ok, "true")
        self.assertEqual(target.artifact_refs, ("runtime-ledger-proof.json",))
        assert target.target_metadata is not None
        self.assertIs(target.target_metadata["source_collection_authorized"], True)
        self.assertEqual(
            target.target_metadata["source_collection_authorization_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertEqual(
            target.target_metadata["source_collection_reason_codes"],
            ["runtime_ledger_source_window_missing"],
        )

    def test_sim_backed_runtime_window_target_normalizes_replay_source_label(
        self,
    ) -> None:
        args = argparse.Namespace(
            runtime_window_target=[
                json.dumps(
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "observed_stage": "paper",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "account_label": "TORGHUT_SIM",
                        "source_account_label": "TORGHUT_REPLAY",
                        "source_dsn_env": "SIM_DB_DSN",
                        "target_dsn_env": "SIM_DB_DSN",
                        "source_kind": "runtime_ledger_source_collection_candidate",
                        "source_manifest_ref": (
                            "config/trading/hypotheses/h-pairs-01.json"
                        ),
                    }
                )
            ],
            runtime_window_target_plan_required=False,
            runtime_window_target_plan_exclusive=True,
            runtime_window_targets_from_latest_autoresearch=False,
            runtime_window_targets_from_registry=False,
        )

        targets = renew._runtime_window_targets(args)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].source_account_label, "TORGHUT_SIM")

    def test_observed_strategy_source_collection_plan_target_parses_for_import(
        self,
    ) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "source": "paper_route_observed_strategy_source_collection",
                    "targets": [
                        {
                            "hypothesis_id": "H-TSMOM-LIQ-01",
                            "candidate_id": "candidate-tsmom",
                            "observed_stage": "paper",
                            "strategy_family": "intraday_tsmom_consistent",
                            "strategy_name": "intraday-tsmom-profit-v3",
                            "runtime_strategy_name": "intraday-tsmom-profit-v3",
                            "strategy_id": "intraday_tsmom_v2@research",
                            "strategy_lookup_names": [
                                "intraday-tsmom-profit-v3",
                                "intraday_tsmom_v2@research",
                            ],
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_SIM",
                            "source_dsn_env": "SIM_DB_DSN",
                            "target_dsn_env": "SIM_DB_DSN",
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-tsmom-liq-01.json"
                            ),
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                            "window_start": "2026-05-26T13:30:00+00:00",
                            "window_end": "2026-05-26T20:00:00+00:00",
                            "source_collection_authorized": True,
                            "source_collection_authorization_scope": (
                                "source_window_evidence_collection_only"
                            ),
                            "source_collection_reason_codes": [
                                "paper_route_foreign_strategy_source_activity_observed"
                            ],
                            "promotion_allowed": False,
                            "final_promotion_allowed": False,
                            "final_promotion_authorized": False,
                            "handoff": "runtime_ledger_source_collection_import",
                            "selected_by": (
                                "paper_route_observed_strategy_source_collection"
                            ),
                        }
                    ],
                }
            }
        )

        targets = renew._runtime_window_targets_from_plan(
            plan=plan,
            ref="observed-plan-fixture",
            args=argparse.Namespace(),
        )

        self.assertEqual(len(targets), 1)
        target = targets[0]
        self.assertEqual(target.hypothesis_id, "H-TSMOM-LIQ-01")
        self.assertEqual(target.candidate_id, "candidate-tsmom")
        self.assertEqual(target.strategy_name, "intraday-tsmom-profit-v3")
        self.assertEqual(target.source_account_label, "TORGHUT_SIM")
        self.assertEqual(
            target.source_kind, "runtime_ledger_source_collection_candidate"
        )
        self.assertTrue(target.target_metadata["source_collection_authorized"])
        self.assertNotIn("paper_route_probe_symbols", target.target_metadata)

    def test_source_collection_materializable_lineage_rejects_aggregate_only_bucket_count(
        self,
    ) -> None:
        self.assertFalse(
            renew._runtime_window_source_collection_target_has_materializable_lineage(
                {
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "source_row_counts": {"strategy_runtime_ledger_buckets": 1},
                    "source_refs": ["postgres:strategy_runtime_ledger_buckets"],
                }
            )
        )

    def test_source_collection_materializable_lineage_accepts_concrete_source_count(
        self,
    ) -> None:
        for row_count_key in (
            "trade_decisions",
            "executions",
            "execution_tca_metrics",
            "execution_order_events",
            "order_feed_source_windows",
        ):
            with self.subTest(row_count_key=row_count_key):
                self.assertTrue(
                    renew._runtime_window_source_collection_target_has_materializable_lineage(
                        {
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                            "source_row_counts": {
                                "strategy_runtime_ledger_buckets": 1,
                                row_count_key: 1,
                            },
                        }
                    )
                )

    def test_paper_route_evidence_payload_skips_source_only_proof_plans(
        self,
    ) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "runtime_window_import_plan": {
                    "source": "paper_route_prioritized_source_collection",
                    "target_count": 6,
                    "targets": [
                        {
                            "candidate_id": "stale-source-candidate",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                            "window_start": "2026-05-13T17:00:00+00:00",
                            "window_end": "2026-05-13T17:30:00+00:00",
                        }
                    ],
                },
                "observed_strategy_source_runtime_window_import_plan": {
                    "source": "paper_route_observed_strategy_source_collection",
                    "targets": [
                        {
                            "candidate_id": "observed-source-candidate",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "source": "paper_route_evidence_audit",
                    "purpose": "next_session_paper_route_runtime_window_evidence_collection",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "current-hpairs-candidate",
                            "strategy_name": ("microbar-cross-sectional-pairs-v1"),
                            "account_label": "TORGHUT_SIM",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "window_start": "2026-06-05T13:30:00+00:00",
                            "window_end": "2026-06-05T20:00:00+00:00",
                        }
                    ],
                },
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "gate-source-candidate",
                                "source_kind": (
                                    "runtime_ledger_source_collection_candidate"
                                ),
                            }
                        ],
                    },
                },
            }
        )

        self.assertEqual(plan["source"], "paper_route_evidence_audit")
        self.assertEqual(len(plan["targets"]), 1)
        self.assertEqual(plan["targets"][0]["candidate_id"], "current-hpairs-candidate")
        self.assertNotIn("merged_live_submission_gate_source_collection", plan)

    def test_paper_route_evidence_payload_does_not_fallback_to_gate_source_collection(
        self,
    ) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "runtime_window_import_plan": {
                    "source": "paper_route_prioritized_source_collection",
                    "targets": [
                        {
                            "candidate_id": "direct-source-candidate",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                        }
                    ],
                },
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "candidate_id": "gate-source-candidate",
                                "source_kind": (
                                    "runtime_ledger_source_collection_candidate"
                                ),
                            }
                        ],
                    },
                },
                "runtime_ledger_paper_probation_import_plan": {
                    "source_collection_target_count": 1,
                    "targets": [
                        {
                            "candidate_id": "top-level-source-candidate",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                        }
                    ],
                },
            }
        )

        self.assertNotIn("targets", plan)
        self.assertEqual(plan["schema_version"], "torghut.paper-route-evidence.v1")

    def test_paper_route_evidence_payload_skips_source_only_fallback_slots(
        self,
    ) -> None:
        latest_closed_plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "latest_closed_runtime_window_import_selection": {
                    "selected": True,
                    "state": "selected",
                    "source_backed_evidence_present": True,
                    "clean_window_importable": True,
                },
                "latest_closed_paper_route_runtime_window_targets": {
                    "source": "paper_route_prioritized_source_collection",
                    "session_readiness": {"import_ready": True},
                    "targets": [
                        {
                            "candidate_id": "latest-closed-source-only",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                        }
                    ],
                },
                "runtime_window_import_plan": {
                    "source": "paper_route_evidence_audit",
                    "targets": [
                        {
                            "candidate_id": "direct-paper-proof",
                            "source_kind": "paper_route_probe_runtime_observed",
                        }
                    ],
                },
            }
        )
        self.assertEqual(
            latest_closed_plan["targets"][0]["candidate_id"], "direct-paper-proof"
        )

        clean_after_discard_plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_clean_paper_route_runtime_window_targets_after_discard": {
                    "source": "paper_route_observed_strategy_source_collection",
                    "targets": [
                        {
                            "candidate_id": "clean-after-discard-source-only",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "source": "paper_route_evidence_audit",
                    "targets": [
                        {
                            "candidate_id": "next-paper-proof",
                            "source_kind": "paper_route_probe_runtime_observed",
                        }
                    ],
                },
            }
        )
        self.assertEqual(
            clean_after_discard_plan["targets"][0]["candidate_id"],
            "next-paper-proof",
        )

        source_only_plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-evidence.v1",
                "next_paper_route_runtime_window_targets": {
                    "source": "paper_route_prioritized_source_collection",
                    "targets": [
                        {
                            "candidate_id": "next-paper-source-only",
                            "source_kind": (
                                "runtime_ledger_source_collection_candidate"
                            ),
                        }
                    ],
                },
            }
        )
        self.assertEqual(
            source_only_plan["schema_version"], "torghut.paper-route-evidence.v1"
        )
        self.assertNotIn("targets", source_only_plan)

    def test_aggregate_only_source_collection_target_blocks_before_import(
        self,
    ) -> None:
        target = renew.RuntimeWindowImportTarget(
            hypothesis_id="H-PAIRS-01",
            candidate_id="c88421d619759b2cfaa6f4d0",
            observed_stage="paper",
            strategy_family="microbar_cross_sectional_pairs",
            source_dsn_env="SIM_DB_DSN",
            target_dsn_env="SIM_DB_DSN",
            strategy_name="microbar-cross-sectional-pairs-v1",
            account_label="TORGHUT_SIM",
            dataset_snapshot_ref="portfolio-profit-autoresearch-500-v1",
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="runtime_ledger_source_collection_candidate",
            delay_adjusted_depth_stress_report_ref="",
            window_start="2026-05-13T17:00:00+00:00",
            window_end="2026-05-13T17:30:00+00:00",
            target_metadata={
                "source_row_counts": {"strategy_runtime_ledger_buckets": 1},
                "source_collection_reason_codes": [
                    "runtime_window_source_activity_missing"
                ],
            },
        )
        args = argparse.Namespace(runtime_window_target_plan_settlement_seconds=0)

        with (
            patch.object(
                renew,
                "_read_runtime_window_manifest",
                return_value={"candidate_id": "c88421d619759b2cfaa6f4d0"},
            ),
            patch.object(renew.subprocess, "run") as run,
        ):
            result = renew._run_runtime_window_import_target(
                args=args,
                target=target,
                manifest={},
                run_id="test-run",
                manifest_path=Path("manifest.yaml"),
                window_start=datetime(2026, 5, 13, 17, tzinfo=timezone.utc),
                window_end=datetime(2026, 5, 13, 17, 30, tzinfo=timezone.utc),
                now=datetime(2026, 5, 13, 21, tzinfo=timezone.utc),
            )

        run.assert_not_called()
        self.assertEqual(
            result["reason"],
            "runtime_ledger_source_collection_materialization_required",
        )
        self.assertEqual(result["proof_status"], "blocked")
        blockers = [blocker["blocker"] for blocker in result["proof_blockers"]]
        self.assertIn(
            "runtime_ledger_source_collection_materialization_missing", blockers
        )
        self.assertIn("runtime_window_source_activity_missing", blockers)

    def test_target_plan_payload_prefers_selected_latest_closed_import_plan(
        self,
    ) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "purpose": "observed_strategy_runtime_ledger_source_collection_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-CURRENT",
                            "candidate_id": "current-candidate",
                            "strategy_name": "current-strategy",
                            "runtime_strategy_name": "current-strategy",
                            "account_label": "TORGHUT_SIM",
                            "source_manifest_ref": "current.json",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                            "paper_route_session_import_ready": False,
                            "paper_route_session_import_blockers": [
                                "paper_route_session_window_not_closed"
                            ],
                        }
                    ],
                },
                "latest_closed_runtime_window_import_selection": {
                    "schema_version": (
                        "torghut.paper-route-runtime-window-import-selection.v1"
                    ),
                    "selected": True,
                    "state": "selected",
                    "reason": "latest_closed_window_source_backed_and_clean",
                    "source_backed_evidence_present": True,
                    "clean_window_importable": True,
                },
                "latest_closed_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "session_readiness": {"import_ready": True},
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "closed-candidate",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "runtime_strategy_name": (
                                "microbar-cross-sectional-pairs-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_SIM",
                            "source_dsn_env": "SIM_DB_DSN",
                            "target_dsn_env": "SIM_DB_DSN",
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                            "window_start": "2026-06-03T13:30:00+00:00",
                            "window_end": "2026-06-03T20:00:00+00:00",
                            "source_collection_authorized": True,
                            "source_collection_authorization_scope": (
                                "source_window_evidence_collection_only"
                            ),
                        }
                    ],
                },
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-CURRENT",
                                "candidate_id": "current-candidate",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": "current-strategy",
                                "runtime_strategy_name": "current-strategy",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": (
                                    "runtime_ledger_source_collection_candidate"
                                ),
                                "source_manifest_ref": "current.json",
                                "source_collection_authorized": True,
                                "window_start": "2026-06-04T13:30:00+00:00",
                                "window_end": "2026-06-04T20:00:00+00:00",
                            }
                        ],
                    },
                },
            }
        )

        targets = renew._runtime_window_targets_from_plan(
            plan=plan,
            ref="target-plan-url-fixture",
            args=argparse.Namespace(),
        )

        self.assertEqual(
            plan["purpose"], "latest_closed_session_paper_route_runtime_window_import"
        )
        self.assertEqual(len(plan["targets"]), 1)
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "closed-candidate")
        self.assertEqual(str(targets[0].window_start), "2026-06-03T13:30:00+00:00")

    def test_target_plan_payload_ignores_unselected_latest_closed_plan(self) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "purpose": "observed_strategy_runtime_ledger_source_collection_import",
                    "targets": [
                        {
                            "hypothesis_id": "H-CURRENT",
                            "candidate_id": "current-candidate",
                            "strategy_name": "current-strategy",
                            "runtime_strategy_name": "current-strategy",
                            "account_label": "TORGHUT_SIM",
                            "source_manifest_ref": "current.json",
                            "window_start": "2026-06-04T13:30:00+00:00",
                            "window_end": "2026-06-04T20:00:00+00:00",
                        }
                    ],
                },
                "latest_closed_runtime_window_import_selection": {
                    "selected": False,
                    "state": "discarded",
                    "source_backed_evidence_present": True,
                    "clean_window_importable": True,
                },
                "latest_closed_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "session_readiness": {"import_ready": True},
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "closed-candidate",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                        }
                    ],
                },
            }
        )

        self.assertEqual(
            plan["purpose"], "observed_strategy_runtime_ledger_source_collection_import"
        )
        self.assertEqual(plan["targets"][0]["candidate_id"], "current-candidate")

    def test_target_plan_payload_requires_clean_latest_closed_selection(
        self,
    ) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "purpose": "observed_strategy_runtime_ledger_source_collection_import",
                    "targets": [{"candidate_id": "current-candidate"}],
                },
                "latest_closed_runtime_window_import_selection": {
                    "selected": True,
                    "state": "selected",
                    "source_backed_evidence_present": True,
                    "clean_window_importable": False,
                },
                "latest_closed_paper_route_runtime_window_targets": {
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "session_readiness": {"import_ready": True},
                    "targets": [{"candidate_id": "closed-candidate"}],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "current-candidate")
