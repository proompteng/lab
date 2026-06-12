from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.fast_replay.support import *


class TestFastReplayPreviewPart3(_TestFastReplayPreviewBase):
    def test_macro_regime_impact_veto_fields_downrank_without_promotion_authority(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=1, price="100", ofi="0.50", stress=True
                ),
                self._signal(
                    symbol="AAA", offset=2, price="101", ofi="0.60", stress=True
                ),
                self._signal(
                    symbol="AAA", offset=3, price="102", ofi="0.70", stress=True
                ),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-stress-boundary",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "stress"}),
                feature_schema_hash="feature-stress",
                cost_model_hash="cost-stress",
                strategy_family="hpairs-stress",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec(
                    "spec-stress-boundary",
                    symbols=["AAA"],
                    max_notional_per_trade="2500000",
                ),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )
        payload = preview.rows[0].to_payload()

        self.assertGreater(Decimal(payload["macro_stress_veto_score"]), Decimal("0"))
        self.assertIn(
            "macro_news_stress_slice_veto_or_downrank", payload["risk_veto_reasons"]
        )
        self.assertIn(
            "macro_news_ofi_stress_slice_downranks_only",
            payload["ranking_only_reasons"],
        )
        self.assertIn(
            "square_root_impact_capacity_penalty", payload["risk_veto_reasons"]
        )
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_cost_capacity_lineage_blocks_exact_replay_selection(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
                    + timedelta(minutes=index),
                    symbol="AAA",
                    timeframe="1Min",
                    seq=index,
                    source="test",
                    payload={"price": Decimal(str(100 + index))},
                    ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
                )
                for index in range(1, 4)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-lineage-blocked",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest(
                    {"window": "lineage-blocked"}
                ),
                feature_schema_hash="feature-lineage-blocked",
                cost_model_hash="cost-lineage-blocked",
                strategy_family="hpairs-lineage-blocked",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec(
                    "spec-lineage-blocked",
                    symbols=["AAA"],
                    max_notional_per_trade="0",
                ),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=0,
            exact_replay_candidate_cap=1,
        )

        self.assertEqual(preview.selected_candidate_spec_ids, ())
        self.assertEqual(preview.exploitation_candidate_count, 0)
        row = preview.rows[0]
        payload = row.to_payload()
        self.assertFalse(payload["selected"])
        self.assertEqual(
            payload["selection_reason"], "fast_replay_frontier_lineage_blocked"
        )
        self.assertTrue(payload["exact_replay_selection_blocked"])
        self.assertIn(
            "cost_lineage_spread_missing",
            payload["exact_replay_selection_blockers"],
        )
        self.assertIn(
            "adv_capacity_lineage_volume_missing",
            payload["exact_replay_selection_blockers"],
        )
        self.assertIn(
            "candidate_notional_lineage_missing",
            payload["exact_replay_selection_blockers"],
        )
        self.assertIn("source_backed_adv_missing", payload["lineage_blockers"])
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_replay_tape_identity_reports_lineage_blockers(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=index, price=str(100 + index), ofi="0.50"
                )
                for index in range(1, 4)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-missing-identity",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest(
                    {"window": "missing-identity"}
                ),
            )

        preview = build_fast_replay_preview(
            specs=(self._spec("spec-missing-identity", symbols=["AAA"]),),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=0,
            exact_replay_candidate_cap=1,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids, ("spec-missing-identity",)
        )
        payload = preview.rows[0].to_payload()
        self.assertEqual(
            payload["selection_reason"], "fast_replay_frontier_exploitation_selected"
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_feature_schema_hash",
            payload["lineage_blockers"],
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_cost_model_hash",
            payload["lineage_blockers"],
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_strategy_family",
            payload["lineage_blockers"],
        )
        self.assertTrue(payload["frontier_selection"]["exact_replay_enqueue_allowed"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_frontier_selection_dedupes_equivalent_exact_replay_targets(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=index, price=str(100 + index), ofi="0.50"
                )
                for index in range(1, 6)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-dedupe",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "dedupe"}),
                feature_schema_hash="feature-dedupe",
                cost_model_hash="cost-dedupe",
                strategy_family="hpairs-dedupe",
            )
        representative = self._spec("spec-a-representative", symbols=["AAA"])
        duplicate = self._spec("spec-b-duplicate", symbols=["AAA"])
        unique = self._spec(
            "spec-c-unique",
            symbols=["AAA"],
            max_notional_per_trade="5000",
        )

        preview = build_fast_replay_preview(
            specs=(representative, duplicate, unique),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=3,
            min_rows_per_candidate=2,
            exploitation_count=3,
            exploration_count=0,
            exact_replay_candidate_cap=3,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids,
            ("spec-a-representative", "spec-c-unique"),
        )
        payloads = {row.candidate_spec_id: row.to_payload() for row in preview.rows}
        representative_payload = payloads["spec-a-representative"]
        duplicate_payload = payloads["spec-b-duplicate"]
        self.assertEqual(
            representative_payload["frontier_dedupe_status"], "representative"
        )
        self.assertEqual(
            duplicate_payload["frontier_dedupe_status"], "duplicate_filtered"
        )
        self.assertEqual(
            duplicate_payload["selection_reason"],
            "fast_replay_frontier_duplicate_filtered",
        )
        self.assertFalse(duplicate_payload["selected"])
        self.assertEqual(
            duplicate_payload["duplicate_of_candidate_spec_id"],
            "spec-a-representative",
        )
        self.assertEqual(
            representative_payload["candidate_frontier_hash"],
            duplicate_payload["candidate_frontier_hash"],
        )
        self.assertEqual(
            representative_payload["exact_replay_frontier_key"],
            duplicate_payload["exact_replay_frontier_key"],
        )
        self.assertFalse(
            duplicate_payload["frontier_dedupe_metadata"]["proof_authority"]
        )
        self.assertFalse(
            duplicate_payload["frontier_dedupe_metadata"]["promotion_allowed"]
        )
        self.assertFalse(
            duplicate_payload["frontier_dedupe_metadata"]["final_authority_ok"]
        )
        manifest_payload = preview.to_manifest_payload()
        self.assertEqual(
            manifest_payload["frontier_dedupe_policy"]["status"], "enabled"
        )
        self.assertFalse(
            manifest_payload["frontier_dedupe_policy"]["promotion_allowed"]
        )
        self.assertFalse(
            manifest_payload["frontier_dedupe_policy"]["final_authority_ok"]
        )
