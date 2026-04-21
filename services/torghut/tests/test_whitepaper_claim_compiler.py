from __future__ import annotations

from unittest import TestCase

from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    compile_sources_to_hypothesis_cards,
    source_from_payload,
)


class TestWhitepaperClaimCompiler(TestCase):
    def test_recent_seed_sources_compile_to_hypothesis_cards(self) -> None:
        cards = compile_sources_to_hypothesis_cards(RECENT_WHITEPAPER_SEEDS)

        self.assertGreaterEqual(len(cards), 4)
        self.assertTrue(
            all(card.source_run_id.startswith("seed-arxiv-") for card in cards)
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
