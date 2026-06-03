from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.cluster_lob_features import (
    HPAIRS_CLUSTER_LOB_PRIMARY_SOURCES,
    build_cluster_lob_feature_schema_hash,
    cluster_lob_feature_contract,
    extract_cluster_lob_features,
    extract_hawkes_excitation_summary,
)
from app.trading.discovery.order_flow_features import (
    build_order_flow_feature_schema_hash,
    extract_order_flow_features,
)
from app.trading.models import SignalEnvelope


class TestClusterLOBFeatures(TestCase):
    def _row(
        self,
        *,
        offset: int,
        symbol: str = "AAA",
        ofi: str | None = None,
        volume: str = "100",
        event_type: str = "trade",
        side: str = "buy",
        bid_size: str = "700",
        ask_size: str = "300",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {
            "event_type": event_type,
            "side": side,
            "microbar_volume": Decimal(volume),
            "bid_size": Decimal(bid_size),
            "ask_size": Decimal(ask_size),
        }
        if ofi is not None:
            payload["ofi"] = Decimal(ofi)
        return SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol=symbol,
            timeframe="1Min",
            seq=offset,
            source="fixture",
            payload=payload,
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

    def test_order_flow_extraction_is_deterministic_for_replay_rows(self) -> None:
        rows = [
            self._row(offset=2, ofi="0.25", side="buy"),
            self._row(offset=1, ofi="-0.10", side="sell"),
            self._row(offset=3, ofi="0.50", side="buy"),
        ]

        first = extract_order_flow_features(rows).to_payload()
        second = extract_order_flow_features(tuple(reversed(rows))).to_payload()

        self.assertEqual(first, second)
        self.assertEqual(first["status"], "preview_only_research_ranking")
        self.assertFalse(first["promotion_allowed"])
        self.assertFalse(first["final_authority_ok"])
        self.assertGreater(float(first["directional_alignment_score"]), 0)

    def test_schema_hash_is_stable_and_invalidates_on_horizon_change(self) -> None:
        default_hash = build_order_flow_feature_schema_hash()
        same_hash = build_order_flow_feature_schema_hash(horizons=(36, 12, 3, 1))
        changed_hash = build_order_flow_feature_schema_hash(horizons=(1, 3, 12, 36, 72))
        cluster_hash = build_cluster_lob_feature_schema_hash()

        self.assertEqual(default_hash, same_hash)
        self.assertNotEqual(default_hash, changed_hash)
        self.assertEqual(cluster_hash, build_cluster_lob_feature_schema_hash())
        self.assertNotEqual(
            cluster_hash,
            build_cluster_lob_feature_schema_hash(horizons=(1, 3, 12, 36, 72)),
        )

    def test_horizon_buckets_and_decay_reflect_tail_order_flow(self) -> None:
        rows = [
            self._row(offset=1, ofi="-0.50"),
            self._row(offset=2, ofi="-0.50"),
            self._row(offset=3, ofi="0.80"),
            self._row(offset=4, ofi="0.80"),
        ]

        features = extract_order_flow_features(rows, horizons=(2, 4)).to_payload()
        summaries = {item["horizon"]: item for item in features["horizon_summaries"]}

        self.assertEqual(summaries[2]["bucket_count"], 2)
        self.assertLess(float(summaries[2]["mean_bucket_imbalance"]), 0.2)
        self.assertGreater(float(summaries[2]["tail_bucket_imbalance"]), 0.7)
        self.assertGreater(float(summaries[2]["decayed_imbalance"]), 0)
        self.assertGreater(
            float(features["ranking_features"]["directional_alignment_score"]), 0
        )

    def test_cluster_bin_assignment_is_stable_for_fixture_records(self) -> None:
        fixture_rows = [
            {
                "event_ts": "2026-02-23T14:30:01+00:00",
                "symbol": "AAA",
                "payload": {
                    "event_type": "trade",
                    "side": "buy",
                    "ofi": "0.4",
                    "microbar_volume": "100",
                },
            },
            {
                "event_ts": "2026-02-23T14:30:02+00:00",
                "symbol": "AAA",
                "payload": {
                    "event_type": "cancel",
                    "side": "sell",
                    "ofi": "-0.2",
                    "microbar_volume": "50",
                },
            },
            {
                "event_ts": "2026-02-23T14:30:03+00:00",
                "symbol": "AAA",
                "payload": {"cluster_lob_bucket": "Directional Buy"},
            },
        ]

        payload = extract_cluster_lob_features(fixture_rows).to_payload()

        self.assertEqual(payload["cluster_bins"]["aggressive_buy_trade"], 1)
        self.assertEqual(payload["cluster_bins"]["ask_liquidity_remove"], 1)
        self.assertEqual(payload["cluster_bins"]["directional_buy"], 1)
        self.assertGreater(float(payload["cluster_entropy"]), 0.9)
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertIn("hawkes_excitation", payload)
        self.assertIn("hawkes_excitation_stress_score", payload["ranking_features"])

    def test_hawkes_excitation_summary_records_primary_sources_and_stress(self) -> None:
        clustered_rows = [
            self._row(offset=offset, event_type="trade", side="buy", ofi="0.4")
            for offset in (1, 2, 3, 4, 5, 6)
        ]
        sparse_rows = [
            self._row(offset=offset, event_type="trade", side="buy", ofi="0.4")
            for offset in (1, 61, 121, 181, 241, 301)
        ]

        clustered = extract_hawkes_excitation_summary(clustered_rows).to_payload()
        sparse = extract_hawkes_excitation_summary(sparse_rows).to_payload()

        self.assertGreater(
            float(clustered["replay_stress_score"]),
            float(sparse["replay_stress_score"]),
        )
        self.assertGreater(float(clustered["hawkes_branching_proxy"]), 0)
        self.assertEqual(clustered["observed_event_time_count"], 6)
        self.assertTrue(
            {"arxiv-2510.08085", "arxiv-2604.23961"}.issubset(
                {item["source_id"] for item in clustered["source_papers"]}
            )
        )
        self.assertFalse(clustered["promotion_authority"])
        self.assertFalse(clustered["proof_authority"])

    def test_cluster_contract_exposes_hawkes_sources_without_promotion_authority(
        self,
    ) -> None:
        contract = cluster_lob_feature_contract()
        policy = contract["hawkes_excitation_policy"]

        self.assertEqual(
            [item["source_id"] for item in policy["source_papers"]],
            [item["source_id"] for item in HPAIRS_CLUSTER_LOB_PRIMARY_SOURCES],
        )
        self.assertEqual(policy["output_scope"], "preview_replay_stress_ranking_only")
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])

    def test_missing_partial_data_is_marked_without_authority(self) -> None:
        payload = extract_cluster_lob_features(
            [
                {
                    "event_ts": "2026-02-23T14:30:01+00:00",
                    "symbol": "AAA",
                    "payload": {"price": "100"},
                }
            ]
        ).to_payload()

        self.assertIn("missing_order_flow_inputs", payload["warnings"])
        self.assertIn("missing_cluster_lob_inputs", payload["warnings"])
        self.assertEqual(payload["dominant_cluster_bin"], "unknown_event_cluster")
        self.assertTrue(payload["prefilter_only"])
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["proof_authority"])
