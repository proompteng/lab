from __future__ import annotations

from tests.renew_latest_empirical_promotion_jobs.support import (
    Decimal,
    StrategyRuntimeLedgerBucket,
    _TestRenewLatestEmpiricalPromotionJobsRuntimeLedgerBase,
    _observed_bucket_for_ledger_payload,
    _source_backed_runtime_ledger_bucket,
    argparse,
    persist_observed_runtime_windows,
    renew,
    select,
)


class TestTargetPlanPayloadRequiresSourceBackedLatestClosedSelection(
    _TestRenewLatestEmpiricalPromotionJobsRuntimeLedgerBase
):
    def test_target_plan_payload_requires_source_backed_latest_closed_selection(
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
                    "source_backed_evidence_present": False,
                    "clean_window_importable": True,
                },
                "latest_closed_paper_route_runtime_window_targets": {
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "session_readiness": {"import_ready": True},
                    "targets": [{"candidate_id": "closed-candidate"}],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "current-candidate")

    def test_target_plan_payload_requires_import_ready_latest_closed_plan(
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
                    "clean_window_importable": True,
                },
                "latest_closed_paper_route_runtime_window_targets": {
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "session_readiness": {"import_ready": False},
                    "runtime_window_import_handoff": {"import_ready": False},
                    "targets": [{"candidate_id": "closed-candidate"}],
                },
            }
        )

        self.assertEqual(plan["targets"][0]["candidate_id"], "current-candidate")

    def test_exact_replay_runtime_window_plan_preserves_exact_counts(
        self,
    ) -> None:
        plan = renew._runtime_window_target_plan_from_payload(
            {
                "runtime_window_import_plan": {
                    "schema_version": "torghut.runtime-window-import-plan.v1",
                    "source": "exact_replay_ledger_runtime_window_handoff",
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-exact",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "account_label": "TORGHUT_REPLAY",
                            "source_kind": ("simulation_exact_replay_runtime_ledger"),
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                            "artifact_refs": ["exact-ledger.json"],
                            "exact_replay_ledger_artifact_refs": ["exact-ledger.json"],
                            "exact_replay_ledger_artifact_ref": ("exact-ledger.json"),
                            "exact_replay_ledger_artifact_row_count": 6,
                            "exact_replay_ledger_artifact_fill_count": 2,
                            "promotion_allowed": False,
                            "final_promotion_authorized": False,
                        }
                    ],
                }
            }
        )

        targets = renew._runtime_window_targets_from_plan(
            plan=plan,
            ref="exact-replay-plan-fixture",
            args=argparse.Namespace(),
        )

        self.assertEqual(len(targets), 1)
        target = targets[0]
        self.assertEqual(target.artifact_refs, ("exact-ledger.json",))
        self.assertEqual(
            target.target_metadata["exact_replay_ledger_artifact_refs"],
            ["exact-ledger.json"],
        )
        self.assertEqual(
            target.target_metadata["exact_replay_ledger_artifact_ref"],
            "exact-ledger.json",
        )
        self.assertEqual(
            target.target_metadata["exact_replay_ledger_artifact_row_count"],
            6,
        )
        self.assertEqual(
            target.target_metadata["exact_replay_ledger_artifact_fill_count"],
            2,
        )
        self.assertNotIn("runtime_ledger_artifact_ref", target.target_metadata)
        self.assertNotIn("runtime_ledger_artifact_refs", target.target_metadata)

    def test_offline_exact_replay_refs_ignore_runtime_aliases(self) -> None:
        refs = renew._offline_replay_exact_artifact_refs(
            {
                "target_metadata": {
                    "runtime_ledger_artifact_ref": "runtime-alias.json",
                    "runtime_ledger_artifact_refs": ["runtime-alias-2.json"],
                    "exact_replay_ledger_artifact_ref": "exact-ledger.json",
                    "exact_replay_ledger_artifact_refs": [
                        "exact-ledger.json",
                        "exact-ledger-2.json",
                    ],
                }
            }
        )

        self.assertEqual(refs, ["exact-ledger.json", "exact-ledger-2.json"])

    def test_hpairs_source_proof_census_status_is_non_authority_renewal_evidence(
        self,
    ) -> None:
        status = renew._hpairs_source_proof_census_status(
            {
                "schema_version": "torghut.hpairs-source-proof-census.v1",
                "identity": {"hypothesis_id": "H-PAIRS-01"},
                "window": {},
                "source": {
                    "kind": "fixture_json",
                    "read_only": True,
                    "writes_proof": False,
                    "modifies_rows": False,
                    "runtime_stage": "paper",
                    "replay_outputs_count_as_runtime_proof": False,
                    "synthetic_proof_created": False,
                },
                "runtime_authority": {
                    "final_authority_ok": False,
                    "blockers": ["runtime_ledger_source_materialization_missing"],
                },
                "missing_requirement_categories": {
                    "submitted_orders": False,
                    "filled_notional": False,
                },
                "missing_source_ref_categories": {
                    "runtime_ledger_source_materialization_missing": True,
                },
                "blocker_ladder": [
                    {
                        "step": "runtime_ledger_source_materialization_present",
                        "status": "blocked",
                        "blocker_codes": [
                            "runtime_ledger_source_materialization_missing"
                        ],
                    }
                ],
                "blockers": ["runtime_ledger_source_materialization_missing"],
                "verdict": {
                    "classification": "source_refs_missing",
                    "authority_candidate_ready": False,
                    "next_blocker": {
                        "step": "runtime_ledger_source_materialization_present"
                    },
                    "next_action": "backfill runtime-ledger source refs",
                },
                "totals": {"runtime_ledger_source_materialization_count": 0},
            }
        )

        self.assertTrue(status["present"])
        self.assertTrue(status["non_authority_status_only"])
        self.assertFalse(status["promotion_allowed"])
        self.assertFalse(status["final_authority_ok"])
        self.assertFalse(status["runtime_authority_final_ok"])
        self.assertFalse(status["census_ready"])
        self.assertEqual(
            status["blockers"],
            ["runtime_ledger_source_materialization_missing"],
        )
        self.assertEqual(
            status["next_blocker"]["step"],
            "runtime_ledger_source_materialization_present",
        )

    def test_hpairs_source_proof_census_attachment_blockers_block_renewal_authority(
        self,
    ) -> None:
        status = renew._hpairs_source_proof_census_status(
            {
                "schema_version": "torghut.hpairs-source-proof-census.v0",
                "identity": {"hypothesis_id": "H-PAIRS-01"},
                "window": {},
                "source": {
                    "kind": "fixture_json",
                    "read_only": False,
                    "writes_proof": True,
                    "modifies_rows": True,
                    "runtime_stage": "paper",
                    "replay_outputs_count_as_runtime_proof": True,
                    "synthetic_proof_created": True,
                },
                "runtime_authority": {
                    "final_authority_ok": True,
                    "blockers": [],
                },
                "missing_requirement_categories": {},
                "missing_source_ref_categories": {},
                "blocker_ladder": [],
                "blockers": [],
                "verdict": {
                    "classification": "authority_candidate_ready",
                    "authority_candidate_ready": True,
                    "next_blocker": None,
                    "next_action": "assemble authority proof packet",
                },
                "totals": {},
            }
        )

        blockers = [
            "hpairs_source_proof_census_schema_mismatch",
            "hpairs_source_proof_census_not_read_only",
            "hpairs_source_proof_census_writes_proof",
            "hpairs_source_proof_census_modifies_rows",
            "hpairs_source_proof_census_replay_outputs_claim_runtime_proof",
            "hpairs_source_proof_census_synthetic_proof_created",
        ]
        self.assertTrue(status["present"])
        self.assertFalse(status["promotion_allowed"])
        self.assertFalse(status["final_authority_ok"])
        self.assertTrue(status["runtime_authority_final_ok"])
        self.assertFalse(status["census_ready"])
        self.assertEqual(status["attachment_blockers"], blockers)
        for blocker in blockers:
            self.assertIn(blocker, status["blockers"])

    def test_hpairs_source_proof_census_ready_status_does_not_grant_renewal_authority(
        self,
    ) -> None:
        status = renew._hpairs_source_proof_census_status(
            {
                "schema_version": "torghut.hpairs-source-proof-census.v1",
                "identity": {"hypothesis_id": "H-PAIRS-01"},
                "window": {},
                "source": {
                    "kind": "fixture_json",
                    "read_only": True,
                    "writes_proof": False,
                    "modifies_rows": False,
                    "runtime_stage": "paper",
                    "replay_outputs_count_as_runtime_proof": False,
                    "synthetic_proof_created": False,
                },
                "runtime_authority": {
                    "final_authority_ok": True,
                    "blockers": [],
                },
                "missing_requirement_categories": {},
                "missing_source_ref_categories": {},
                "blocker_ladder": [],
                "blockers": [],
                "verdict": {
                    "classification": "authority_candidate_ready",
                    "authority_candidate_ready": True,
                    "next_blocker": None,
                    "next_action": "assemble authority proof packet",
                },
                "totals": {},
            }
        )

        self.assertTrue(status["present"])
        self.assertTrue(status["census_ready"])
        self.assertTrue(status["runtime_authority_final_ok"])
        self.assertFalse(status["promotion_allowed"])
        self.assertFalse(status["final_authority_ok"])

    def test_runtime_bucket_materialization_rerun_is_idempotent_for_same_scope(
        self,
    ) -> None:
        first_payload = _source_backed_runtime_ledger_bucket(
            net_strategy_pnl_after_costs="0.80"
        )
        second_payload = _source_backed_runtime_ledger_bucket(
            net_strategy_pnl_after_costs="1.25"
        )

        with self.session_local() as session:
            first_summary = persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(first_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            second_summary = persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(second_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            session.commit()
            rows = session.execute(select(StrategyRuntimeLedgerBucket)).scalars().all()

        self.assertEqual(
            first_summary["current_runtime_ledger_bucket_replacement_count"], 0
        )
        self.assertEqual(
            second_summary["current_runtime_ledger_bucket_replacement_count"], 1
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].account_label, "TORGHUT_SIM")
        self.assertEqual(
            rows[0].runtime_strategy_name,
            "microbar-cross-sectional-pairs-v1",
        )
        self.assertEqual(rows[0].net_strategy_pnl_after_costs, Decimal("1.25"))

    def test_runtime_bucket_materialization_keeps_hpairs_account_identity_separate(
        self,
    ) -> None:
        torghut_sim_payload = _source_backed_runtime_ledger_bucket(
            account_label="TORGHUT_SIM",
            net_strategy_pnl_after_costs="0.80",
        )
        alternate_account_payload = _source_backed_runtime_ledger_bucket(
            account_label="TORGHUT_SIM_ALT",
            net_strategy_pnl_after_costs="0.55",
            trade_decision_ids=["alt-decision-buy", "alt-decision-sell"],
            execution_ids=["alt-execution-buy", "alt-execution-sell"],
            execution_order_event_ids=["alt-event-fill-buy", "alt-event-fill-sell"],
            source_window_ids=["alt-source-window-buy", "alt-source-window-sell"],
            source_offsets=[
                {"topic": "alpaca.trade_updates", "partition": 1, "offset": 200},
                {"topic": "alpaca.trade_updates", "partition": 1, "offset": 201},
            ],
        )

        with self.session_local() as session:
            persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(torghut_sim_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            persist_observed_runtime_windows(
                session=session,
                run_id="hpairs-runtime-import",
                candidate_id="c88421d619759b2cfaa6f4d0",
                hypothesis_id="H-PAIRS-01",
                observed_stage="paper",
                strategy_family="microbar_cross_sectional_pairs",
                source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
                buckets=_observed_bucket_for_ledger_payload(alternate_account_payload),
                runtime_observation_payload={
                    "account_label": "TORGHUT_SIM_ALT",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "runtime_ledger_profit_proof_present": True,
                },
            )
            session.commit()
            rows = (
                session.execute(
                    select(StrategyRuntimeLedgerBucket).order_by(
                        StrategyRuntimeLedgerBucket.account_label
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(
            [row.account_label for row in rows], ["TORGHUT_SIM", "TORGHUT_SIM_ALT"]
        )
        self.assertEqual(
            [row.observed_stage for row in rows],
            ["paper", "paper"],
        )
        self.assertEqual(
            [row.runtime_strategy_name for row in rows],
            [
                "microbar-cross-sectional-pairs-v1",
                "microbar-cross-sectional-pairs-v1",
            ],
        )
