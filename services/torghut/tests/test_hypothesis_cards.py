from __future__ import annotations

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.hypothesis_cards import (
    build_hypothesis_cards,
    hypothesis_card_from_payload,
)


class TestHypothesisCards(TestCase):
    def test_hypothesis_card_ids_are_deterministic_and_round_trip(self) -> None:
        claims = [
            {
                "claim_id": "claim-flow",
                "claim_type": "signal_mechanism",
                "claim_text": "Clustered order flow imbalance improves intraday LOB signals.",
                "asset_scope": "us_equities_intraday",
                "horizon_scope": "intraday",
                "expected_direction": "positive",
                "confidence": "0.82",
            }
        ]

        first = build_hypothesis_cards(source_run_id="paper-1", claims=claims)
        second = build_hypothesis_cards(source_run_id="paper-1", claims=claims)

        self.assertEqual(len(first), 1)
        self.assertEqual(first[0].hypothesis_id, second[0].hypothesis_id)
        self.assertIn("order_flow_imbalance", first[0].required_features)
        reloaded = hypothesis_card_from_payload(first[0].to_payload())
        self.assertEqual(reloaded.hypothesis_id, first[0].hypothesis_id)

    def test_invalid_and_low_confidence_payloads_do_not_execute(self) -> None:
        low_confidence = build_hypothesis_cards(
            source_run_id="paper-2",
            claims=[
                {
                    "claim_id": "weak",
                    "claim_text": "Weak trend effect.",
                    "confidence": "0.10",
                }
            ],
            min_confidence=Decimal("0.50"),
        )

        self.assertEqual(low_confidence, [])
        with self.assertRaisesRegex(ValueError, "hypothesis_card_schema_invalid"):
            hypothesis_card_from_payload({"schema_version": "invalid"})

    def test_validation_claim_data_requirements_do_not_become_signal_features(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-validation-contract",
            claims=[
                {
                    "claim_id": "flow-alpha",
                    "claim_type": "feature_recipe",
                    "claim_text": "Scale-invariant trade-flow features transfer across equities.",
                    "data_requirements": ["trade_flow", "relative_volume"],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "synthetic-stress",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Generated trade-flow rollouts are useful for stress testing "
                        "but cannot be promotion proof."
                    ),
                    "data_requirements": [
                        "historical_replay",
                        "live_paper_parity",
                        "market_impact_stress",
                    ],
                    "confidence": "0.72",
                },
            ],
        )

        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].required_features, ("trade_flow", "relative_volume"))
        self.assertEqual(
            cards[0].implementation_constraints["validation_requirements"][0][
                "claim_id"
            ],
            "synthetic-stress",
        )
        self.assertIn(
            "live_paper_parity",
            cards[0].implementation_constraints["validation_requirements"][0][
                "data_requirements"
            ],
        )
