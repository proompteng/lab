from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import app.trading.discovery.mlx_training_data as mlx_training_data
import app.trading.discovery.profit_target_oracle as profit_target_oracle
import scripts.whitepaper_autoresearch_runner.candidate_prior_scoring as candidate_prior_scoring
import scripts.whitepaper_autoresearch_runner.feedback_bundle_builders as feedback_bundle_builders
import socket

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Any,
    Decimal,
    Namespace,
    Path,
    Sequence,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    _CHIP_UNIVERSE,
    evidence_bundle_blockers,
    patch,
    replace,
    runner,
    sys,
)
from scripts.whitepaper_autoresearch_runner import proposal_building
from scripts.whitepaper_autoresearch_runner import proposal_training


class TestAutoresearchRunnerParser(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_ranker_backend_preference_reaches_pre_and_post_replay_models(self) -> None:
        specs = [
            self._candidate_spec("spec-low"),
            self._candidate_spec("spec-high"),
        ]
        candidate_evidence_bundles = [
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=specs[0].candidate_spec_id,
                candidate={
                    "candidate_id": "candidate-low",
                    "objective_scorecard": {"net_pnl_per_day": "50"},
                },
                dataset_snapshot_id="snapshot",
                result_path="/tmp/low.json",
            ),
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=specs[1].candidate_spec_id,
                candidate={
                    "candidate_id": "candidate-high",
                    "objective_scorecard": {"net_pnl_per_day": "500"},
                },
                dataset_snapshot_id="snapshot",
                result_path="/tmp/high.json",
            ),
        ]
        captured_backend_preferences: list[str] = []
        real_train_mlx_ranker = mlx_training_data.train_mlx_ranker

        def capture_train_mlx_ranker(rows: Sequence[Any], **kwargs: Any) -> Any:
            captured_backend_preferences.append(str(kwargs.get("backend_preference")))
            return real_train_mlx_ranker(
                rows,
                backend_preference="numpy-fallback",
                steps=2,
            )

        with (
            patch.object(
                proposal_building,
                "train_mlx_ranker",
                side_effect=capture_train_mlx_ranker,
            ),
            patch.object(
                proposal_training,
                "train_mlx_ranker",
                side_effect=capture_train_mlx_ranker,
            ),
        ):
            proposal_building._pre_replay_proposal_model_and_rows(
                specs=specs,
                feedback_evidence_bundles=(),
                oracle_policy=profit_target_oracle.ProfitTargetOraclePolicy(),
                ranker_backend_preference="torch-cuda",
            )
            proposal_training._proposal_model_and_rows(
                specs=specs,
                evidence_bundles=candidate_evidence_bundles,
                replay_selection_by_spec=None,
                ranker_backend_preference="cuda",
            )

        self.assertEqual(captured_backend_preferences, ["torch-cuda", "cuda"])

    def test_ranker_backend_preference_falls_back_for_invalid_internal_value(
        self,
    ) -> None:
        args = self._args(Path("unused"))
        args.ranker_backend_preference = "not-a-backend"

        self.assertEqual(runner._ranker_backend_preference(args), "mlx")

    def test_candidate_board_adds_factor_acceptance_replay_metadata(self) -> None:
        spec = replace(
            self._candidate_spec("spec-factor-acceptance"),
            feature_contract={
                "mechanism": "rankic signal discovery",
                "required_features": ("cross_section_session_open_rank", "spread_bps"),
                "factor_acceptance_artifact": {
                    "status": "rejected",
                    "factor_expression": "cross_section_session_open_rank",
                    "source_idea": "static_rankic_compile_contract",
                    "allowed_feature_dependencies": [
                        "cross_section_session_open_rank",
                        "spread_bps",
                    ],
                    "rejection_reasons": ["rank_ic_below_floor"],
                    "lineage_hash": "static-factor-lineage",
                },
            },
            parameter_space={
                "mechanism_overlay_ids": ["rankic_factor_acceptance_harness"]
            },
        )
        evidence = evidence_bundles.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-factor-acceptance",
            candidate_id="candidate-factor-acceptance",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-factor-acceptance",
            feature_spec_hash="feature-hash",
            code_commit="commit-sha",
            replay_artifact_refs=("replay-factor.json",),
            objective_scorecard={
                "rank_ic": "0.061",
                "rank_ir": "0.71",
                "p_value": "0.006",
                "decision_count": 144,
                "net_pnl_per_day": "34",
                "avg_filled_notional_per_day": "100000",
                "market_impact_stress_cost_bps": "1.8",
                "train_window": {"start": "2026-01-02", "end": "2026-03-31"},
                "holdout_window": {"start": "2026-04-01", "end": "2026-04-30"},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-factor-acceptance",
            output_dir=Path("/tmp/torghut-factor-acceptance"),
            target=Decimal("500"),
            candidate_specs=[spec],
            candidate_selection={
                "budget": {"compiled_candidate_count": 4},
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "top_k",
                        "rank": 1,
                    }
                ],
            },
            pre_replay_proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "0.9",
                }
            ],
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "0.9",
                }
            ],
            evidence_bundles=[evidence],
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={"status": "blocked"},
        )

        row = board["rows"][0]
        metadata = row["factor_acceptance_replay_metadata"]
        artifact = metadata["replay_artifact"]

        self.assertEqual(board["factor_acceptance_summary"]["accepted_count"], 1)
        self.assertEqual(metadata["status"], "accepted")
        self.assertEqual(metadata["evidence_status"], "replayed")
        self.assertFalse(metadata["promotion_allowed"])
        self.assertFalse(metadata["final_promotion_authorized"])
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "1.60000")
        self.assertFalse(row["factor_acceptance_promotion_allowed"])
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")

    def test_candidate_feedback_metadata_preserves_runtime_params_for_closure(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-prevclose-runtime"),
            strategy_overrides={
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "entry_minute_after_open": "35",
                    "entry_window_minutes": "25",
                    "exit_minute_after_open": "180",
                    "signal_motif": "opening_window_prev_close_reversal",
                    "rank_feature": "cross_section_opening_window_return_from_prev_close_rank",
                    "selection_mode": "reversal",
                    "top_n": "2",
                    "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                    "gate_min": "0.20",
                    "gate_max": "0.85",
                    "long_stop_loss_bps": "5",
                    "long_trailing_stop_activation_profit_bps": "5",
                    "long_trailing_stop_drawdown_bps": "2",
                },
                "universe_symbols": ["NVDA", "AVGO", "AMD"],
            },
        )

        candidate = candidate_prior_scoring._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-prevclose",
                "objective_scorecard": {"net_pnl_per_day": "401.8"},
            },
        )

        scorecard = candidate["objective_scorecard"]
        self.assertEqual(
            scorecard["runtime_params"]["signal_motif"],
            "opening_window_prev_close_reversal",
        )
        self.assertEqual(
            scorecard["runtime_params"]["gate_feature"],
            "cross_section_positive_opening_window_return_from_prev_close_ratio",
        )
        self.assertEqual(scorecard["universe_symbols"], ["NVDA", "AVGO", "AMD"])

    def test_candidate_feedback_metadata_preserves_validation_contract(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-validation-contract"),
            feature_contract={
                "mechanism": "scale-invariant trade-flow stress contract",
                "required_features": ("trade_flow", "relative_volume"),
                "source_run_id": "paper-arxiv-2602-23784",
                "family_selection": {"rank": 1},
                "validation_requirements": [
                    {
                        "claim_id": "synthetic-rollout-stress",
                        "claim_type": "validation_requirement",
                        "claim_text": (
                            "Synthetic trade-flow rollouts are stress inputs, not "
                            "promotion proof."
                        ),
                        "data_requirements": [
                            "historical_replay",
                            "live_paper_parity",
                            "market_impact_stress",
                        ],
                    }
                ],
            },
            promotion_contract={
                "requires_historical_replay": True,
                "requires_live_paper_parity": True,
                "synthetic_evidence_policy": "validation_only_not_promotion_proof",
            },
        )

        candidate = candidate_prior_scoring._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-validation-contract",
                "objective_scorecard": {"net_pnl_per_day": "525"},
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "blocked_pending_runtime_parity",
                    "promotable": False,
                    "blockers": ["scheduler_v3_parity_missing"],
                },
            },
        )
        bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate=candidate,
            dataset_snapshot_id="historical-market-replay-2026-05-18",
            result_path="/tmp/historical-replay.json",
        )

        validation_contract = bundle.objective_scorecard["validation_contract"]
        self.assertEqual(
            validation_contract["validation_requirement_claim_ids"],
            ["synthetic-rollout-stress"],
        )
        self.assertEqual(
            bundle.promotion_readiness["validation_contract"],
            validation_contract,
        )
        self.assertIn(
            "validation_live_paper_parity_pending",
            bundle.promotion_readiness["blockers"],
        )
        self.assertNotIn(
            "synthetic_evidence_not_promotion_proof",
            evidence_bundle_blockers(bundle),
        )

    def test_validation_contract_rejects_synthetic_evidence_as_profit_proof(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-synthetic-contract"),
            feature_contract={
                **self._candidate_spec("spec-synthetic-contract").feature_contract,
                "validation_requirements": [
                    {
                        "claim_id": "synthetic-stress",
                        "claim_type": "validation_requirement",
                        "claim_text": "Synthetic rollouts are stress-only evidence.",
                        "data_requirements": ["historical_replay"],
                    }
                ],
            },
            promotion_contract={
                "requires_historical_replay": True,
                "synthetic_evidence_policy": "validation_only_not_promotion_proof",
            },
        )
        candidate = candidate_prior_scoring._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-synthetic-contract",
                "objective_scorecard": {"net_pnl_per_day": "800"},
            },
        )

        bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate=candidate,
            dataset_snapshot_id="synthetic-recent-whitepaper-2025-2026",
            result_path="/tmp/synthetic-replay.json",
        )

        self.assertIn(
            "synthetic_evidence_not_promotion_proof",
            evidence_bundle_blockers(bundle),
        )

    def test_paper_mechanism_contract_prior_selects_replay_only_candidate(
        self,
    ) -> None:
        control_spec = self._candidate_spec(
            "spec-paper-control",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        paper_spec_base = self._candidate_spec(
            "spec-paper-contract",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        paper_spec = replace(
            paper_spec_base,
            feature_contract={
                **paper_spec_base.feature_contract,
                "source_claims": [
                    {
                        "claim_id": "claim-route-tca",
                        "claim_type": "execution_assumption",
                        "data_requirements": ["route_tca", "execution_shortfall"],
                    },
                    {
                        "claim_id": "claim-live-parity",
                        "claim_type": "validation_requirement",
                        "data_requirements": ["live_paper_parity"],
                    },
                ],
                "validation_requirements": [
                    {
                        "claim_id": "validate-fill-curve",
                        "claim_type": "validation_requirement",
                        "data_requirements": [
                            "fill_outcomes",
                            "runtime_ledger",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "queue_position_survival_fill_curve",
                        "required_evidence": [
                            "queue_position_survival_fill_curve",
                            "order_lifecycle_fill_evidence",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": [
                    "mixed_market_limit_execution_policy",
                    "queue_position_survival_fill_curve",
                ]
            },
            promotion_contract={
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_runtime_ledger": True,
                "rejects_synthetic_evidence": True,
            },
        )

        self.assertGreater(
            candidate_prior_scoring._pre_replay_candidate_score(paper_spec),
            candidate_prior_scoring._pre_replay_candidate_score(control_spec),
        )

        prior_bundle = feedback_bundle_builders._pre_replay_prior_bundle(paper_spec)
        self.assertFalse(prior_bundle.promotion_readiness["promotable"])
        self.assertIn(
            "runtime_replay_required", prior_bundle.promotion_readiness["blockers"]
        )
        self.assertIn(
            "validation_live_paper_parity_pending",
            prior_bundle.promotion_readiness["blockers"],
        )

        _model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(control_spec, paper_spec),
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in rows}

        self.assertGreater(
            Decimal(str(row_by_spec[paper_spec.candidate_spec_id]["proposal_score"])),
            Decimal(str(row_by_spec[control_spec.candidate_spec_id]["proposal_score"])),
        )
        self.assertLess(
            row_by_spec[paper_spec.candidate_spec_id]["rank"],
            row_by_spec[control_spec.candidate_spec_id]["rank"],
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(control_spec, paper_spec),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [paper_spec])
        self.assertEqual(
            selection["selected_candidate_spec_ids"], [paper_spec.candidate_spec_id]
        )
        paper_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == paper_spec.candidate_spec_id
        )
        control_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == control_spec.candidate_spec_id
        )
        self.assertTrue(paper_selection_row["selected_for_replay"])
        self.assertEqual(paper_selection_row["selection_reason"], "exploitation")
        self.assertEqual(
            control_selection_row["selection_reason"], "duplicate_execution_signature"
        )
        self.assertGreater(
            Decimal(str(paper_selection_row["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            paper_selection_row["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertIn(
            "route_tca", paper_selection_row["paper_required_evidence_tokens"]
        )
        self.assertIn(
            "live_paper_parity", paper_selection_row["paper_required_evidence_tokens"]
        )
        self.assertGreaterEqual(paper_selection_row["paper_required_evidence_count"], 6)
        self.assertEqual(
            selection["budget"]["paper_contract_candidate_selected_count"], 0
        )

        exploration_selected, exploration_selection = (
            runner._select_candidate_specs_for_replay(
                specs=(control_spec, paper_spec),
                proposal_rows=rows,
                top_k=0,
                exploration_slots=1,
                max_candidates=1,
                portfolio_size_min=1,
            )
        )

        self.assertEqual(exploration_selected, [paper_spec])
        self.assertEqual(
            exploration_selection["budget"]["paper_contract_candidate_selected_count"],
            1,
        )
        exploration_paper_row = next(
            row
            for row in exploration_selection["rows"]
            if row["candidate_spec_id"] == paper_spec.candidate_spec_id
        )
        self.assertEqual(
            exploration_paper_row["selection_reason"], "paper_contract_exploration"
        )

    def test_parse_args_defaults_to_500_daily_profit_program(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                sys,
                "argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    tmpdir,
                ],
            ):
                args = runner._parse_args()

        self.assertEqual(args.target_net_pnl_per_day, "500")
        self.assertEqual(args.epoch_id, "")
        self.assertEqual(
            args.program,
            Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            ),
        )
        self.assertIsNone(args.min_daily_net_pnl)
        self.assertEqual(args.symbols.split(","), _CHIP_UNIVERSE)
        self.assertEqual(args.feedback_evidence_jsonl, [])

    def test_parse_args_uses_reachable_clickhouse_env_defaults(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "http://127.0.0.1:8123",
                        "TA_CLICKHOUSE_USERNAME": "reader",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")
        self.assertEqual(args.clickhouse_username, "reader")
        self.assertEqual(args.clickhouse_password_env, "TA_CLICKHOUSE_PASSWORD")

    def test_parse_args_prefers_explicit_clickhouse_http_url_over_ta_jdbc(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut",
                        "CLICKHOUSE_HTTP_URL": "http://127.0.0.1:8123",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")

    def test_clickhouse_preflight_fails_fast_for_unresolved_in_cluster_dns(
        self,
    ) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.whitepaper_autoresearch_runner.artifact_io.socket.getaddrinfo",
            side_effect=socket.gaierror("not known"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertIn("clickhouse_endpoint_unreachable", failure)
        self.assertIn("TA_CLICKHOUSE_URL", failure)
        self.assertIn("--clickhouse-http-url", failure)

    def test_clickhouse_preflight_skips_explicit_non_cluster_endpoint(self) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            clickhouse_http_url="http://127.0.0.1:8123",
        )

        with patch(
            "scripts.whitepaper_autoresearch_runner.artifact_io.socket.getaddrinfo",
            side_effect=AssertionError("non-cluster endpoints are replay-checked"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")

    def test_clickhouse_preflight_skips_when_replay_tape_is_supplied(self) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            replay_tape_path=Path("/tmp/replay-tape.jsonl"),
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.whitepaper_autoresearch_runner.artifact_io.socket.getaddrinfo",
            side_effect=AssertionError("replay tape should bypass DNS preflight"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")
