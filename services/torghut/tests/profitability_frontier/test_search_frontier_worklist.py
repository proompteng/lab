from __future__ import annotations

from tests.profitability_frontier.search_frontier_base import (
    SearchConsistentProfitabilityFrontierTestCaseBase,
    frontier,
)


class TestSearchFrontierWorklist(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_initial_worklist_yields_candidate_record_seeds_before_grid(self) -> None:
        candidates = frontier._iter_initial_worklist_candidates(
            parameter_grid={"long_stop_loss_bps": ["10"]},
            override_candidates=[{"max_notional_per_trade": "63180"}],
            seed_candidates=[
                (
                    {"entry_start_minute_utc": "810"},
                    {"max_notional_per_trade": "50000"},
                )
            ],
        )

        first = next(candidates)
        second = next(candidates)

        self.assertEqual(first.params_candidate, {"entry_start_minute_utc": "810"})
        self.assertEqual(first.strategy_overrides, {"max_notional_per_trade": "50000"})
        self.assertTrue(first.candidate_record_seed)
        self.assertEqual(second.params_candidate, {"long_stop_loss_bps": "10"})
        self.assertEqual(second.strategy_overrides, {"max_notional_per_trade": "63180"})
        self.assertFalse(second.candidate_record_seed)

    def test_candidate_symbols_prefers_cli_filter_then_universe_override(self) -> None:
        self.assertEqual(
            frontier._candidate_symbols(
                cli_symbols=("META",),
                strategy_overrides={"universe_symbols": ["NVDA", "AMAT"]},
            ),
            ("META",),
        )
        self.assertEqual(
            frontier._candidate_symbols(
                cli_symbols=(),
                strategy_overrides={"universe_symbols": ["nvda", " amat "]},
            ),
            ("NVDA", "AMAT"),
        )
