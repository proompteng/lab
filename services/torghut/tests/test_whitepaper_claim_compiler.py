from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    WhitepaperResearchSource,
    claim_subgraph_blockers,
    compile_sources_to_hypothesis_cards,
    source_from_payload,
    sources_from_jsonl,
)


class TestWhitepaperClaimCompiler(TestCase):
    def test_recent_seed_sources_compile_to_hypothesis_cards(self) -> None:
        cards = compile_sources_to_hypothesis_cards(RECENT_WHITEPAPER_SEEDS)

        self.assertEqual(len(cards), len(RECENT_WHITEPAPER_SEEDS))
        self.assertGreaterEqual(len(cards), 10)
        self.assertTrue(
            {
                "seed-arxiv-2602-00776",
                "seed-arxiv-2601-23172",
                "seed-arxiv-2601-17247",
                "seed-arxiv-2507-06345",
                "seed-springer-lobdif-2026",
                "seed-arxiv-2502-17417",
                "seed-ssrn-6440898",
                "seed-ssrn-6754305",
                "seed-ssrn-6703098",
                "seed-ssrn-6700018",
                "seed-ssrn-6687441",
                "seed-ssrn-6658364",
                "seed-arxiv-2605-15746",
                "seed-arxiv-2605-12151",
                "seed-arxiv-2605-11640",
                "seed-arxiv-2605-11423",
                "seed-arxiv-2605-11180",
                "seed-arxiv-2605-04004",
                "seed-arxiv-2605-05580",
                "seed-arxiv-2604-26747",
                "seed-arxiv-2604-20949",
                "seed-arxiv-2604-10402",
                "seed-arxiv-2604-09060",
                "seed-arxiv-2603-29086",
                "seed-arxiv-2510-02986",
                "seed-arxiv-2603-16365",
                "seed-arxiv-2602-07085",
                "seed-arxiv-2505-17388",
                "seed-arxiv-2508-06788",
                "seed-arxiv-2507-22712",
                "seed-arxiv-2512-15720",
                "seed-arxiv-2510-11616",
            }.issubset({source.run_id for source in RECENT_WHITEPAPER_SEEDS})
        )
        self.assertTrue(all(card.source_run_id.startswith("seed-") for card in cards))
        self.assertTrue(all(card.required_features for card in cards))
        self.assertTrue(all(card.risk_controls for card in cards))

    def test_attention_factor_stat_arb_seed_compiles_runtime_gated_card(self) -> None:
        cards = compile_sources_to_hypothesis_cards(RECENT_WHITEPAPER_SEEDS)
        card_by_source = {card.source_run_id: card for card in cards}

        card = card_by_source["seed-arxiv-2510-11616"]

        self.assertIn("firm_characteristic_embeddings", card.required_features)
        self.assertIn("residual_portfolio_returns", card.required_features)
        self.assertEqual(card.asset_scope, "us_equities_cross_section")
        self.assertEqual(card.horizon_scope, "statistical_arbitrage")
        validation = card.implementation_constraints["validation_requirements"][0]
        self.assertEqual(
            validation["claim_id"],
            "attention-factor-post-cost-validation",
        )
        self.assertIn("transaction_cost_stress", validation["data_requirements"])
        self.assertIn("runtime_ledger_profit_proof", validation["data_requirements"])

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

    def test_sources_from_jsonl_reads_normalized_source_payloads(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sources.jsonl"
            path.write_text(
                "\n"
                + json.dumps(
                    {
                        "run_id": "paper-jsonl",
                        "title": "Fresh paper",
                        "source_url": "https://example.test/fresh.pdf",
                        "published_at": "2026-04-01",
                        "claims": [
                            {
                                "claim_id": "claim-signal",
                                "claim_type": "signal_mechanism",
                                "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                                "data_requirements": ["order_flow_imbalance"],
                            },
                            {
                                "claim_id": "claim-validation",
                                "claim_type": "validation_requirement",
                                "claim_text": "Validate against held-out liquidity stress windows.",
                                "data_requirements": ["spread_bps"],
                            },
                        ],
                        "claim_relations": [
                            {
                                "relation_id": "rel-support",
                                "relation_type": "supports",
                                "source_claim_id": "claim-validation",
                                "target_claim_id": "claim-signal",
                            }
                        ],
                    },
                    sort_keys=True,
                )
                + "\n\n",
                encoding="utf-8",
            )

            sources = sources_from_jsonl(path)

        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0].run_id, "paper-jsonl")
        self.assertEqual(len(compile_sources_to_hypothesis_cards(sources)), 1)

    def test_checked_in_300_daily_profit_sources_compile_to_hypotheses(self) -> None:
        path = Path("config/trading/research-sources/300-daily-profit-2025-2026.jsonl")

        sources = sources_from_jsonl(path)
        cards = compile_sources_to_hypothesis_cards(sources)

        self.assertGreaterEqual(len(sources), 36)
        self.assertTrue(
            all(source.published_at.startswith(("2025", "2026")) for source in sources)
        )
        self.assertGreaterEqual(len(cards), len(sources))
        self.assertTrue(all(card.required_features for card in cards))
        self.assertTrue(all(card.risk_controls for card in cards))
        source_by_id = {source.run_id: source for source in sources}
        self.assertEqual(
            source_by_id["paper-ssrn-6440898"].published_at,
            "2026-05-15",
        )
        self.assertEqual(
            source_by_id["paper-ssrn-5170318"].published_at,
            "2026-05-12",
        )
        self.assertEqual(
            source_by_id["paper-arxiv-2503.04662"].title,
            "Risk-aware Trading Portfolio Optimization",
        )
        self.assertEqual(
            source_by_id["paper-arxiv-2605.05580"].title,
            "AlphaCrafter: A Full-Stack Multi-Agent Framework for Cross-Sectional Quantitative Trading",
        )
        self.assertTrue(
            any(
                claim.get("claim_type") == "portfolio_construction"
                for claim in source_by_id["paper-arxiv-2503.04662"].claims
            )
        )
        self.assertTrue(
            any(
                claim.get("claim_id") == "adaptive-factor-to-execution-loop"
                for claim in source_by_id["paper-arxiv-2605.05580"].claims
            )
        )

    def test_sources_from_jsonl_rejects_invalid_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            invalid_json_path = Path(tmpdir) / "invalid-json.jsonl"
            invalid_json_path.write_text("{invalid-json\n", encoding="utf-8")
            non_mapping_path = Path(tmpdir) / "non-mapping.jsonl"
            non_mapping_path.write_text("[]\n", encoding="utf-8")

            with self.assertRaisesRegex(
                ValueError,
                "whitepaper_source_jsonl_invalid_json",
            ):
                sources_from_jsonl(invalid_json_path)

            with self.assertRaisesRegex(
                ValueError,
                "whitepaper_source_jsonl_row_not_mapping",
            ):
                sources_from_jsonl(non_mapping_path)
