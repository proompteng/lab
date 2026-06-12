from __future__ import annotations

from dataclasses import replace
import json
from argparse import Namespace
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence, cast
from unittest.mock import patch

from sqlalchemy.orm import Session

import scripts.run_whitepaper_autoresearch_profit_target as runner
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    RejectedSignalOutcomeEvent,
)
from app.trading.discovery.evidence_bundles import evidence_bundle_blockers
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)


class TestAutoresearchRunnerFeedbackEvidence(AutoresearchRunnerTestCase):
    def test_ranker_backend_preference_reaches_pre_and_post_replay_models(self) -> None:
        specs = [
            self._candidate_spec("spec-low"),
            self._candidate_spec("spec-high"),
        ]
        evidence_bundles = [
            runner.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=specs[0].candidate_spec_id,
                candidate={
                    "candidate_id": "candidate-low",
                    "objective_scorecard": {"net_pnl_per_day": "50"},
                },
                dataset_snapshot_id="snapshot",
                result_path="/tmp/low.json",
            ),
            runner.evidence_bundle_from_frontier_candidate(
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
        real_train_mlx_ranker = runner.train_mlx_ranker

        def capture_train_mlx_ranker(rows: Sequence[Any], **kwargs: Any) -> Any:
            captured_backend_preferences.append(str(kwargs.get("backend_preference")))
            return real_train_mlx_ranker(
                rows,
                backend_preference="numpy-fallback",
                steps=2,
            )

        with patch.object(
            runner,
            "train_mlx_ranker",
            side_effect=capture_train_mlx_ranker,
        ):
            runner._pre_replay_proposal_model_and_rows(
                specs=specs,
                feedback_evidence_bundles=(),
                oracle_policy=runner.ProfitTargetOraclePolicy(),
                ranker_backend_preference="torch-cuda",
            )
            runner._proposal_model_and_rows(
                specs=specs,
                evidence_bundles=evidence_bundles,
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

        candidate = runner._candidate_payload_with_feedback_metadata(
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

        candidate = runner._candidate_payload_with_feedback_metadata(
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
        bundle = runner.evidence_bundle_from_frontier_candidate(
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
        candidate = runner._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-synthetic-contract",
                "objective_scorecard": {"net_pnl_per_day": "800"},
            },
        )

        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate=candidate,
            dataset_snapshot_id="synthetic-recent-whitepaper-2025-2026",
            result_path="/tmp/synthetic-replay.json",
        )

        self.assertIn(
            "synthetic_evidence_not_promotion_proof",
            evidence_bundle_blockers(bundle),
        )

    def test_pre_replay_ranker_ingests_feedback_evidence_bundles(self) -> None:
        losing_spec = self._candidate_spec(
            "spec-losing",
            entry_minute_after_open="45",
            selection_mode="reversal",
        )
        unexplored_spec = self._candidate_spec(
            "spec-unexplored",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="90",
            selection_mode="continuation",
        )
        capital_unsafe_spec = self._candidate_spec(
            "spec-capital-unsafe",
            family_template_id="momentum_pullback_v1",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        losing_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=losing_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-losing",
                "family_template_id": losing_spec.family_template_id,
                "runtime_family": losing_spec.runtime_family,
                "runtime_strategy_name": losing_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-120",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 6,
                    "best_day_share": "1",
                    "worst_day_loss": "430",
                    "max_drawdown": "997",
                    "avg_filled_notional_per_day": "50000",
                    "hard_vetoes": ["positive_day_ratio_below_oracle"],
                    "daily_net": {
                        "2026-05-01": "-100",
                        "2026-05-04": "-140",
                    },
                },
            },
            dataset_snapshot_id="snap-feedback",
            result_path="feedback://losing",
        )
        capital_unsafe_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=capital_unsafe_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-capital-unsafe",
                "family_template_id": capital_unsafe_spec.family_template_id,
                "runtime_family": capital_unsafe_spec.runtime_family,
                "runtime_strategy_name": capital_unsafe_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "750",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "negative_day_count": 0,
                    "best_day_share": "0.25",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "max_gross_exposure_pct_equity": "2.5",
                    "min_cash": "-500",
                    "negative_cash_observation_count": 8,
                    "avg_filled_notional_per_day": "500000",
                },
            },
            dataset_snapshot_id="snap-feedback",
            result_path="feedback://capital-unsafe",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(losing_spec, unexplored_spec, capital_unsafe_spec),
            feedback_evidence_bundles=(losing_bundle, capital_unsafe_bundle),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_evidence_bundle_count"], 2)
        self.assertEqual(model["feedback_matched_spec_count"], 2)
        self.assertEqual(
            model["training_source_counts"],
            {"feedback_real_replay": 2, "synthetic_prior": 1},
        )
        self.assertEqual(
            row_by_spec[losing_spec.candidate_spec_id]["training_source"],
            "feedback_real_replay",
        )
        self.assertEqual(
            row_by_spec[losing_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_blocked",
        )
        self.assertEqual(
            row_by_spec[capital_unsafe_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertGreater(
            row_by_spec[losing_spec.candidate_spec_id]["rank"],
            row_by_spec[unexplored_spec.candidate_spec_id]["rank"],
        )
        self.assertGreater(
            row_by_spec[capital_unsafe_spec.candidate_spec_id]["proposal_score"],
            -999999,
        )
        self.assertEqual(
            row_by_spec[unexplored_spec.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )
        self.assertIn(
            "history_daily_target_shortfall",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )
        self.assertIn(
            "history_market_impact_stress_passed",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )
        self.assertIn(
            "history_delay_adjusted_depth_stress_passed",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )
        self.assertIn(
            "history_double_oos_cost_shock_net_pnl_per_day",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )

    def test_feedback_evidence_jsonl_round_trips(self) -> None:
        spec = self._candidate_spec("spec-feedback-jsonl")
        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-jsonl",
                "objective_scorecard": {
                    "net_pnl_per_day": "42",
                    "active_day_ratio": "1",
                },
            },
            dataset_snapshot_id="snap-feedback",
            result_path="feedback://jsonl",
        )

        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "feedback.jsonl"
            path.write_text(
                json.dumps(bundle.to_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            loaded = runner._load_feedback_evidence_bundles((path,))

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)

    def test_feedback_evidence_loads_recent_persisted_epoch_bundles(self) -> None:
        spec = self._candidate_spec("spec-feedback-persisted")
        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-persisted",
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-210",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 5,
                    "daily_net": {
                        "2026-05-01": "-120",
                        "2026-05-04": "-300",
                    },
                },
            },
            dataset_snapshot_id="snap-feedback-persisted",
            result_path="db://autoresearch/prior-epoch/candidate-evidence-bundles.jsonl",
        )
        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchEpoch(
                    epoch_id="prior-feedback-epoch",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={
                        "candidate_evidence_bundle_payloads": [bundle.to_payload()]
                    },
                    started_at=datetime(2026, 5, 12, 14, 0, 0),
                    completed_at=datetime(2026, 5, 12, 14, 5, 0),
                    failure_reason=None,
                )
            )
            session.commit()

            loaded, manifest = runner._load_autoresearch_feedback_evidence_bundles(
                (), include_persisted=True
            )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(manifest["combined_bundle_count"], 1)
        self.assertEqual(manifest["persisted"]["status"], "loaded")
        self.assertEqual(
            manifest["persisted"]["source_epoch_ids"], ["prior-feedback-epoch"]
        )
        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["feedback_match_scope"], "candidate_spec_id")

    def test_feedback_evidence_loads_labeled_rejected_signal_outcomes(self) -> None:
        spec = self._candidate_spec("spec-rejected-outcome-feedback")
        required_fields = [
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        ]
        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add_all(
                [
                    RejectedSignalOutcomeEvent(
                        event_id="reject-outcome-labeled",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="AAPL",
                        event_ts=datetime(2026, 5, 18, 14, 30, 0),
                        timeframe="1Min",
                        seq="1",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="labeled",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id
                        },
                        outcome_payload_json={
                            "candidate_id": "cand-rejected-outcome",
                            "candidate_spec_id": spec.candidate_spec_id,
                            "family_template_id": spec.family_template_id,
                            "runtime_family": spec.runtime_family,
                            "runtime_strategy_name": spec.runtime_strategy_name,
                            "counterfactual_return": "-0.0042",
                            "route_tca": {"post_cost_expectancy_bps_proxy": "-11.5"},
                            "post_cost_net_pnl": "-84.25",
                            "executable_quote": {"bid": "100.00", "ask": "100.02"},
                            "objective_scorecard": {
                                "net_pnl_per_day": "-84.25",
                                "active_day_ratio": "1",
                                "positive_day_ratio": "0",
                                "negative_day_count": 1,
                            },
                        },
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-outcome-pending",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="MSFT",
                        event_ts=datetime(2026, 5, 18, 14, 31, 0),
                        timeframe="1Min",
                        seq="2",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id
                        },
                        outcome_payload_json=None,
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-outcome-incomplete",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="NVDA",
                        event_ts=datetime(2026, 5, 18, 14, 32, 0),
                        timeframe="1Min",
                        seq="3",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="labeled",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id
                        },
                        outcome_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id,
                            "counterfactual_return": "-0.001",
                        },
                    ),
                ]
            )
            session.commit()

            loaded, manifest = runner._load_autoresearch_feedback_evidence_bundles(
                (), include_persisted=True
            )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(manifest["combined_bundle_count"], 1)
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_scanned_count"], 2
        )
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_bundle_count"], 1
        )
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_invalid_count"], 1
        )
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_event_ids"],
            ["reject-outcome-labeled"],
        )
        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["feedback_match_scope"], "candidate_spec_id")
        self.assertEqual(
            loaded[0].dataset_snapshot_id,
            "rejected-signal-outcome:reject-outcome-labeled",
        )

    def test_feedback_evidence_dedupe_handles_missing_bundle_ids(self) -> None:
        spec = self._candidate_spec("spec-feedback-dedupe")
        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-dedupe",
                "objective_scorecard": {"net_pnl_per_day": "10"},
            },
            dataset_snapshot_id="snap-feedback-dedupe",
            result_path="feedback://dedupe",
        )
        no_id_bundle = replace(bundle, evidence_bundle_id="")

        deduped = runner._dedupe_feedback_evidence_bundles((no_id_bundle, no_id_bundle))

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].candidate_spec_id, spec.candidate_spec_id)

    def test_feedback_evidence_persisted_loader_reports_unavailable_store(self) -> None:
        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=RuntimeError("db unavailable"),
        ):
            loaded, manifest = runner._load_autoresearch_feedback_evidence_bundles(
                (), include_persisted=True
            )

        self.assertEqual(loaded, ())
        self.assertEqual(manifest["combined_bundle_count"], 0)
        self.assertEqual(manifest["persisted"]["status"], "unavailable")
        self.assertIn("db unavailable", manifest["persisted"]["error"])

    def test_feedback_evidence_persisted_loader_reconstructs_summary_scorecards(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-summary-scorecard")
        scorecard = {
            "candidate_id": "cand-summary-scorecard",
            "execution_signature": runner._candidate_spec_execution_signature(spec),
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "net_pnl_per_day": "-121.10",
            "negative_day_count": "6",
            "daily_net": {"2026-05-01": "-90.25"},
            "hard_vetoes": ["train_net_per_day_below_screen"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchEpoch(
                    epoch_id="summary-feedback-epoch",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={
                        "build": {"commit": "abc123"},
                        "candidate_search_remediation": {
                            "partial_scorecards": [
                                {
                                    **scorecard,
                                    "execution_signature": "unmatched-signature",
                                },
                                scorecard,
                            ]
                        },
                    },
                    started_at=datetime(2026, 5, 12, 14, 0, 0),
                    completed_at=datetime(2026, 5, 12, 14, 5, 0),
                    failure_reason=None,
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id=spec.candidate_spec_id,
                    epoch_id="summary-feedback-epoch",
                    hypothesis_id=spec.hypothesis_id,
                    candidate_kind=spec.candidate_kind,
                    family_template_id=spec.family_template_id,
                    payload_json=spec.to_payload(),
                    payload_hash="summary-feedback-hash",
                    status="eligible",
                    blockers_json=None,
                )
            )
            session.commit()

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(loaded[0].candidate_id, "cand-summary-scorecard")
        self.assertEqual(
            loaded[0].dataset_snapshot_id,
            "autoresearch-epoch:summary-feedback-epoch:summary-scorecards",
        )
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["source_epoch_ids"], [])
        self.assertEqual(
            manifest["legacy_summary_source_epoch_ids"], ["summary-feedback-epoch"]
        )
        self.assertEqual(manifest["legacy_summary_scorecard_count"], 2)
        self.assertEqual(manifest["legacy_summary_matched_scorecard_count"], 1)
        self.assertEqual(manifest["legacy_summary_unmatched_scorecard_count"], 1)
        self.assertEqual(manifest["legacy_summary_bundle_count"], 1)

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["selection_reason"], "pre_replay_mlx_feedback_blocked")

    def test_feedback_evidence_persisted_loader_reconstructs_blocked_portfolio_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-portfolio-feedback")
        scorecard = {
            "net_pnl_per_day": "306.12",
            "portfolio_post_cost_net_pnl_per_day": "306.12",
            "active_day_ratio": "0.72",
            "positive_day_ratio": "0.68",
            "max_drawdown": "6400",
            "max_single_symbol_contribution_share": "0.91",
            "profit_target_oracle": {
                "passed": False,
                "blockers": [
                    "portfolio_post_cost_net_pnl_per_day_failed",
                    "max_single_symbol_contribution_share_failed",
                    "max_drawdown_failed",
                ],
            },
        }
        sleeve = {
            "candidate_id": "candidate-portfolio-feedback",
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "weight": "0.50",
            "expected_net_pnl_per_day": "153.06",
            "source_expected_net_pnl_per_day": "306.12",
            "risk_contribution": "3200",
            "source_risk_contribution": "6400",
            "correlation_cluster": "NVDA",
            "params": {
                "signal_motif": "order_flow_continuation",
                "selection_mode": "top",
                "rank_feature": "ofi_z",
                "capital_profile": "feedback_escape",
                "top_n": "2",
            },
            "universe_symbols": ["NVDA", "AMD"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-feedback-blocked",
                    epoch_id="portfolio-feedback-epoch",
                    source_candidate_ids_json=["candidate-portfolio-feedback"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=scorecard,
                    optimizer_report_json={"method": "test"},
                    payload_json={
                        "schema_version": "torghut.portfolio-candidate-spec.v1",
                        "portfolio_candidate_id": "portfolio-feedback-blocked",
                        "source_candidate_ids": ["candidate-portfolio-feedback"],
                        "target_net_pnl_per_day": "500",
                        "sleeves": [sleeve],
                        "objective_scorecard": scorecard,
                        "optimizer_report": {"method": "test"},
                    },
                    status="blocked",
                )
            )
            session.commit()

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(loaded[0].candidate_id, "candidate-portfolio-feedback")
        self.assertEqual(
            loaded[0].dataset_snapshot_id,
            "autoresearch-portfolio-candidate:portfolio-feedback-epoch:portfolio-feedback-blocked",
        )
        self.assertEqual(
            loaded[0].objective_scorecard["portfolio_candidate_id"],
            "portfolio-feedback-blocked",
        )
        self.assertEqual(loaded[0].objective_scorecard["portfolio_status"], "blocked")
        self.assertIn(
            "portfolio_post_cost_net_pnl_per_day_failed",
            loaded[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertIn(
            "max_drawdown_failed",
            loaded[0].objective_scorecard["hard_vetoes"],
        )
        self.assertTrue(loaded[0].objective_scorecard["feedback_shape_key"])
        self.assertTrue(loaded[0].objective_scorecard["feedback_risk_profile_key"])
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["portfolio_candidate_scanned_count"], 1)
        self.assertEqual(manifest["portfolio_candidate_bundle_count"], 1)
        self.assertEqual(
            manifest["portfolio_candidate_ids"], ["portfolio-feedback-blocked"]
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(
            rows[0]["selection_reason"], "pre_replay_mlx_feedback_penalized"
        )

    def test_portfolio_candidate_feedback_skips_non_feedback_and_empty_scorecards(
        self,
    ) -> None:
        non_feedback_status = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-ready",
            epoch_id="portfolio-feedback-skip-epoch",
            source_candidate_ids_json=["candidate-feedback-ready"],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json={"net_pnl_per_day": "520"},
            optimizer_report_json={},
            payload_json={
                "sleeves": [{"candidate_spec_id": "candidate-feedback-ready"}],
            },
            status="promotion_ready",
        )
        empty_scorecard = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-empty",
            epoch_id="portfolio-feedback-skip-epoch",
            source_candidate_ids_json=["candidate-feedback-empty"],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json={},
            optimizer_report_json={},
            payload_json={
                "sleeves": [{"candidate_spec_id": "candidate-feedback-empty"}],
            },
            status="blocked",
        )

        self.assertEqual(
            runner._portfolio_candidate_row_to_feedback_bundles(non_feedback_status),
            (),
        )
        self.assertEqual(
            runner._portfolio_candidate_row_to_feedback_bundles(empty_scorecard),
            (),
        )

    def test_portfolio_candidate_feedback_uses_fallback_sleeves_and_skips_invalid_ones(
        self,
    ) -> None:
        scorecard = {
            "net_pnl_per_day": "520",
            "profit_target_oracle": {
                "passed": False,
                "blockers": ["profit_factor_below_oracle"],
            },
        }
        fallback_row = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-fallback",
            epoch_id="portfolio-feedback-fallback-epoch",
            source_candidate_ids_json=["candidate-feedback-fallback"],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json=scorecard,
            optimizer_report_json={},
            payload_json={"objective_scorecard": scorecard},
            status="paper_probation",
        )
        invalid_sleeve_row = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-invalid-sleeve",
            epoch_id="portfolio-feedback-fallback-epoch",
            source_candidate_ids_json=[],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json=scorecard,
            optimizer_report_json={},
            payload_json={"sleeves": [{}], "objective_scorecard": scorecard},
            status="blocked",
        )

        fallback_bundles = runner._portfolio_candidate_row_to_feedback_bundles(
            fallback_row
        )

        self.assertEqual(len(fallback_bundles), 1)
        self.assertEqual(
            fallback_bundles[0].candidate_spec_id, "candidate-feedback-fallback"
        )
        self.assertEqual(
            fallback_bundles[0].objective_scorecard["portfolio_status"],
            "paper_probation",
        )
        self.assertIn(
            "profit_factor_below_oracle",
            fallback_bundles[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertEqual(
            runner._portfolio_candidate_row_to_feedback_bundles(invalid_sleeve_row),
            (),
        )

    def test_feedback_evidence_persisted_loader_skips_empty_invalid_and_limited_payloads(
        self,
    ) -> None:
        valid_spec = self._candidate_spec("spec-feedback-limit")
        valid_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=valid_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-limit",
                "objective_scorecard": {"net_pnl_per_day": "25"},
            },
            dataset_snapshot_id="snap-feedback-limit",
            result_path="feedback://limit",
        )
        extra_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-feedback-extra",
            candidate={
                "candidate_id": "cand-feedback-extra",
                "objective_scorecard": {"net_pnl_per_day": "30"},
            },
            dataset_snapshot_id="snap-feedback-limit",
            result_path="feedback://limit-extra",
        )
        invalid_payload = {"schema_version": "torghut.invalid-feedback.v1"}

        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add_all(
                [
                    AutoresearchEpoch(
                        epoch_id="feedback-empty-epoch",
                        status="no_profit_target_candidate",
                        target_net_pnl_per_day=Decimal("500"),
                        paper_run_ids_json=[],
                        snapshot_manifest_json={},
                        runner_config_json={},
                        summary_json={},
                        started_at=datetime(2026, 5, 13, 14, 0, 0),
                        completed_at=datetime(2026, 5, 13, 14, 5, 0),
                        failure_reason=None,
                    ),
                    AutoresearchEpoch(
                        epoch_id="feedback-invalid-and-limited-epoch",
                        status="no_profit_target_candidate",
                        target_net_pnl_per_day=Decimal("500"),
                        paper_run_ids_json=[],
                        snapshot_manifest_json={},
                        runner_config_json={},
                        summary_json={
                            "candidate_evidence_bundle_payloads": [
                                invalid_payload,
                                valid_bundle.to_payload(),
                                extra_bundle.to_payload(),
                            ]
                        },
                        started_at=datetime(2026, 5, 12, 14, 0, 0),
                        completed_at=datetime(2026, 5, 12, 14, 5, 0),
                        failure_reason=None,
                    ),
                    AutoresearchEpoch(
                        epoch_id="feedback-unscanned-after-limit-epoch",
                        status="no_profit_target_candidate",
                        target_net_pnl_per_day=Decimal("500"),
                        paper_run_ids_json=[],
                        snapshot_manifest_json={},
                        runner_config_json={},
                        summary_json={
                            "candidate_evidence_bundle_payloads": [
                                extra_bundle.to_payload()
                            ]
                        },
                        started_at=datetime(2026, 5, 11, 14, 0, 0),
                        completed_at=datetime(2026, 5, 11, 14, 5, 0),
                        failure_reason=None,
                    ),
                ]
            )
            session.commit()

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles(
                limit=1
            )

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, valid_spec.candidate_spec_id)
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["invalid_payload_count"], 1)
        self.assertEqual(
            manifest["source_epoch_ids"], ["feedback-invalid-and-limited-epoch"]
        )

    def test_feedback_evidence_jsonl_reports_missing_and_invalid_lines(self) -> None:
        with TemporaryDirectory() as tmpdir:
            missing_path = Path(tmpdir) / "missing.jsonl"
            with self.assertRaisesRegex(
                ValueError,
                "feedback_evidence_jsonl_missing",
            ):
                runner._load_feedback_evidence_bundles((missing_path,))

            invalid_path = Path(tmpdir) / "invalid.jsonl"
            invalid_path.write_text("\n[]\n", encoding="utf-8")
            with self.assertRaisesRegex(
                ValueError,
                "feedback_evidence_jsonl_invalid",
            ):
                runner._load_feedback_evidence_bundles((invalid_path,))

    def test_candidate_quality_gate_flags_capital_safety_failures(self) -> None:
        policy = runner.ProfitTargetOraclePolicy()

        failures = runner._candidate_quality_gate_failures(
            {
                "net_pnl_per_day": "750",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.1",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "1.2",
                "min_cash": "-10",
                "negative_cash_observation_count": "1",
                "avg_filled_notional_per_day": "500000",
                "regime_slice_pass_rate": "1",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                "executable_replay_passed": True,
                "executable_replay_artifact_ref": "/tmp/replay.json",
                "executable_replay_order_count": "5",
                "executable_replay_account_buying_power": "10000",
                "executable_replay_max_notional_per_trade": "9000",
            },
            oracle_policy=policy,
        )

        self.assertIn("max_gross_exposure_above_oracle", failures)
        self.assertIn("min_cash_below_oracle", failures)
        self.assertIn("negative_cash_observed", failures)

    def test_candidate_quality_gate_preserves_current_oracle_blockers(self) -> None:
        policy = runner.ProfitTargetOraclePolicy()

        failures = runner._candidate_quality_gate_failures(
            {
                "net_pnl_per_day": "750",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "profit_factor": "2",
                "best_day_share": "0.1",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "0.5",
                "min_cash": "0",
                "negative_cash_observation_count": "0",
                "avg_filled_notional_per_day": "500000",
                "regime_slice_pass_rate": "1",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                "executable_replay_passed": True,
                "executable_replay_artifact_ref": "/tmp/replay.json",
                "executable_replay_order_count": "5",
                "executable_replay_account_buying_power": "10000",
                "executable_replay_max_notional_per_trade": "9000",
                "profit_target_oracle": {
                    "passed": False,
                    "blockers": [
                        "min_daily_net_pnl_failed",
                        "max_single_day_contribution_share_failed",
                        "max_single_symbol_contribution_share_failed",
                        "max_cluster_contribution_share_failed",
                        "market_impact_liquidity_evidence_present_failed",
                        "delay_adjusted_depth_stress_model_failed",
                    ],
                },
            },
            oracle_policy=policy,
        )

        self.assertIn("min_daily_net_pnl_failed", failures)
        self.assertIn("max_single_day_contribution_share_failed", failures)
        self.assertIn("max_single_symbol_contribution_share_failed", failures)
        self.assertIn("max_cluster_contribution_share_failed", failures)
        self.assertIn("market_impact_liquidity_evidence_present_failed", failures)
        self.assertIn("delay_adjusted_depth_stress_model_failed", failures)

    def test_candidate_quality_gate_flags_weak_profit_factor(self) -> None:
        policy = runner.ProfitTargetOraclePolicy()

        failures = runner._candidate_quality_gate_failures(
            {
                "net_pnl_per_day": "750",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.67",
                "profit_factor": "1.20",
                "best_day_share": "0.1",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "0.5",
                "min_cash": "0",
                "negative_cash_observation_count": "0",
                "avg_filled_notional_per_day": "500000",
                "regime_slice_pass_rate": "1",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                "executable_replay_passed": True,
                "executable_replay_artifact_ref": "/tmp/replay.json",
                "executable_replay_order_count": "5",
                "executable_replay_account_buying_power": "10000",
                "executable_replay_max_notional_per_trade": "9000",
            },
            oracle_policy=policy,
        )

        self.assertEqual(failures, ["profit_factor_below_oracle"])

    def test_oracle_policy_from_args_carries_full_promotion_risk_parameters(
        self,
    ) -> None:
        policy = runner._oracle_policy_from_args(
            Namespace(
                min_profit_factor="1.65",
                max_worst_day_loss="999999999",
                max_drawdown="999999999",
                max_worst_day_loss_pct_equity="0.06",
                max_drawdown_pct_equity="0.09",
                extended_max_worst_day_loss_pct_equity="0.10",
                extended_max_drawdown_pct_equity="0.14",
                min_total_net_pnl_to_drawdown_ratio="3.50",
                max_gross_exposure_pct_equity="0.85",
                min_cash="250",
                max_negative_cash_observation_count=0,
            )
        )

        self.assertEqual(policy.min_profit_factor, Decimal("1.65"))
        self.assertEqual(policy.max_worst_day_loss, Decimal("999999999"))
        self.assertEqual(policy.max_drawdown, Decimal("999999999"))
        self.assertEqual(policy.max_worst_day_loss_pct_equity, Decimal("0.06"))
        self.assertEqual(policy.max_drawdown_pct_equity, Decimal("0.09"))
        self.assertEqual(policy.extended_max_worst_day_loss_pct_equity, Decimal("0.10"))
        self.assertEqual(policy.extended_max_drawdown_pct_equity, Decimal("0.14"))
        self.assertEqual(policy.min_total_net_pnl_to_drawdown_ratio, Decimal("3.50"))
        self.assertEqual(policy.max_gross_exposure_pct_equity, Decimal("0.85"))
        self.assertEqual(policy.min_cash, Decimal("250"))

    def test_candidate_spec_contract_exposes_full_promotion_risk_parameters(
        self,
    ) -> None:
        policy = runner.ProfitTargetOraclePolicy(
            max_gross_exposure_pct_equity=Decimal("0.85"),
            min_cash=Decimal("250"),
            max_negative_cash_observation_count=0,
        )

        updated = runner._candidate_spec_with_oracle_policy(
            self._candidate_spec("spec-full-promotion-policy"),
            oracle_policy=policy,
        )

        self.assertEqual(
            updated.hard_vetoes["required_max_gross_exposure_pct_equity"],
            "0.85",
        )
        self.assertEqual(updated.hard_vetoes["required_min_cash"], "250")
        self.assertEqual(
            updated.hard_vetoes["required_max_negative_cash_observation_count"],
            "0",
        )
        self.assertEqual(
            updated.promotion_contract["profit_target_oracle_policy"][
                "max_gross_exposure_pct_equity"
            ],
            "0.85",
        )

    def test_pre_replay_ranker_keeps_best_duplicate_feedback_and_blocks_rejections(
        self,
    ) -> None:
        string_veto_spec = self._candidate_spec("spec-string-veto")
        min_cash_spec = self._candidate_spec("spec-min-cash")
        negative_cash_spec = self._candidate_spec("spec-negative-cash")
        unexplored_spec = self._candidate_spec(
            "spec-unexplored-feedback",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="90",
            selection_mode="continuation",
        )

        def feedback(
            spec: runner.CandidateSpec,
            *,
            candidate_id: str,
            scorecard: dict[str, object],
        ) -> runner.CandidateEvidenceBundle:
            return runner.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": candidate_id,
                    "family_template_id": spec.family_template_id,
                    "runtime_family": spec.runtime_family,
                    "runtime_strategy_name": spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "100",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "best_day_share": "0.2",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "0",
                        "negative_cash_observation_count": 0,
                        "avg_filled_notional_per_day": "500000",
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "feedback://market-impact",
                        "market_impact_stress_model": "almgren_chriss_proxy",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_stress_components": {
                            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                            "selected_model": "almgren_chriss_proxy",
                            "selected_cost_bps": "6",
                        },
                        "nonlinear_market_impact_stress_passed": True,
                        "nonlinear_market_impact_stress_model": "almgren_chriss_proxy",
                        "nonlinear_market_impact_stress_cost_bps": "6",
                        "nonlinear_market_impact_stress_net_pnl_per_day": "500",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "500",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": "feedback://delay-depth",
                        "delay_adjusted_depth_fillable_notional_per_day": "500000",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "500",
                        "delay_adjusted_depth_fill_survival_evidence_present": True,
                        "delay_adjusted_depth_fill_survival_sample_count": 12,
                        "delay_adjusted_depth_fill_survival_rate": "0.85",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 12,
                        "queue_position_survival_fill_rate": "0.85",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 12,
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 12,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "500",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "feedback://double-oos",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1",
                        "double_oos_net_pnl_per_day": "500",
                        "double_oos_cost_shock_net_pnl_per_day": "500",
                        "implementation_uncertainty_stability_passed": True,
                        "implementation_uncertainty_lower_net_pnl_per_day": "500",
                        "conformal_tail_risk_passed": True,
                        "conformal_tail_risk_adjusted_net_pnl_per_day": "500",
                        **scorecard,
                    },
                },
                dataset_snapshot_id="snap-feedback-blockers",
                result_path=f"feedback://{candidate_id}",
            )

        lower_duplicate = feedback(
            string_veto_spec,
            candidate_id="cand-string-veto-low",
            scorecard={"net_pnl_per_day": "-500"},
        )
        higher_blocked_duplicate = feedback(
            string_veto_spec,
            candidate_id="cand-string-veto-high",
            scorecard={
                "net_pnl_per_day": "250",
                "hard_vetoes": "positive_day_ratio_below_oracle",
            },
        )
        min_cash_blocked = feedback(
            min_cash_spec,
            candidate_id="cand-min-cash",
            scorecard={"min_cash": "-1"},
        )
        negative_cash_blocked = feedback(
            negative_cash_spec,
            candidate_id="cand-negative-cash",
            scorecard={"negative_cash_observation_count": "1"},
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(
                string_veto_spec,
                min_cash_spec,
                negative_cash_spec,
                unexplored_spec,
            ),
            feedback_evidence_bundles=(
                lower_duplicate,
                higher_blocked_duplicate,
                min_cash_blocked,
                negative_cash_blocked,
            ),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_evidence_bundle_count"], 4)
        self.assertEqual(model["feedback_matched_spec_count"], 3)
        self.assertEqual(
            row_by_spec[string_veto_spec.candidate_spec_id]["feedback_replay_target"],
            -727.5,
        )
        self.assertEqual(
            row_by_spec[string_veto_spec.candidate_spec_id]["features"][
                "history_observed_replay_viability_penalty"
            ],
            50.0,
        )
        self.assertEqual(
            row_by_spec[string_veto_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[min_cash_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[negative_cash_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[unexplored_spec.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )

    def test_pre_replay_ranker_blocks_feedback_execution_signature_drift(
        self,
    ) -> None:
        original_spec = self._candidate_spec("spec-original-signature")
        drifted_spec = replace(
            original_spec,
            candidate_spec_id="spec-drifted-signature",
            hypothesis_id="hyp-spec-drifted-signature",
            feature_contract={
                **dict(original_spec.feature_contract),
                "source_run_id": "source-spec-drifted-signature",
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=original_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-original-signature",
                "family_template_id": original_spec.family_template_id,
                "runtime_family": original_spec.runtime_family,
                "runtime_strategy_name": original_spec.runtime_strategy_name,
                "execution_signature": runner._candidate_spec_execution_signature(
                    original_spec
                ),
                "objective_scorecard": {
                    "net_pnl_per_day": "-33",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 5,
                    "daily_net": {
                        "2026-05-01": "-12",
                        "2026-05-04": "-54",
                    },
                },
            },
            dataset_snapshot_id="snap-feedback-signature",
            result_path="feedback://signature-drift",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(drifted_spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_matched_spec_count"], 0)
        self.assertEqual(model["feedback_execution_signature_matched_spec_count"], 1)
        row = rows[0]
        self.assertEqual(row["candidate_spec_id"], drifted_spec.candidate_spec_id)
        self.assertEqual(row["training_source"], "feedback_execution_signature_replay")
        self.assertEqual(
            row["selection_reason"], "pre_replay_mlx_signature_feedback_blocked"
        )
        self.assertEqual(
            row["feedback_source_candidate_spec_id"],
            original_spec.candidate_spec_id,
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(drifted_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_feedback_blocked_candidate_count"], 1
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_signature_feedback_blocked",
        )

    def test_pre_replay_ranker_penalizes_family_feedback_without_blocking_mutations(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-family-source")
        mutated_family_spec = self._candidate_spec(
            "spec-family-mutated",
            entry_minute_after_open="60",
        )
        unrelated_spec = self._candidate_spec(
            "spec-unrelated-family",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="90",
            selection_mode="continuation",
        )
        family_feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-family-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "125",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "negative_day_count": 0,
                    "daily_net": {
                        "2026-05-01": "250",
                        "2026-05-04": "-25",
                    },
                },
            },
            dataset_snapshot_id="snap-family-feedback",
            result_path="feedback://family",
        )
        no_family_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-not-in-current-epoch",
            candidate={
                "candidate_id": "cand-no-family",
                "objective_scorecard": {
                    "net_pnl_per_day": "-999",
                    "daily_net": {"2026-05-01": "-999"},
                },
            },
            dataset_snapshot_id="snap-no-family",
            result_path="feedback://no-family",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(mutated_family_spec, unrelated_spec),
            feedback_evidence_bundles=(family_feedback_bundle, no_family_bundle),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_family_matched_spec_count"], 1)
        self.assertEqual(model["training_source_counts"]["feedback_family_replay"], 1)
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id]["training_source"],
            "feedback_family_replay",
        )
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id]["feedback_match_scope"],
            "family_template_id",
        )
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id][
                "feedback_source_candidate_spec_id"
            ],
            source_spec.candidate_spec_id,
        )
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_family_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[unrelated_spec.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )

    def test_pre_replay_ranker_blocks_shape_and_penalizes_risk_profile_feedback(
        self,
    ) -> None:
        failed_spec = self._candidate_spec("spec-daily-coverage-source")
        same_shape_probe = replace(
            failed_spec,
            candidate_spec_id="spec-same-shape-probe",
            hypothesis_id="hyp-spec-same-shape-probe",
            hard_vetoes={"required_min_daily_notional": "400000"},
        )
        different_shape_same_risk_probe = replace(
            failed_spec,
            candidate_spec_id="spec-risk-profile-probe",
            hypothesis_id="hyp-spec-risk-profile-probe",
            hard_vetoes={"required_min_daily_notional": "450000"},
            strategy_overrides={
                **failed_spec.strategy_overrides,
                "params": {
                    **cast(dict[str, Any], failed_spec.strategy_overrides["params"]),
                    "entry_minute_after_open": "90",
                },
            },
        )
        clean_probe = self._candidate_spec(
            "spec-clean-probe",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="120",
            selection_mode="continuation",
        )
        self.assertNotEqual(
            runner._candidate_spec_execution_signature(failed_spec),
            runner._candidate_spec_execution_signature(same_shape_probe),
        )
        self.assertEqual(
            runner._candidate_spec_feedback_shape_key(failed_spec),
            runner._candidate_spec_feedback_shape_key(same_shape_probe),
        )
        self.assertNotEqual(
            runner._candidate_spec_feedback_shape_key(failed_spec),
            runner._candidate_spec_feedback_shape_key(different_shape_same_risk_probe),
        )
        self.assertEqual(
            runner._candidate_spec_feedback_risk_profile_key(failed_spec),
            runner._candidate_spec_feedback_risk_profile_key(
                different_shape_same_risk_probe
            ),
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-daily-coverage-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "959.07",
                        "active_day_ratio": "0.2",
                        "positive_day_ratio": "0.2",
                        "negative_day_count": 0,
                        "best_day_share": "0.92",
                        "daily_net": {
                            "2026-05-01": "4795.37",
                            "2026-05-04": "0",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-daily-coverage-feedback",
            result_path="feedback://daily-coverage",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(same_shape_probe, different_shape_same_risk_probe, clean_probe),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_shape_matched_spec_count"], 1)
        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 1)
        self.assertEqual(
            row_by_spec[same_shape_probe.candidate_spec_id]["training_source"],
            "feedback_shape_prior",
        )
        self.assertEqual(
            row_by_spec[same_shape_probe.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_shape_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(
                str(row_by_spec[same_shape_probe.candidate_spec_id]["proposal_score"])
            ),
            Decimal("-999999"),
        )
        self.assertEqual(
            row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                "training_source"
            ],
            "feedback_risk_profile_prior",
        )
        self.assertEqual(
            row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                "selection_reason"
            ],
            "pre_replay_mlx_risk_profile_feedback_penalized",
        )
        self.assertLessEqual(
            Decimal(
                str(
                    row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                        "proposal_score"
                    ]
                )
            ),
            Decimal("-500000"),
        )
        self.assertEqual(
            row_by_spec[clean_probe.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )

    def test_feedback_risk_profile_uses_oracle_policy_and_allows_down_days(
        self,
    ) -> None:
        policy = runner.ProfitTargetOraclePolicy(
            min_active_day_ratio=Decimal("0.90"),
            min_positive_day_ratio=Decimal("0.60"),
            max_best_day_share=Decimal("0.25"),
            max_single_symbol_contribution_share=Decimal("0.35"),
            max_cluster_contribution_share=Decimal("0.40"),
            max_gross_exposure_pct_equity=Decimal("1.25"),
            min_cash=Decimal("-10"),
            max_negative_cash_observation_count=1,
        )
        scorecard = {
            "net_pnl_per_day": "250",
            "active_day_ratio": "0.95",
            "positive_day_ratio": "0.65",
            "best_day_share": "0.20",
            "max_single_day_contribution_share": "0.20",
            "max_single_symbol_contribution_share": "0.30",
            "max_cluster_contribution_share": "0.35",
            "max_gross_exposure_pct_equity": "1.10",
            "min_cash": "-5",
            "negative_cash_observation_count": "1",
            "negative_day_count": "1",
            "daily_net": {
                "2026-05-01": "-50",
                "2026-05-02": "300",
            },
        }

        self.assertFalse(
            runner._feedback_risk_profile_has_penalty(scorecard, oracle_policy=policy)
        )
        self.assertFalse(runner._feedback_is_blocked(scorecard, oracle_policy=policy))
        self.assertFalse(
            runner._feedback_family_prior_has_hard_block(
                scorecard, oracle_policy=policy
            )
        )
        self.assertFalse(
            runner._feedback_risk_profile_has_terminal_block(
                {
                    **scorecard,
                    "profit_target_oracle": {
                        "blockers": ["max_single_day_contribution_share_failed"]
                    },
                },
                oracle_policy=policy,
            )
        )

        strict_policy = replace(
            policy,
            max_gross_exposure_pct_equity=Decimal("1.0"),
            min_cash=Decimal("0"),
            max_negative_cash_observation_count=0,
        )
        self.assertTrue(
            runner._feedback_is_blocked(scorecard, oracle_policy=strict_policy)
        )
        self.assertTrue(
            runner._feedback_risk_profile_has_penalty(
                {
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "best_day_share": "0.20",
                },
                oracle_policy=policy,
            )
        )

    def test_feedback_shape_prior_penalizes_cash_blocks_without_family_veto(
        self,
    ) -> None:
        failed_spec = self._candidate_spec("spec-shape-cash-source")
        same_shape_probe = replace(
            failed_spec,
            candidate_spec_id="spec-shape-cash-probe",
            hypothesis_id="hyp-spec-shape-cash-probe",
            hard_vetoes={"required_min_daily_notional": "400000"},
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-shape-cash-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "250",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "best_day_share": "0.25",
                        "min_cash": "-1",
                    },
                },
            ),
            dataset_snapshot_id="snap-shape-cash-feedback",
            result_path="feedback://shape-cash",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(same_shape_probe,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_shape_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_shape_prior")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_family_feedback_penalized",
        )

    def test_feedback_scorecard_helpers_cover_veto_and_penalty_edges(self) -> None:
        invalid_universe_spec = replace(
            self._candidate_spec("spec-invalid-universe"),
            strategy_overrides={
                **self._candidate_spec("spec-invalid-universe").strategy_overrides,
                "universe_symbols": "NVDA",
            },
        )
        self.assertEqual(runner._candidate_spec_universe_key(invalid_universe_spec), "")
        self.assertTrue(
            runner._feedback_scorecard_has_hard_veto(
                {
                    "profit_target_oracle": {
                        "blockers": ["positive_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            runner._feedback_scorecard_has_hard_veto({"oracle_passed": False})
        )
        self.assertFalse(runner._feedback_daily_net_has_loss({"daily_net": "bad"}))
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block(
                {
                    "profit_target_oracle": {
                        "blockers": ["active_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block({"positive_day_ratio": "0.5"})
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block({"best_day_share": "0.51"})
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block(
                {
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "best_day_share": "0.25",
                    "daily_net": {"2026-05-01": "0"},
                }
            )
        )
        for scorecard in (
            {
                "profit_target_oracle": {
                    "blockers": ["max_single_day_contribution_share_failed"]
                }
            },
            {"best_day_share": "0.36"},
            {"max_single_day_contribution_share": "0.36"},
            {"max_single_symbol_contribution_share": "0.36"},
            {"max_cluster_contribution_share": "0.41"},
        ):
            self.assertTrue(runner._feedback_risk_profile_has_penalty(scorecard))
        self.assertEqual(runner._feedback_risk_profile_key_from_scorecard({}), "")

        spec = self._candidate_spec("spec-empty-risk-key")
        orphan_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-unmatched-risk-feedback",
            candidate={
                "candidate_id": "cand-unmatched-risk-feedback",
                "objective_scorecard": {"positive_day_ratio": "0.5"},
            },
            dataset_snapshot_id="snap-empty-risk-key",
            result_path="feedback://empty-risk-key",
        )
        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(orphan_bundle,),
        )

        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 0)
        self.assertEqual(rows[0]["training_source"], "synthetic_prior")

    def test_feedback_evidence_loader_reconstructs_paper_probation_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("candidate-portfolio-probation")
        scorecard = {
            "target_met": True,
            "oracle_passed": False,
            "net_pnl_per_day": "525",
            "profit_target_oracle": {
                "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"]
            },
        }
        sleeve = {
            "candidate_id": "candidate-portfolio-probation",
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "weight": "1.00",
            "expected_net_pnl_per_day": "525",
            "source_expected_net_pnl_per_day": "525",
            "risk_contribution": "2500",
            "source_risk_contribution": "2500",
            "correlation_cluster": "NVDA",
            "params": {"signal_motif": "order_flow_continuation"},
            "universe_symbols": ["NVDA"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-feedback-probation",
                    epoch_id="portfolio-feedback-probation-epoch",
                    source_candidate_ids_json=["candidate-portfolio-probation"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=scorecard,
                    optimizer_report_json={"method": "test"},
                    payload_json={
                        "schema_version": "torghut.portfolio-candidate-spec.v1",
                        "portfolio_candidate_id": "portfolio-feedback-probation",
                        "source_candidate_ids": ["candidate-portfolio-probation"],
                        "target_net_pnl_per_day": "500",
                        "sleeves": [sleeve],
                        "objective_scorecard": scorecard,
                        "optimizer_report": {"method": "test"},
                        "promotion_readiness": {
                            "stage": "research_portfolio",
                            "status": "blocked_pending_promotion_prerequisites",
                            "promotable": False,
                            "blockers": [
                                "delay_adjusted_depth_tail_coverage_passed_failed"
                            ],
                        },
                    },
                    status="paper_probation",
                )
            )
            session.commit()

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(
            loaded[0].objective_scorecard["portfolio_status"], "paper_probation"
        )
        self.assertIn(
            "delay_adjusted_depth_tail_coverage_passed_failed",
            loaded[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertEqual(manifest["portfolio_candidate_bundle_count"], 1)
