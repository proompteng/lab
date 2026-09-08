from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import app.trading.discovery.profit_target_oracle as profit_target_oracle
from app.trading.discovery.candidate_specs import CandidateSpec
import scripts.whitepaper_autoresearch_runner.candidate_identity as candidate_identity
import scripts.whitepaper_autoresearch_runner.feedback_loading as feedback_loading
import scripts.whitepaper_autoresearch_runner.oracle_policy as oracle_policy
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building
import scripts.whitepaper_autoresearch_runner.proposal_training as proposal_training

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Decimal,
    Namespace,
    Path,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    replace,
)
import scripts.whitepaper_autoresearch_runner.replay_selection as replay_selection


class TestAutoresearchRunnerQualityOracle(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_feedback_evidence_jsonl_reports_missing_and_invalid_lines(self) -> None:
        with TemporaryDirectory() as tmpdir:
            missing_path = Path(tmpdir) / "missing.jsonl"
            with self.assertRaisesRegex(
                ValueError,
                "feedback_evidence_jsonl_missing",
            ):
                feedback_loading._load_feedback_evidence_bundles((missing_path,))

            invalid_path = Path(tmpdir) / "invalid.jsonl"
            invalid_path.write_text("\n[]\n", encoding="utf-8")
            with self.assertRaisesRegex(
                ValueError,
                "feedback_evidence_jsonl_invalid",
            ):
                feedback_loading._load_feedback_evidence_bundles((invalid_path,))

    def test_candidate_quality_gate_flags_capital_safety_failures(self) -> None:
        policy = profit_target_oracle.ProfitTargetOraclePolicy()

        failures = proposal_training._candidate_quality_gate_failures(
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
        policy = profit_target_oracle.ProfitTargetOraclePolicy()

        failures = proposal_training._candidate_quality_gate_failures(
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
        policy = profit_target_oracle.ProfitTargetOraclePolicy()

        failures = proposal_training._candidate_quality_gate_failures(
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
        policy = oracle_policy._oracle_policy_from_args(
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
        policy = profit_target_oracle.ProfitTargetOraclePolicy(
            max_gross_exposure_pct_equity=Decimal("0.85"),
            min_cash=Decimal("250"),
            max_negative_cash_observation_count=0,
        )

        updated = oracle_policy._candidate_spec_with_oracle_policy(
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
            spec: CandidateSpec,
            *,
            candidate_id: str,
            scorecard: dict[str, object],
        ) -> evidence_bundles.CandidateEvidenceBundle:
            return evidence_bundles.evidence_bundle_from_frontier_candidate(
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

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
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
        feedback_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=original_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-original-signature",
                "family_template_id": original_spec.family_template_id,
                "runtime_family": original_spec.runtime_family,
                "runtime_strategy_name": original_spec.runtime_strategy_name,
                "execution_signature": candidate_identity._candidate_spec_execution_signature(
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

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
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

        selected, selection = replay_selection._select_candidate_specs_for_replay(
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
        family_feedback_bundle = (
            evidence_bundles.evidence_bundle_from_frontier_candidate(
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
        )
        no_family_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
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

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
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
