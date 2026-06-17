from __future__ import annotations

# ruff: noqa: F401
from tests.run_empirical_promotion_jobs.support import (
    MagicMock,
    RunEmpiricalPromotionJobsTestCase,
    SimpleNamespace,
    json,
    patch,
    renewal,
)


def _empty_proofs_response() -> MagicMock:
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps(
        {
            "schema_version": "torghut.proofs.v1",
            "summary": {"proof_count": 0},
        }
    ).encode("utf-8")
    return response


def _runtime_window_plan_args() -> SimpleNamespace:
    return SimpleNamespace(
        runtime_window_target=[],
        runtime_window_target_plan_ref=[],
        runtime_window_target_plan_url=[
            "http://torghut-sim.torghut.svc.cluster.local/trading/proofs",
            "http://torghut.torghut.svc.cluster.local/trading/status",
        ],
        runtime_window_target_plan_url_timeout_seconds=1.0,
        runtime_window_target_plan_url_attempts=1,
        runtime_window_target_plan_url_retry_backoff_seconds=0.0,
        runtime_window_target_plan_required=True,
        runtime_window_target_plan_exclusive=True,
        runtime_window_targets_from_latest_autoresearch=True,
        runtime_window_targets_from_registry=True,
        runtime_window_hypothesis_id="",
        runtime_window_candidate_id="",
        runtime_window_observed_stage="paper",
        runtime_window_strategy_family="",
        runtime_window_source_dsn_env="SIM_DB_DSN",
        runtime_window_strategy_name="",
        runtime_window_account_label="TORGHUT_SIM",
        runtime_window_dataset_snapshot_ref="",
        runtime_window_source_manifest_ref="",
        runtime_window_source_kind="paper_runtime_observed",
    )


class TestRunEmpiricalPromotionJobsRuntimeWindowTargetPlanMultiRef(
    RunEmpiricalPromotionJobsTestCase
):
    def test_runtime_window_target_plan_url_uses_later_ref_when_first_plan_empty(
        self,
    ) -> None:
        live_status_plan = MagicMock()
        live_status_plan.__enter__.return_value.read.return_value = json.dumps(
            {
                "schema_version": "torghut.trading-status.v1",
                "live_submission_gate": {
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "source": "runtime_ledger_paper_probation_and_source_collection_candidates",
                        "target_count": 1,
                        "source_collection_target_count": 1,
                        "paper_route_target_count": 0,
                        "targets": [
                            {
                                "candidate_id": "cand-source-collection",
                                "hypothesis_id": "H-PAIRS-01",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "source_kind": "runtime_ledger_source_collection_candidate",
                                "source_collection_authorized": True,
                            }
                        ],
                    },
                },
            }
        ).encode("utf-8")

        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[_empty_proofs_response(), live_status_plan],
            ) as urlopen,
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
            ) as latest,
            patch.object(renewal, "_registry_runtime_window_targets") as registry,
        ):
            targets = renewal._runtime_window_targets(_runtime_window_plan_args())

        self.assertEqual(urlopen.call_count, 2)
        latest.assert_not_called()
        registry.assert_not_called()
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].candidate_id, "cand-source-collection")
        self.assertEqual(
            targets[0].source_kind, "runtime_ledger_source_collection_candidate"
        )

    def test_runtime_window_target_plan_url_required_fails_when_all_refs_empty(
        self,
    ) -> None:
        with (
            patch.object(
                renewal.urllib.request,
                "urlopen",
                side_effect=[_empty_proofs_response(), _empty_proofs_response()],
            ) as urlopen,
            patch.object(
                renewal,
                "_latest_autoresearch_runtime_window_targets",
            ) as latest,
            patch.object(renewal, "_registry_runtime_window_targets") as registry,
            self.assertRaisesRegex(
                RuntimeError,
                "runtime_window_target_plan_required_but_empty",
            ),
        ):
            renewal._runtime_window_targets(_runtime_window_plan_args())

        self.assertEqual(urlopen.call_count, 2)
        latest.assert_not_called()
        registry.assert_not_called()
