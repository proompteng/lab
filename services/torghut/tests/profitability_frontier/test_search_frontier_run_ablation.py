from __future__ import annotations

from tests.profitability_frontier.search_frontier_base import (
    Decimal,
    Path,
    SearchConsistentProfitabilityFrontierTestCaseBase,
    SimpleNamespace,
    TemporaryDirectory,
    date,
    frontier,
    json,
    patch,
    timedelta,
    yaml,
)


class TestSearchFrontierRunAblation(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_run_frontier_writes_paired_order_type_ablation_artifact(self) -> None:
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
                            "holdout_target_net_per_day": "100",
                            "min_active_holdout_days": 2,
                            "max_worst_holdout_day_loss": "200",
                            "min_profit_factor": "1.0",
                        },
                        "consistency_constraints": {
                            "target_net_per_day": "100",
                            "min_active_days": 2,
                            "max_worst_day_loss": "300",
                            "max_negative_days": 1,
                            "max_drawdown": "400",
                            "require_every_day_active": False,
                        },
                        "order_type_ablation": {
                            "enabled": True,
                            "max_candidates": 1,
                            "min_sample_count": 4,
                            "max_opportunity_cost_bps": "8",
                        },
                        "strategy_overrides": {
                            "universe_symbols": [["NVDA"]],
                        },
                        "parameters": {
                            "long_stop_loss_bps": ["18"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            args.min_train_screen_net_per_day = "1"
            recent_days = tuple(
                date(2026, 3, 18) + timedelta(days=index) for index in range(6)
            )
            snapshot_receipt = SimpleNamespace(
                snapshot_id="snap-ablation",
                is_fresh=True,
                stale_override_used=False,
                to_payload=lambda: {
                    "snapshot_id": "snap-ablation",
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
            forced_order_types: list[str] = []

            def fake_run_replay(config: object) -> dict[str, object]:
                configmap_path = Path(getattr(config, "strategy_configmap_path"))
                payload = yaml.safe_load(configmap_path.read_text(encoding="utf-8"))
                strategy = next(
                    item
                    for item in yaml.safe_load(payload["data"]["strategies.yaml"])[
                        "strategies"
                    ]
                    if item["name"] == "intraday-tsmom-profit-v3"
                )
                entry_order_type = str(
                    strategy.get("params", {}).get("entry_order_type") or "default"
                )
                start_date = str(getattr(config, "start_date"))
                end_date = str(getattr(config, "end_date"))
                full_window = start_date == "2026-03-18" and end_date == "2026-03-23"
                if full_window and entry_order_type in {"market", "limit"}:
                    forced_order_types.append(entry_order_type)
                    daily_net = (
                        {
                            "2026-03-18": "120",
                            "2026-03-19": "120",
                            "2026-03-20": "120",
                            "2026-03-21": "120",
                            "2026-03-22": "120",
                            "2026-03-23": "120",
                        }
                        if entry_order_type == "market"
                        else {
                            "2026-03-18": "110",
                            "2026-03-19": "110",
                            "2026-03-20": "110",
                            "2026-03-21": "110",
                            "2026-03-22": "110",
                            "2026-03-23": "110",
                        }
                    )
                    replay_payload = self._payload(
                        start_date=start_date,
                        end_date=end_date,
                        daily_net=daily_net,
                        daily_filled_notional={day: "20000" for day in daily_net},
                        decision_count=6,
                        filled_count=6 if entry_order_type == "market" else 5,
                        wins=6,
                        losses=0,
                    )
                    replay_payload["decision_count_by_order_type"] = {
                        entry_order_type: 6
                    }
                    replay_payload["filled_count_by_order_type"] = {
                        entry_order_type: 6 if entry_order_type == "market" else 5
                    }
                    if entry_order_type == "limit":
                        replay_payload["limit_fill_rate"] = "0.83"
                    return replay_payload

                if start_date == "2026-03-18" and end_date == "2026-03-20":
                    daily_net = {
                        "2026-03-18": "105",
                        "2026-03-19": "110",
                        "2026-03-20": "115",
                    }
                elif start_date == "2026-03-21" and end_date == "2026-03-23":
                    daily_net = {
                        "2026-03-21": "125",
                        "2026-03-22": "130",
                        "2026-03-23": "135",
                    }
                else:
                    daily_net = {
                        "2026-03-18": "105",
                        "2026-03-19": "110",
                        "2026-03-20": "115",
                        "2026-03-21": "125",
                        "2026-03-22": "130",
                        "2026-03-23": "135",
                    }
                replay_payload = self._payload(
                    start_date=start_date,
                    end_date=end_date,
                    daily_net=daily_net,
                    decision_count=6,
                    filled_count=6,
                    wins=6,
                    losses=0,
                )
                if full_window and bool(
                    getattr(config, "capture_exact_replay_ledger", False)
                ):
                    replay_payload["exact_replay_ledger"] = {
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "account_label": "TORGHUT_REPLAY",
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": [
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-18T14:35:00+00:00",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-18T14:35:01+00:00",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-18T14:35:02+00:00",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                                "symbol": "NVDA",
                                "side": "buy",
                                "filled_qty": "1",
                                "avg_fill_price": "100",
                                "cost_amount": "0.10",
                                "cost_basis": "local_replay_transaction_cost_model",
                            },
                            {
                                "event_type": "decision",
                                "executed_at": "2026-03-18T14:40:00+00:00",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "order_submitted",
                                "executed_at": "2026-03-18T14:40:01+00:00",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                            },
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-18T14:40:02+00:00",
                                "decision_id": "decision-sell",
                                "order_id": "order-sell",
                                "symbol": "NVDA",
                                "side": "sell",
                                "filled_qty": "1",
                                "avg_fill_price": "101",
                                "cost_amount": "0.10",
                                "cost_basis": "local_replay_transaction_cost_model",
                            },
                        ],
                    }
                return replay_payload

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

            self.assertEqual(forced_order_types, ["market", "limit"])
            scorecard = payload["top"][0]["objective_scorecard"]
            artifact_ref = Path(scorecard["order_type_ablation_artifact_ref"])
            self.assertTrue(artifact_ref.exists())
            self.assertEqual(scorecard["order_type_ablation_sample_count"], 12)
            self.assertTrue(scorecard["order_type_ablation_passed"])
            self.assertEqual(
                scorecard["order_type_ablation_selected_order_type"], "market"
            )
            self.assertNotIn("route_tca_artifact_ref", scorecard)
            self.assertNotIn("price_improvement_evidence_present", scorecard)
            self.assertNotIn("execution_shortfall_evidence_present", scorecard)
            exact_ledger_ref = Path(scorecard["exact_replay_ledger_artifact_ref"])
            self.assertTrue(exact_ledger_ref.exists())
            self.assertEqual(
                exact_ledger_ref.parent, root / "frontier-artifacts" / "frontier"
            )
            self.assertEqual(artifact_ref.parent, exact_ledger_ref.parent)
            self.assertNotIn("runtime_ledger_artifact_ref", payload["top"][0])
            self.assertIn(
                str(exact_ledger_ref), payload["top"][0]["replay_artifact_refs"]
            )
            exact_ledger_artifact = json.loads(
                exact_ledger_ref.read_text(encoding="utf-8")
            )
            self.assertEqual(
                exact_ledger_artifact["schema_version"],
                "torghut.exact_replay_ledger.rows.v1",
            )
            self.assertEqual(
                exact_ledger_artifact["candidate_id"], payload["top"][0]["candidate_id"]
            )
            self.assertEqual(
                exact_ledger_artifact["artifact_kind"], "exact_replay_ledger"
            )
            self.assertFalse(exact_ledger_artifact["proof_authority"])
            self.assertEqual(
                exact_ledger_artifact["authority"],
                "exact_replay_probation_only",
            )
            self.assertIn(
                "source_backed_runtime_ledger_required",
                exact_ledger_artifact["authority_blockers"],
            )
            self.assertFalse(scorecard["exact_replay_ledger_artifact_proof_authority"])
            self.assertNotIn("runtime_ledger_artifact_proof_authority", scorecard)
            self.assertFalse(scorecard["final_promotion_authority"])
            self.assertNotIn("runtime_ledger_artifact_row_count", scorecard)
            self.assertNotIn("runtime_ledger_artifact_fill_count", scorecard)
            self.assertEqual(scorecard["runtime_ledger_closed_trade_count"], 1)
            self.assertEqual(scorecard["runtime_ledger_open_position_count"], 0)
            self.assertEqual(scorecard["runtime_ledger_filled_notional"], "201")
            self.assertEqual(
                scorecard["runtime_ledger_net_strategy_pnl_after_costs"], "0.80"
            )
            self.assertEqual(
                scorecard["runtime_ledger_pnl_basis"],
                "realized_strategy_pnl_after_explicit_costs",
            )
            self.assertEqual(
                scorecard["runtime_ledger_pnl_source"],
                "exact_replay_runtime_ledger",
            )
            artifact = json.loads(artifact_ref.read_text(encoding="utf-8"))
            self.assertEqual(
                artifact["schema_version"], "torghut.order-type-ablation.v1"
            )
            self.assertEqual(artifact["selected_order_type"], "market")
            self.assertEqual(artifact["alternative_order_type"], "limit")
            self.assertEqual(artifact["market"]["sample_count"], 6)
            self.assertEqual(artifact["limit"]["sample_count"], 6)
            self.assertEqual(len(artifact["market"]["payload_sha256"]), 64)
            self.assertEqual(len(artifact["limit"]["payload_sha256"]), 64)
            self.assertEqual(
                payload["top"][0]["order_type_ablation"]["artifact_ref"],
                str(artifact_ref),
            )

    def test_train_screen_failures_reports_worst_day_loss(self) -> None:
        failures = frontier._train_screen_failures(
            train_payload=self._payload(
                start_date="2026-04-01",
                end_date="2026-04-02",
                daily_net={"2026-04-01": "-125", "2026-04-02": "200"},
                decision_count=2,
                filled_count=2,
                wins=1,
                losses=1,
            ),
            holdout_policy=frontier.ProfitabilityConstraintPolicy(
                holdout_target_net_per_day=Decimal("0"),
                min_active_holdout_days=0,
                max_worst_holdout_day_loss=Decimal("1000"),
                min_profit_factor=Decimal("0"),
                require_training_decisions=True,
                require_holdout_decisions=False,
            ),
            consistency_policy=frontier.FullWindowConsistencyPolicy(
                target_net_per_day=Decimal("0"),
                min_daily_net_pnl=Decimal("-1000"),
                min_active_days=1,
                min_active_ratio=Decimal("0"),
                min_positive_days=1,
                max_worst_day_loss=Decimal("1000"),
                max_negative_days=1,
                max_drawdown=Decimal("1000"),
                max_best_day_share_of_total_pnl=Decimal("1"),
                min_avg_filled_notional_per_day=Decimal("0"),
                min_avg_filled_notional_per_active_day=Decimal("0"),
                require_every_day_active=False,
            ),
            min_train_net_per_day=Decimal("-1000"),
            min_train_active_ratio=Decimal("0"),
            max_train_worst_day_loss=Decimal("100"),
        )

        self.assertIn("train_worst_day_loss_above_screen", failures)
