from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_claim_payloads_to_whitepaper_experiments,
    compile_whitepaper_candidate_specs,
)
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards


class TestWhitepaperCandidateCompiler(TestCase):
    def test_claim_payloads_compile_to_whitepaper_and_vnext_specs(self) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-1",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertEqual(len(compilation.candidate_specs), 3)
        self.assertEqual(len(compilation.executable_specs), 3)
        self.assertEqual(len(compilation.whitepaper_experiment_payloads), 3)
        self.assertEqual(len(compilation.vnext_experiment_payloads), 3)
        family_ids = {spec.family_template_id for spec in compilation.executable_specs}
        self.assertEqual(
            family_ids,
            {
                "intraday_tsmom_v2",
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            },
        )
        self.assertTrue(
            all(
                "family_selection" in spec.feature_contract
                for spec in compilation.executable_specs
            )
        )
        self.assertEqual(
            compilation.whitepaper_experiment_payloads[0]["selection_objectives"][
                "target_net_pnl_per_day"
            ],
            "500",
        )
        self.assertEqual(
            compilation.vnext_experiment_payloads[0]["family_template_id"],
            "microstructure_continuation_matched_filter_v1",
        )

    def test_missing_family_template_blocks_execution(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-run-2",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("/tmp/does-not-exist-torghut-families"),
        )

        self.assertEqual(len(compilation.executable_specs), 0)
        self.assertEqual(len(compilation.blocked_specs), 3)
        self.assertEqual(compilation.blockers[0].reason, "family_template_missing")

    def test_missing_seed_sweep_blocks_execution(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-run-3",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        with TemporaryDirectory() as tmpdir:
            compilation = compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                target_net_pnl_per_day=Decimal("500"),
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path(tmpdir),
            )

        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(len(compilation.blocked_specs), 3)
        self.assertEqual(compilation.blockers[0].reason, "seed_sweep_missing")
