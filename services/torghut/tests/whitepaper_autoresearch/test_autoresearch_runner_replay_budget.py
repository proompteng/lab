from __future__ import annotations

import scripts.whitepaper_autoresearch_runner.replay_shards as replay_shards

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Path,
    WhitepaperAutoresearchRunnerTestCaseBase,
)


class TestAutoresearchRunnerReplayBudget(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_program_replay_budget_supplies_staged_train_screen_multiplier(
        self,
    ) -> None:
        args = self._args(Path("/tmp/epoch"))
        program = replay_shards._load_epoch_program(args)
        controls = replay_shards._resolved_real_replay_frontier_controls(args, program)

        self.assertEqual(
            replay_shards._resolved_staged_train_screen_multiplier(args, program),
            3,
        )
        self.assertEqual(controls["symbol_prune_iterations"], 1)
        self.assertEqual(controls["symbol_prune_candidates"], 2)
        self.assertEqual(controls["symbol_prune_min_universe_size"], 5)
        self.assertEqual(controls["loss_repair_iterations"], 1)
        self.assertEqual(controls["loss_repair_candidates"], 1)
        self.assertEqual(controls["consistency_repair_iterations"], 1)
        self.assertEqual(controls["consistency_repair_candidates"], 2)
        self.assertFalse(controls["capture_rejected_seed_full_window_ledger"])
        self.assertEqual(controls["capture_positive_rejected_full_window_ledgers"], 0)
        args.staged_train_screen_multiplier = 4
        args.symbol_prune_candidates = 5
        args.capture_positive_rejected_full_window_ledgers = 6
        override_controls = replay_shards._resolved_real_replay_frontier_controls(
            args, program
        )
        self.assertEqual(
            replay_shards._resolved_staged_train_screen_multiplier(args, program),
            4,
        )
        self.assertEqual(override_controls["symbol_prune_candidates"], 5)
        positive_ledger_key = "capture_positive_rejected_full_window_ledgers"
        self.assertEqual(override_controls[positive_ledger_key], 6)
