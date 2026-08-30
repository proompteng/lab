from __future__ import annotations


import app.trading.discovery.evidence_bundles as evidence_bundles
import scripts.whitepaper_autoresearch_runner.candidate_goal_metadata as candidate_goal_metadata

from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)
import scripts.whitepaper_autoresearch_runner.common as runner_common


class TestCandidateSleeveGoalProofHandoffSurfacesRuntimeLedgerMaterialization(
    AutoresearchRunnerTestCase
):
    def test_candidate_sleeve_goal_proof_handoff_surfaces_runtime_ledger_materialization(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-sleeve-runtime-ledger-handoff")
        runtime_ledger_handoff = {
            "materialization_status": "lineage_unmaterialized",
            "runtime_ledger_required": True,
            "zero_authoritative_daily_pnl_until_materialized": True,
            "required_artifacts": "runtime-ledger/daily-pnl.json",
        }
        evidence = evidence_bundles.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-sleeve-runtime-ledger-handoff",
            candidate_id="cand-sleeve-runtime-ledger-handoff",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-sleeve-runtime-ledger-handoff",
            feature_spec_hash="hash-sleeve-runtime-ledger-handoff",
            code_commit="commit-test",
            replay_artifact_refs=("sleeve-runtime-ledger-handoff.json",),
            objective_scorecard={},
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={
                "runtime_ledger_lineage_materialization_handoff": (
                    runtime_ledger_handoff
                )
            },
        )

        proof_handoff = (
            candidate_goal_metadata._candidate_sleeve_goal_proof_handoff_fields(
                selection={"selected_for_replay": True},
                spec=spec,
                scorecard=evidence.objective_scorecard,
                evidence=evidence,
                selected_for_replay=True,
            )
        )

        self.assertEqual(
            proof_handoff["runtime_ledger_lineage_materialization_handoff"],
            runtime_ledger_handoff,
        )
        self.assertEqual(
            proof_handoff["runtime_ledger_required_materialized_artifacts"],
            ["runtime-ledger/daily-pnl.json"],
        )
        self.assertEqual(
            proof_handoff["runtime_ledger_materialization_status"],
            "lineage_unmaterialized",
        )
        self.assertTrue(
            proof_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertEqual(
            runner_common._candidate_board_runtime_ledger_required_materialized_artifacts(
                {}
            ),
            [],
        )
        self.assertEqual(
            runner_common._candidate_board_runtime_ledger_required_materialized_artifacts(
                {"required_materialized_artifacts": "runtime-ledger/string.json"}
            ),
            ["runtime-ledger/string.json"],
        )
        self.assertEqual(
            runner_common._candidate_board_runtime_ledger_required_materialized_artifacts(
                {
                    "required_materialized_artifacts": [
                        {"path": "runtime-ledger/path.json"},
                        {"name": "runtime-ledger/name.json"},
                        {"artifact": "runtime-ledger/artifact.json"},
                        "runtime-ledger/raw.json",
                        {"kind": "missing-ref"},
                    ]
                }
            ),
            [
                "runtime-ledger/path.json",
                "runtime-ledger/name.json",
                "runtime-ledger/artifact.json",
                "runtime-ledger/raw.json",
            ],
        )

        scorecard_handoff = {
            "status": "requires_runtime_ledger_materialization_before_authority",
            "zero_authoritative_daily_pnl_until_materialized": True,
            "required_materialized_artifacts": [
                {"ref": "runtime-ledger/scorecard-ref.json"}
            ],
        }
        scorecard_proof_handoff = (
            candidate_goal_metadata._candidate_sleeve_goal_proof_handoff_fields(
                selection={},
                spec=None,
                scorecard={
                    "runtime_ledger_lineage_materialization_handoff": scorecard_handoff
                },
                evidence=None,
                selected_for_replay=False,
            )
        )
        self.assertEqual(
            scorecard_proof_handoff["runtime_ledger_lineage_materialization_handoff"],
            scorecard_handoff,
        )
        self.assertEqual(
            scorecard_proof_handoff["runtime_ledger_required_materialized_artifacts"],
            ["runtime-ledger/scorecard-ref.json"],
        )
        self.assertEqual(
            scorecard_proof_handoff["runtime_ledger_materialization_status"],
            "requires_runtime_ledger_materialization_before_authority",
        )
        self.assertTrue(
            scorecard_proof_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
