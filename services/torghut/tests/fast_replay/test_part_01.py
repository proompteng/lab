from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.fast_replay.support import *
from tests.fast_replay.preview_assertions_a import (
    assert_fast_replay_preview_mechanism_payloads,
)
from tests.fast_replay.preview_assertions_b import (
    assert_fast_replay_preview_lineage_payloads,
)


class TestFastReplayPreviewPart1(_TestFastReplayPreviewBase):
    def test_whitepaper_features_rank_and_label_preview_only(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=1, price="100", ofi="0.65", event_type="add"
                ),
                self._signal(
                    symbol="AAA", offset=2, price="101", ofi="0.80", event_type="trade"
                ),
                self._signal(
                    symbol="AAA", offset=3, price="102", ofi="0.85", event_type="cancel"
                ),
                self._signal(
                    symbol="BBB", offset=1, price="100", ofi="-0.10", stress=True
                ),
                self._signal(
                    symbol="BBB", offset=2, price="99", ofi="-0.20", stress=True
                ),
                self._signal(
                    symbol="BBB", offset=3, price="98", ofi="-0.20", stress=True
                ),
            ]
            source_query_digest = build_source_query_digest({"window": "fast"})
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-fast",
                symbols=("AAA", "BBB"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=source_query_digest,
                source_table_versions={"signals": "v1"},
                feature_schema_hash="feature-fast",
                cost_model_hash="cost-fast",
                strategy_family="hpairs-fast",
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec("spec-good", symbols=["AAA"]),
                self._spec("spec-stress", symbols=["BBB"], selection_mode="reversal"),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=2,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids, ("spec-good", "spec-stress")
        )
        good, stress = preview.rows
        self.assertEqual(good.candidate_spec_id, "spec-good")
        self.assertGreater(good.cluster_lob_activity_score, Decimal("0"))
        self.assertGreater(good.ofi_decay_alignment_score, Decimal("0"))
        self.assertEqual(good.frontier_bucket, "exploitation")
        self.assertEqual(stress.frontier_bucket, "exploration")
        self.assertGreater(stress.macro_stress_veto_score, Decimal("0"))
        payload = preview.to_manifest_payload()
        row_payload = good.to_payload()
        stress_payload = stress.to_payload()
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])
        self.assertFalse(row_payload["final_authority_ok"])
        self.assertEqual(
            payload["proof_semantics_label"], FAST_REPLAY_PROOF_SEMANTICS_LABEL
        )
        assert_fast_replay_preview_mechanism_payloads(
            self, payload, row_payload, stress_payload
        )
        assert_fast_replay_preview_lineage_payloads(
            self, payload, row_payload, stress_payload, source_query_digest
        )
