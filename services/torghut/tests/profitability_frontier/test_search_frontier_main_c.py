from __future__ import annotations

# ruff: noqa: F403,F405
from tests.profitability_frontier.search_frontier_base import *


class TestSearchFrontierMainC(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_rejected_candidate_record_can_capture_full_window_exact_ledger(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root)
            candidate_record = root / "candidate.json"
            candidate_record.write_text(
                json.dumps(
                    {
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "candidate_strategy": {
                            "strategy_name": "intraday-tsmom-profit-v3",
                            "universe_symbols": ["NVDA"],
                            "max_notional_per_trade": "50000",
                            "params": {"long_stop_loss_bps": "12"},
                        },
                    }
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.candidate_record = [candidate_record]
            args.capture_rejected_seed_full_window_ledger = True
            args.max_candidates_to_evaluate = 1
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-rejected-seed-proof",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-rejected-seed-proof",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            replay_calls: list[tuple[str, str, bool]] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                capture_ledger = bool(
                    getattr(config, "capture_exact_replay_ledger", False)
                )
                replay_calls.append((start_date, end_date, capture_ledger))
                if capture_ledger:
                    payload = self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net={
                            "2026-03-18": "25",
                            "2026-03-19": "25",
                            "2026-03-20": "25",
                            "2026-03-21": "25",
                            "2026-03-22": "25",
                            "2026-03-23": "25",
                        },
                        decision_count=2,
                        filled_count=2,
                        wins=2,
                        losses=0,
                    )
                    payload["exact_replay_ledger"] = {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "account_label": "TORGHUT_REPLAY",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "ledger-lineage-sha",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": _authoritative_exact_replay_rows(),
                    }
                    return payload
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net={
                        "2026-03-18": "0",
                        "2026-03-19": "0",
                        "2026-03-20": "0",
                    },
                    decision_count=0,
                    filled_count=0,
                    wins=0,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(
                replay_calls,
                [
                    ("2026-03-18", "2026-03-20", False),
                    ("2026-03-18", "2026-03-23", True),
                ],
            )
            top = payload["top"][0]
            self.assertEqual(top["screening"]["status"], "rejected")
            self.assertTrue(top["screening"]["holdout_replay_skipped"])
            self.assertFalse(top["screening"]["full_window_replay_skipped"])
            self.assertTrue(top["screening"]["proof_only_full_window_replay_captured"])
            self.assertEqual(
                top["staged_search"]["stage"],
                "train_screen_rejected_full_window_proof",
            )
            self.assertTrue(top["staged_search"]["candidate_record_seed"])
            self.assertIn("train_no_decisions", top["hard_vetoes"])
            exact_ledger_ref = Path(
                top["objective_scorecard"]["exact_replay_ledger_artifact_ref"]
            )
            self.assertTrue(exact_ledger_ref.exists())
            artifact = json.loads(exact_ledger_ref.read_text(encoding="utf-8"))
            self.assertTrue(artifact["proof_only"])
            self.assertEqual(
                artifact["proof_only_reason"],
                "train_screen_rejected_candidate_record_seed",
            )
            self.assertEqual(
                artifact["dataset_snapshot_id"], "snap-rejected-seed-proof"
            )
            self.assertEqual(
                artifact["candidate_evaluation_key"], top["candidate_evaluation_key"]
            )
            self.assertEqual(
                artifact["replay_lineage_hash"],
                top["replay_lineage"]["lineage_hash"],
            )
            self.assertEqual(
                artifact["full_window"],
                {"start_date": "2026-03-18", "end_date": "2026-03-23"},
            )
            self.assertEqual(artifact["candidate_symbols"], ["NVDA"])

    def test_positive_rejected_candidates_can_capture_capped_full_window_ledgers(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "disable_other_strategies": True,
                        "constraints": {
                            "holdout_target_net_per_day": "200",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "200",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": True,
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["12", "14"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            args.max_candidates_to_evaluate = 2
            args.min_train_screen_net_per_day = "50"
            args.capture_positive_rejected_full_window_ledgers = 1
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-positive-reject-proof",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-positive-reject-proof",
                    "source": "ta",
                    "window_size": "PT1S",
                    "start_day": "2026-03-18",
                    "end_day": "2026-03-23",
                    "expected_last_trading_day": "2026-03-23",
                    "is_fresh": True,
                    "missing_days": [],
                    "row_count": 123,
                    "stale_override_used": False,
                    "witnesses": [],
                },
            )
            replay_calls: list[tuple[str, str, bool]] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                capture_ledger = bool(
                    getattr(config, "capture_exact_replay_ledger", False)
                )
                replay_calls.append((start_date, end_date, capture_ledger))
                if capture_ledger:
                    payload = self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net={
                            "2026-03-18": "30",
                            "2026-03-19": "30",
                            "2026-03-20": "30",
                            "2026-03-21": "30",
                            "2026-03-22": "30",
                            "2026-03-23": "30",
                        },
                        decision_count=2,
                        filled_count=2,
                        wins=2,
                        losses=0,
                    )
                    payload["exact_replay_ledger"] = {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "account_label": "TORGHUT_REPLAY",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "ledger-lineage-sha",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": _authoritative_exact_replay_rows(),
                    }
                    return payload
                return self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net={
                        "2026-03-18": "10",
                        "2026-03-19": "10",
                        "2026-03-20": "10",
                    },
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.build_dataset_snapshot_receipt",
                    return_value=snapshot_receipt,
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.ensure_fresh_snapshot"
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
            ):
                payload = frontier.run_consistent_profitability_frontier(args)

            self.assertEqual(
                replay_calls,
                [
                    ("2026-03-18", "2026-03-20", False),
                    ("2026-03-18", "2026-03-23", True),
                    ("2026-03-18", "2026-03-20", False),
                ],
            )
            staged = payload["progress"]["staged_search"]
            self.assertEqual(
                staged["positive_rejected_full_window_ledger_capture_budget"], 1
            )
            self.assertEqual(staged["proof_only_full_window_replay_captures"], 1)
            captured = [
                item
                for item in payload["top"]
                if item["screening"]["proof_only_full_window_replay_captured"]
            ]
            self.assertEqual(len(captured), 1)
            top = captured[0]
            self.assertEqual(
                top["staged_search"]["stage"],
                "train_screen_rejected_full_window_proof",
            )
            self.assertIn("train_net_per_day_below_screen", top["hard_vetoes"])
            exact_ledger_ref = Path(
                top["objective_scorecard"]["exact_replay_ledger_artifact_ref"]
            )
            artifact = json.loads(exact_ledger_ref.read_text(encoding="utf-8"))
            self.assertTrue(artifact["proof_only"])
            self.assertEqual(
                artifact["proof_only_reason"], "positive_train_screen_reject"
            )
