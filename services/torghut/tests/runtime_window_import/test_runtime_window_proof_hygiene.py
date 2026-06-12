from __future__ import annotations

# ruff: noqa: F403,F405
from tests.runtime_window_import.runtime_window_import_base import *


class TestRuntimeWindowImportProofHygiene(RuntimeWindowImportTestCaseBase):
    def test_runtime_ledger_tca_rows_from_source_dsn_block_no_source_refs(
        self,
    ) -> None:
        cursor = _SourceLedgerCursor()
        row = list(cursor._results[0][0])
        payload = dict(cast(Mapping[str, object], row[-1]))
        payload.update({"source_refs": [], "source_row_counts": {}})
        row[-1] = payload
        cursor._results[0] = [tuple(row)]
        connection = _SourceLedgerConnection(cursor)
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)

        with patch(
            "scripts.import_hypothesis_runtime_windows.psycopg.connect",
            return_value=connection,
        ):
            rows, metadata = _runtime_ledger_tca_rows_from_source_dsn(
                dsn="postgresql://source",
                candidate_id="H-TSMOM-LIQ-01",
                hypothesis_id="H-TSMOM-LIQ-01",
                observed_stage="paper",
                strategy_names=["intraday-tsmom-profit-v3"],
                account_label="TORGHUT_SIM",
                window_start=window_start,
                window_end=window_end,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(metadata["runtime_ledger_source_bucket_profit_proof_count"], 0)
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            metadata["runtime_ledger_source_bucket_profit_proof_blockers"],
        )
        self.assertEqual(rows[0]["post_cost_promotion_eligible"], False)
        bucket = rows[0]["runtime_ledger_bucket"]
        self.assertIsInstance(bucket, dict)
        assert isinstance(bucket, dict)
        self.assertIn(
            "postgres:strategy_runtime_ledger_buckets:source-runtime-ledger-bucket-1",
            bucket["source_refs"],
        )
        self.assertEqual(
            bucket["source_row_counts"],
            {"strategy_runtime_ledger_buckets": 1},
        )
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            rows[0]["runtime_ledger_blockers"],
        )

    def test_parse_target_metadata_requires_json_mapping(self) -> None:
        self.assertEqual(_parse_target_metadata(""), {})
        self.assertEqual(
            _parse_target_metadata('{"paper_probation_authorized": true}'),
            {"paper_probation_authorized": True},
        )
        with self.assertRaisesRegex(RuntimeError, "target_metadata_json_invalid"):
            _parse_target_metadata("{")
        with self.assertRaisesRegex(RuntimeError, "target_metadata_json_not_mapping"):
            _parse_target_metadata("[]")

    def test_runtime_ledger_target_metadata_blockers_fail_closed_on_mismatch(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        artifact_metadata = {
            "runtime_ledger_artifact_refs": ["exact-ledger.json"],
            "runtime_ledger_artifact_authority_class": (
                "exact_replay_artifact_only_not_live"
            ),
            "runtime_ledger_artifact_candidate_id": "cand-one",
            "runtime_ledger_artifact_row_count": 6,
            "runtime_ledger_artifact_fill_count": 2,
            "runtime_ledger_artifact_window_weekday_count": 5,
        }

        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "candidate_id": "cand-one",
                    "runtime_ledger_artifact_row_count": 6,
                    "runtime_ledger_artifact_fill_count": 2,
                    "replay_window_weekday_count": 5,
                    "replay_min_window_weekday_count": 5,
                    "window_start": "2026-03-06T14:30:00+00:00",
                    "window_end": "2026-03-06T15:00:00+00:00",
                },
                runtime_ledger_artifact_metadata=artifact_metadata,
                window_start=window_start,
                window_end=window_end,
            ),
            [],
        )
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "runtime_ledger_artifact_refs": ["different-ledger.json"],
                    "candidate_id": "different-cand",
                    "runtime_ledger_artifact_row_count": 7,
                    "runtime_ledger_artifact_fill_count": 3,
                    "replay_window_weekday_count": 4,
                    "replay_min_window_weekday_count": 20,
                    "window_start": "2026-03-06T14:35:00+00:00",
                    "window_end": "2026-03-06T15:00:00+00:00",
                },
                runtime_ledger_artifact_metadata=artifact_metadata,
                window_start=window_start,
                window_end=window_end,
            ),
            [
                "runtime_ledger_artifact_refs_mismatch",
                "runtime_ledger_artifact_row_count_mismatch",
                "runtime_ledger_artifact_fill_count_mismatch",
                "runtime_ledger_window_bounds_mismatch",
                "runtime_ledger_artifact_candidate_id_mismatch",
                "runtime_ledger_artifact_window_weekday_count_mismatch",
                "runtime_ledger_artifact_window_weekday_count_below_min",
            ],
        )
        artifact_metadata_without_class = {
            key: value
            for key, value in artifact_metadata.items()
            if key != "runtime_ledger_artifact_authority_class"
        }
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "candidate_id": "cand-one",
                },
                runtime_ledger_artifact_metadata=artifact_metadata_without_class,
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_authority_class_missing"],
        )

    def test_runtime_ledger_target_metadata_blocks_missing_or_mixed_candidate_ids(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        target_metadata = {
            "runtime_ledger_artifact_refs": ["exact-ledger.json"],
            "candidate_id": "cand-one",
        }

        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata=target_metadata,
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "runtime_ledger_artifact_authority_class": (
                        "exact_replay_artifact_only_not_live"
                    ),
                    "runtime_ledger_artifact_row_count": 6,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_candidate_id_missing"],
        )
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata=target_metadata,
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "runtime_ledger_artifact_authority_class": (
                        "exact_replay_artifact_only_not_live"
                    ),
                    "runtime_ledger_artifact_candidate_ids": [
                        "cand-one",
                        "cand-two",
                    ],
                    "runtime_ledger_artifact_row_count": 6,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_candidate_id_ambiguous"],
        )
        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata=target_metadata,
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": ["exact-ledger.json"],
                    "runtime_ledger_artifact_authority_class": (
                        "exact_replay_artifact_only_not_live"
                    ),
                    "runtime_ledger_artifact_candidate_ids": ["different-cand"],
                    "runtime_ledger_artifact_row_count": 6,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            ["runtime_ledger_artifact_candidate_id_mismatch"],
        )

    def test_runtime_ledger_target_metadata_does_not_require_artifact_candidate_for_source_dsn(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 13, 17, 0, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 13, 17, 30, tzinfo=timezone.utc)

        self.assertEqual(
            _runtime_ledger_target_metadata_blockers(
                target_metadata={
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "window_start": "2026-05-13T17:00:00+00:00",
                    "window_end": "2026-05-13T17:30:00+00:00",
                },
                runtime_ledger_artifact_metadata={
                    "runtime_ledger_artifact_refs": [],
                    "runtime_ledger_ignored_artifact_refs": [],
                    "runtime_ledger_artifact_row_count": 0,
                    "runtime_ledger_artifact_fill_count": 0,
                    "runtime_ledger_artifact_tca_row_count": 0,
                },
                window_start=window_start,
                window_end=window_end,
            ),
            [],
        )

    def test_runtime_window_proof_hygiene_blocks_missing_authoritative_gates(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="paper_runtime_observed",
                target_metadata={},
                dependency_quorum_decision="",
                continuity_ok="",
                drift_ok="",
            ),
            [
                "runtime_window_target_metadata_missing",
                "dependency_quorum_decision_missing",
                "continuity_gate_missing",
                "drift_gate_missing",
            ],
        )
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="simulation_paper_runtime",
                target_metadata={},
                dependency_quorum_decision="",
                continuity_ok="",
                drift_ok="",
            ),
            [
                "dependency_quorum_decision_missing",
                "continuity_gate_missing",
                "drift_gate_missing",
            ],
        )
        self.assertTrue(
            _runtime_window_source_kind_is_informational(
                source_kind="non-authoritative-selection",
                target_metadata={},
            )
        )

    def test_runtime_window_proof_hygiene_carries_target_metadata_blockers(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="paper_runtime_observed",
                target_metadata={
                    "runtime_ledger_target_metadata_blockers": [
                        "existing_target_blocker"
                    ],
                    "runtime_window_import_health_gate_blockers": [
                        "health_gate_blocker"
                    ],
                    "candidate_blockers": ["candidate_blocker"],
                    "runtime_window_import_audit_blockers": [
                        "paper_route_account_contamination_detected",
                        "unlinked_order_events_present",
                    ],
                    "runtime_window_import_audit_target_blockers": [
                        "runtime_ledger_evidence_grade_bucket_missing"
                    ],
                },
                dependency_quorum_decision="allow",
                continuity_ok="ok",
                drift_ok="ok",
            ),
            [
                "existing_target_blocker",
                "health_gate_blocker",
                "candidate_blocker",
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
                "runtime_ledger_evidence_grade_bucket_missing",
            ],
        )

    def test_source_kind_allows_authoritative_materialization_only_for_observed_runtime(
        self,
    ) -> None:
        self.assertTrue(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="paper_route_probe_runtime_observed",
                target_metadata={"paper_route_probe_symbols": ["AAPL"]},
            )
        )
        self.assertFalse(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="simulation_paper_runtime",
                target_metadata={"paper_route_probe_symbols": ["AAPL"]},
            )
        )
        self.assertTrue(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="paper_runtime_observed",
                target_metadata={"evidence_scope": "evidence_collection_only"},
            )
        )
        self.assertTrue(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                    "runtime_ledger_target_metadata_blockers": [
                        "runtime_ledger_source_window_evidence_pending"
                    ],
                },
            )
        )
        self.assertFalse(
            _runtime_window_source_kind_is_informational(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                },
            )
        )
        self.assertFalse(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    )
                },
            )
        )
        self.assertFalse(
            _source_kind_allows_runtime_ledger_materialization(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={"source_collection_authorized": True},
            )
        )
        self.assertFalse(
            _runtime_window_source_kind_is_informational(
                source_kind="paper_route_probe_runtime_observed",
                target_metadata={
                    "paper_probation_authorization_scope": "evidence_collection_only"
                },
            )
        )

    def test_runtime_window_proof_hygiene_requires_source_collection_authorization(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                    "runtime_ledger_target_metadata_blockers": [
                        "runtime_ledger_source_collection_only",
                        "live_runtime_ledger_required",
                    ],
                },
                dependency_quorum_decision="",
                continuity_ok="",
                drift_ok="",
            ),
            [
                "runtime_ledger_source_collection_only",
                "live_runtime_ledger_required",
            ],
        )
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    )
                },
                dependency_quorum_decision="allow",
                continuity_ok="ok",
                drift_ok="ok",
            ),
            ["source_collection_authorization_missing"],
        )
        self.assertEqual(
            _runtime_window_import_proof_hygiene_blockers(
                source_kind="runtime_ledger_source_collection_candidate",
                target_metadata={"source_collection_authorized": True},
                dependency_quorum_decision="allow",
                continuity_ok="ok",
                drift_ok="ok",
            ),
            ["source_collection_authorization_scope_invalid"],
        )

    def test_source_activity_missing_summary_includes_proof_hygiene_blockers(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        summary = _source_activity_missing_summary(
            run_id="run-source-missing",
            candidate_id="cand-1",
            hypothesis_id="H-PAIRS-01",
            observed_stage="paper",
            strategy_name="microbar-cross-sectional-pairs-v1",
            strategy_names=["microbar-cross-sectional-pairs-v1"],
            account_label="TORGHUT_SIM",
            window_start=window_start,
            window_end=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
            source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
            source_kind="paper_runtime_observed",
            dataset_snapshot_ref="snapshot-1",
            proof_hygiene_blockers=("runtime_window_target_metadata_missing",),
            source_activity_diagnostics={
                "strategy_name_candidates": ["microbar-cross-sectional-pairs-v1"],
                "account_label": "TORGHUT_SIM",
                "source_activity_symbol_filter": ["AAPL"],
                "decision_rows_before_lineage_filter": 2,
                "decision_rows_after_lineage_filter": 0,
                "execution_rows_before_lineage_filter": 1,
                "execution_rows_after_lineage_filter": 0,
                "runtime_ledger_source_bucket_count": 0,
            },
        )

        self.assertEqual(summary["proof_status"], "blocked")
        self.assertEqual(
            [item["blocker"] for item in summary["proof_blockers"]],
            [
                "runtime_window_source_activity_missing",
                "runtime_window_target_metadata_missing",
            ],
        )
        self.assertEqual(
            summary["source_activity_diagnostics"][
                "decision_rows_before_lineage_filter"
            ],
            2,
        )
        self.assertIn(
            "source_lineage_filter_excluded_activity",
            summary["promotion_blocking_reasons"],
        )
        self.assertIn(
            "runtime_ledger_source_bucket_missing",
            summary["runtime_observation"]["source_activity_diagnostic_blockers"],
        )
