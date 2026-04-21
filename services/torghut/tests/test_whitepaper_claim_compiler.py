from __future__ import annotations

from unittest import TestCase

from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    WhitepaperResearchSource,
    claim_subgraph_blockers,
    compile_sources_to_hypothesis_cards,
    source_from_payload,
)


class TestWhitepaperClaimCompiler(TestCase):
    def test_recent_seed_sources_compile_to_hypothesis_cards(self) -> None:
        cards = compile_sources_to_hypothesis_cards(RECENT_WHITEPAPER_SEEDS)

        self.assertEqual(len(cards), 4)
        self.assertTrue(
            all(card.source_run_id.startswith("seed-arxiv-") for card in cards)
        )
        self.assertTrue(all(card.required_features for card in cards))
        self.assertTrue(all(card.risk_controls for card in cards))

    def test_incomplete_risk_only_source_is_blocked(self) -> None:
        source = WhitepaperResearchSource(
            run_id="risk-only-paper",
            title="Risk Only",
            source_url="https://example.test/risk",
            published_at="2026-01-01",
            claims=(
                {
                    "claim_id": "risk-1",
                    "claim_type": "risk_constraint",
                    "claim_text": "Sizing should account for spread expansion.",
                    "confidence": "0.80",
                },
            ),
        )

        self.assertEqual(
            claim_subgraph_blockers(source),
            ("mechanism_missing", "feature_recipe_or_blocker_missing"),
        )
        self.assertEqual(compile_sources_to_hypothesis_cards((source,)), [])

    def test_empty_source_reports_all_required_blockers(self) -> None:
        source = WhitepaperResearchSource(
            run_id="",
            title="Empty",
            source_url="https://example.test/empty",
            published_at="2026-01-01",
            claims=(),
        )

        self.assertEqual(
            claim_subgraph_blockers(source),
            (
                "source_run_id_missing",
                "claims_missing",
                "mechanism_missing",
                "feature_recipe_or_blocker_missing",
                "risk_or_validation_constraint_missing",
            ),
        )
        self.assertEqual(compile_sources_to_hypothesis_cards((source,)), [])

    def test_metadata_feature_recipe_can_complete_subgraph(self) -> None:
        source = WhitepaperResearchSource(
            run_id="metadata-feature-paper",
            title="Metadata Feature",
            source_url="https://example.test/metadata-feature",
            published_at="2026-01-01",
            claims=(
                {
                    "claim_id": "mechanism-1",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Matched order-flow state can identify short-horizon continuation.",
                    "metadata": {"required_features": ("order_flow_imbalance",)},
                    "confidence": "0.79",
                },
                {
                    "claim_id": "validation-1",
                    "claim_type": "execution_assumption",
                    "claim_text": "Execution must stay inside spread and quote-quality limits.",
                    "required_features": "spread_bps",
                    "confidence": "0.72",
                },
            ),
        )

        self.assertEqual(claim_subgraph_blockers(source), ())
        self.assertEqual(len(compile_sources_to_hypothesis_cards((source,))), 1)

    def test_requires_feature_relation_satisfies_feature_blocker(self) -> None:
        source = WhitepaperResearchSource(
            run_id="blocked-feature-paper",
            title="Feature Blocker",
            source_url="https://example.test/feature",
            published_at="2026-01-01",
            claims=(
                {
                    "claim_id": "mechanism-1",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow bursts can predict short-horizon continuation.",
                    "confidence": "0.80",
                },
                {
                    "claim_id": "validation-1",
                    "claim_type": "validation_requirement",
                    "claim_text": "The signal must pass held-out liquidity shock windows.",
                    "confidence": "0.74",
                },
            ),
            claim_relations=(
                {
                    "relation_id": "requires-missing-feature",
                    "relation_type": "requires_feature",
                    "source_claim_id": "mechanism-1",
                    "target_feature": "clustered_order_events",
                },
            ),
        )

        self.assertEqual(claim_subgraph_blockers(source), ())
        self.assertEqual(len(compile_sources_to_hypothesis_cards((source,))), 1)

    def test_claim_compilation_is_deterministic(self) -> None:
        first = compile_sources_to_hypothesis_cards(RECENT_WHITEPAPER_SEEDS)
        second = compile_sources_to_hypothesis_cards(RECENT_WHITEPAPER_SEEDS)

        self.assertEqual(
            [card.hypothesis_id for card in first],
            [card.hypothesis_id for card in second],
        )

    def test_source_payload_round_trip_filters_invalid_rows(self) -> None:
        source = source_from_payload(
            {
                "run_id": "paper-1",
                "title": "Paper",
                "source_url": "https://example.test/paper.pdf",
                "published_at": "2026-01-01",
                "claims": [
                    {"claim_id": "claim-1", "claim_text": "valid"},
                    "invalid",
                ],
                "claim_relations": [
                    {"relation_id": "rel-1"},
                    None,
                ],
            }
        )

        self.assertEqual(source.run_id, "paper-1")
        self.assertEqual(len(source.claims), 1)
        self.assertEqual(len(source.claim_relations), 1)
