from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.assemble_runtime_ledger_proof_packet.support import (
    _TestRuntimeLedgerProofPacketBase,
    _completion,
    _paper_route_evidence,
    _runtime_import,
    _status,
    packet,
)


class TestPacketKeepsEconomicsBlockersOutOfMaterializationMissing(
    _TestRuntimeLedgerProofPacketBase
):
    def test_packet_keeps_economics_blockers_out_of_materialization_missing(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        item = runtime_import["imports"][0]
        assert isinstance(item, dict)
        summary = item["summary"]
        assert isinstance(summary, dict)
        observation = summary["runtime_observation"]
        assert isinstance(observation, dict)
        target = summary["runtime_materialization_target"]
        assert isinstance(target, dict)
        observation["runtime_ledger_profit_proof_blockers"] = [
            "runtime_ledger_bucket_blockers_present",
            "mean_daily_net_pnl_after_costs_below_500",
            "open_positions_present",
        ]
        observation["paper_route_target_notional_sizing_required_count"] = 1
        observation["paper_route_target_notional_sizing_authoritative_count"] = 0
        observation["paper_route_target_notional_sizing_missing_count"] = 1
        target["materialized"] = False
        target["proof_blockers"] = ["runtime_ledger_pnl_basis_missing"]

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
        self.assertEqual(result["verdict"], "blocked")
        self.assertTrue(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertFalse(
            result["checks"]["runtime_window_import_profit_proof_blockers"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 0)
        self.assertNotIn(
            "runtime_window_import_target_materialization_missing",
            materialization["blockers"],
        )
        self.assertNotIn(
            "runtime_window_import_runtime_ledger_materialization_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertIn(
            "paper_route_target_notional_sizing_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertNotIn(
            "run_runtime_window_import_from_paper_route_target_plan",
            result["required_actions"],
        )

    def test_packet_blocks_authority_when_runtime_import_readback_lacks_row_refs(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        target = runtime_import["imports"][0]["summary"][
            "runtime_materialization_target"
        ]
        assert isinstance(target, dict)
        readback = target["readback"]
        assert isinstance(readback, dict)
        readback["runtime_ledger_source_window_ids"] = []
        readback["runtime_ledger_execution_order_event_ids"] = []
        readback["execution_ids"] = []
        readback["trade_decision_ids"] = []
        readback["source_offsets"] = []
        readback["source_materializations"] = []
        readback["authority_classes"] = []
        readback["authority_reasons"] = []
        readback["runtime_ledger_cost_amount"] = None
        readback["cost_basis_counts"] = {}

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
            "runtime_ledger_source_window_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_ledger_execution_refs_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_ledger_trade_decision_refs_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_ledger_source_offsets_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_ledger_source_materialization_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_ledger_authority_class_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_ledger_explicit_costs_missing", materialization["blockers"]
        )

    def test_packet_blocks_authority_when_readback_lacks_authority_reason(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        target = runtime_import["imports"][0]["summary"][
            "runtime_materialization_target"
        ]
        assert isinstance(target, dict)
        readback = target["readback"]
        assert isinstance(readback, dict)
        readback["authority_reasons"] = []

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
            "runtime_ledger_authority_class_missing", materialization["blockers"]
        )
        self.assertIn(
            "runtime_ledger_authority_class_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_does_not_treat_promotion_only_import_metadata_as_unmaterialized(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation["runtime_ledger_target_metadata_blockers"] = [
            "paper_route_runtime_ledger_import_pending",
            "live_runtime_ledger_required",
            "paper_probation_evidence_collection_only",
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
        self.assertTrue(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 0)
        self.assertNotIn("live_runtime_ledger_required", materialization["blockers"])
        self.assertNotIn(
            "paper_probation_evidence_collection_only",
            materialization["blockers"],
        )

    def test_packet_blocks_when_any_runtime_import_target_lacks_materialization(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        runtime_import["imports"].append(
            {
                "status": "ok",
                "proof_status": "ok",
                "proof_blockers": [],
                "candidate_id": "cand-missing-proof",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-pairs-vwap-cap-safe",
                "account_label": "TORGHUT_SIM",
                "window_start": "2026-05-26T13:30:00+00:00",
                "window_end": "2026-05-26T20:00:00+00:00",
                "summary": {
                    "promotion_allowed": False,
                    "runtime_observation": {
                        "authoritative": True,
                        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                        "runtime_ledger_profit_proof_present": False,
                        "runtime_ledger_tca_profit_proof_count": 0,
                        "runtime_ledger_tca_authoritative_bucket_count": 0,
                    },
                },
            }
        )
        runtime_import["target_count"] = 2

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
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertEqual(
            materialization["unmaterialized_targets"][0]["candidate_id"],
            "cand-missing-proof",
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_has_no_observation(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        runtime_import["imports"][0]["summary"].pop("runtime_observation")

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
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertEqual(
            materialization["unmaterialized_targets"][0]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )
        self.assertIn(
            "runtime_window_import_runtime_observation_missing",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_runtime_observation_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_lacks_db_materialization_verdict(
        self,
    ) -> None:
        runtime_import = _runtime_import(materialization_target=False)

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
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_window_import_materialization_target_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_materialization_target_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_count_is_incomplete(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation.update(
            {
                "runtime_ledger_profit_proof_present": True,
                "runtime_ledger_tca_profit_proof_count": 1,
                "runtime_ledger_tca_authoritative_bucket_count": 1,
            }
        )
        runtime_import["target_count"] = 2

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
        self.assertEqual(materialization["materialized_target_count"], 1)
        self.assertEqual(materialization["missing_target_import_count"], 1)
        self.assertIn(
            "runtime_window_import_target_count_mismatch",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_count_mismatch",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_runtime_import_target_lacks_observation(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        first_import = runtime_import["imports"][0]
        assert isinstance(first_import, dict)
        first_summary = first_import["summary"]
        assert isinstance(first_summary, dict)
        first_summary.pop("runtime_observation")
        runtime_import["target_count"] = 2

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
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertEqual(materialization["missing_target_import_count"], 1)
        self.assertIn(
            "runtime_window_import_runtime_observation_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_count_mismatch",
            materialization["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_blocks_when_profit_proof_is_only_non_authoritative(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        first_observation = runtime_import["imports"][0]["summary"][
            "runtime_observation"
        ]
        assert isinstance(first_observation, dict)
        first_observation.update(
            {
                "authoritative": True,
                "authority_reason": "runtime_without_runtime_ledger_profit_proof",
                "runtime_ledger_profit_proof_present": False,
                "runtime_ledger_tca_profit_proof_count": 0,
                "runtime_ledger_tca_authoritative_bucket_count": 0,
                "runtime_ledger_source_execution_materialized_bucket_count": 0,
                "runtime_ledger_source_bucket_profit_proof_count": 0,
            }
        )
        runtime_import["imports"].append(
            {
                "status": "ok",
                "proof_status": "ok",
                "proof_blockers": [],
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-pairs-vwap-cap-safe",
                "account_label": "TORGHUT_SIM",
                "window_start": "2026-05-26T13:30:00+00:00",
                "window_end": "2026-05-26T20:00:00+00:00",
                "summary": {
                    "promotion_allowed": False,
                    "runtime_observation": {
                        "authoritative": False,
                        "authority_reason": "simulation_source_replay_only",
                        "runtime_ledger_profit_proof_present": True,
                        "runtime_ledger_tca_profit_proof_count": 1,
                    },
                },
            }
        )
        runtime_import["target_count"] = 2

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
        self.assertEqual(
            materialization["authoritative_observation_count"],
            1,
        )
        self.assertEqual(
            materialization["runtime_ledger_profit_proof_count"],
            1,
        )
        self.assertEqual(
            materialization["authoritative_runtime_ledger_profit_proof_count"],
            0,
        )
        self.assertEqual(
            materialization["non_authoritative_runtime_ledger_profit_proof_count"],
            1,
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_does_not_count_authority_reason_as_profit_proof(self) -> None:
        runtime_import = _runtime_import(authoritative=False)
        observation = runtime_import["imports"][0]["summary"]["runtime_observation"]
        assert isinstance(observation, dict)
        observation.update(
            {
                "authoritative": True,
                "authority_reason": "runtime_ledger_profit_proof",
                "runtime_ledger_profit_proof_present": False,
                "runtime_ledger_tca_profit_proof_count": 0,
                "runtime_ledger_source_bucket_profit_proof_count": 0,
                "runtime_ledger_durable_bucket_profit_proof_count": 0,
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
        self.assertFalse(result["ok"])
        self.assertEqual(materialization["runtime_ledger_profit_proof_count"], 0)
        self.assertEqual(
            materialization["authoritative_runtime_ledger_profit_proof_count"],
            0,
        )
        self.assertIn(
            "runtime_window_import_target_profit_proof_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )

    def test_packet_blocks_runtime_import_without_materialized_runtime_ledger(
        self,
    ) -> None:
        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=_paper_route_evidence(),
            runtime_window_import=_runtime_import(authoritative=False),
            completion_status=_completion(),
            generated_at="2026-05-26T21:05:00+00:00",
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_window_import_runtime_ledger_materialization_missing",
            result["promotion_authority"]["blocking_reasons"],
        )
        self.assertFalse(
            result["checks"]["runtime_window_import_materialization"]["passed"]
        )
        self.assertIn(
            "run_runtime_window_import_from_paper_route_target_plan",
            result["required_actions"],
        )

    def test_packet_materialization_marks_non_authoritative_empty_target(
        self,
    ) -> None:
        runtime_import = _runtime_import(authoritative=False)

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
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        self.assertIn(
            "runtime_window_import_observation_not_authoritative",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_profit_proof_missing",
            materialization["unmaterialized_targets"][0]["blockers"],
        )
        self.assertIn(
            "runtime_window_import_target_materialization_missing",
            materialization["blockers"],
        )

    def test_packet_surfaces_target_materialization_count_and_string_blockers(
        self,
    ) -> None:
        runtime_import = _runtime_import()
        first_import = runtime_import["imports"][0]
        assert isinstance(first_import, dict)
        first_summary = first_import["summary"]
        assert isinstance(first_summary, dict)
        target = first_summary["runtime_materialization_target"]
        assert isinstance(target, dict)
        target.update(
            {
                "metric_window_count": 0,
                "promotion_decision_count": 0,
                "runtime_ledger_bucket_count": 0,
                "evidence_grade_runtime_ledger_bucket_count": 0,
                "materialization_blockers": [],
                "proof_blockers": ["source_runtime_ledger_missing"],
                "materialized": False,
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
        self.assertFalse(result["ok"])
        self.assertEqual(materialization["materialized_target_count"], 0)
        self.assertEqual(materialization["unmaterialized_target_count"], 1)
        target_blockers = materialization["unmaterialized_targets"][0]["blockers"]
        self.assertIn("runtime_window_import_metric_window_missing", target_blockers)
        self.assertIn(
            "runtime_window_import_promotion_decision_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing",
            target_blockers,
        )
        self.assertIn("source_runtime_ledger_missing", target_blockers)

    def test_packet_blocks_count_only_runtime_import_materialization(self) -> None:
        runtime_import = _runtime_import()
        first_import = runtime_import["imports"][0]
        assert isinstance(first_import, dict)
        first_summary = first_import["summary"]
        assert isinstance(first_summary, dict)
        target = first_summary["runtime_materialization_target"]
        assert isinstance(target, dict)
        target["metric_window_ids"] = []
        target["promotion_decision_id"] = None
        target["runtime_ledger_bucket_ids"] = []
        target["evidence_grade_runtime_ledger_bucket_ids"] = []

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
        target_blockers = materialization["unmaterialized_targets"][0]["blockers"]
        self.assertIn(
            "runtime_window_import_metric_window_refs_missing", target_blockers
        )
        self.assertIn(
            "runtime_window_import_promotion_decision_ref_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_refs_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_refs_missing",
            target_blockers,
        )
        self.assertIn(
            "runtime_window_import_runtime_ledger_bucket_refs_missing",
            result["promotion_authority"]["blocking_reasons"],
        )

    def test_packet_waits_on_target_level_settlement_blocker(self) -> None:
        paper = _paper_route_evidence()
        target = paper["next_paper_route_runtime_window_targets"]["targets"][0]
        assert isinstance(target, dict)
        target["paper_route_session_import_blockers"] = [
            "paper_route_session_settlement_pending"
        ]

        result = packet.build_runtime_ledger_proof_packet(
            _status(),
            proof_mode="authority",
            paper_route_evidence=paper,
            generated_at="2026-05-26T20:01:00+00:00",
        )

        self.assertEqual(result["verdict"], "waiting_for_runtime_window")
        self.assertEqual(
            result["promotion_authority"]["blocking_reasons"],
            ["paper_route_session_settlement_pending"],
        )
        self.assertEqual(
            result["required_actions"],
            ["wait_for_paper_route_settlement_grace"],
        )
