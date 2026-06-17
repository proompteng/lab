from __future__ import annotations

# ruff: noqa: F401,F403,F405
from typing import Any


def assert_fast_replay_preview_mechanism_payloads(
    test_case: Any,
    payload: dict[str, Any],
    row_payload: dict[str, Any],
    stress_payload: dict[str, Any],
) -> None:
    test_case.assertIn(
        "source_backed_runtime_ledger_proof_required", payload["blockers"]
    )
    test_case.assertIn("conformal_tail_risk", payload["implemented_mechanisms"])
    test_case.assertIn(
        "hawkes_event_time_excitation_replay_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "time-rescaling GOF proxy",
        payload["implemented_mechanisms"]["hawkes_event_time_excitation_replay_stress"],
    )
    test_case.assertIn(
        "arXiv:2502.17417",
        payload["implemented_mechanisms"]["hawkes_event_time_excitation_replay_stress"],
    )
    test_case.assertIn(
        "mpc_market_limit_execution_schedule_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "order_book_observability_feedback_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "markov_order_transition_latent_regime_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "order_flow_entropy_hmm_regime_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "dynamic_lead_lag_cross_asset_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "queue_position_survival_fill_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "public_feed_lag_quoted_liquidity_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "lob_simulation_reality_gap_execution_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "alpha_decay_predictability_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "counterfactual_regime_replay_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "nonlinear_impact_execution_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "option_gamma_flow_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "intraday_jump_burst_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "intraday_price_path_asymmetry_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "rough_flow_volatility_impact_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "institutional_mechanism_fidelity_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "signal_adaptive_execution_resilience_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "stochastic_liquidity_resilience_execution_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "microstructure_regime_tokenization_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "cost_aware_forecast_filter_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "adaptive_market_limit_allocation_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "metaorder_adverse_selection_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "bootstrap_robust_optimization_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "adaptive_signal_falsification_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "hawkes_transient_impact_execution_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertIn(
        "ofi_response_horizon_execution_stress",
        payload["implemented_mechanisms"],
    )
    test_case.assertEqual(
        row_payload["target_implied_notional_context"]["target_net_pnl_per_day"],
        "500",
    )
    test_case.assertIn("observed_post_cost_expectancy_bps", row_payload)
    test_case.assertIn("execution_schedule_stress", row_payload)
    test_case.assertFalse(row_payload["execution_schedule_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["execution_schedule_stress"]["promotion_authority"]
    )
    test_case.assertIn("order_book_observability_stress", row_payload)
    test_case.assertFalse(
        row_payload["order_book_observability_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["order_book_observability_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "arxiv-2605.19584",
        {
            source["source_id"]
            for source in row_payload["order_book_observability_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn("order_transition_stress", row_payload)
    test_case.assertFalse(row_payload["order_transition_stress"]["proof_authority"])
    test_case.assertFalse(row_payload["order_transition_stress"]["promotion_authority"])
    test_case.assertEqual(
        row_payload["order_transition_stress"]["status"],
        "preview_only_order_transition_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2502.07625",
        {
            source["source_id"]
            for source in row_payload["order_transition_stress"]["source_papers"]
        },
    )
    test_case.assertIn("order_flow_entropy_regime_stress", row_payload)
    test_case.assertFalse(
        row_payload["order_flow_entropy_regime_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["order_flow_entropy_regime_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["order_flow_entropy_regime_stress"]["status"],
        "preview_only_order_flow_entropy_regime_stress_ranking",
    )
    test_case.assertIn(
        "ssrn-5315733",
        {
            source["source_id"]
            for source in row_payload["order_flow_entropy_regime_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn("lead_lag_cross_asset_stress", row_payload)
    test_case.assertFalse(row_payload["lead_lag_cross_asset_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["lead_lag_cross_asset_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["lead_lag_cross_asset_stress"]["status"],
        "preview_only_lead_lag_cross_asset_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2511.00390",
        {
            source["source_id"]
            for source in row_payload["lead_lag_cross_asset_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "lead_lag_cross_asset_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "lead_lag_cross_asset_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("queue_survival_fill_stress", row_payload)
    test_case.assertFalse(row_payload["queue_survival_fill_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["queue_survival_fill_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["queue_survival_fill_stress"]["status"],
        "preview_only_queue_survival_fill_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2512.05734",
        {
            source["source_id"]
            for source in row_payload["queue_survival_fill_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "arxiv-2403.02572v2",
        {
            source["source_id"]
            for source in row_payload["queue_survival_fill_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "arxiv-2507.06345v2",
        {
            source["source_id"]
            for source in row_payload["queue_survival_fill_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "ssrn-6574208",
        {
            source["source_id"]
            for source in row_payload["queue_survival_fill_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "arxiv-2502.18625",
        {
            source["source_id"]
            for source in row_payload["queue_survival_fill_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "arxiv-2605.25527",
        {
            source["source_id"]
            for source in row_payload["queue_survival_fill_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "queue_allocation_rule_sensitivity_penalty_bps",
        row_payload["queue_survival_fill_stress"]["ranking_features"],
    )
    test_case.assertIn(
        "maker_fill_return_tradeoff_penalty_bps",
        row_payload["queue_survival_fill_stress"]["ranking_features"],
    )
    test_case.assertIn(
        "group_normalized_downside_reward_penalty_bps",
        row_payload["queue_survival_fill_stress"]["ranking_features"],
    )
    test_case.assertIn(
        "state_dependent_fill_risk_penalty_bps",
        row_payload["queue_survival_fill_stress"]["ranking_features"],
    )
    test_case.assertTrue(
        row_payload["queue_survival_fill_stress"][
            "queue_allocation_rule_sensitivity_preview"
        ]
    )
    test_case.assertTrue(
        row_payload["queue_survival_fill_stress"][
            "state_dependent_fill_before_move_preview"
        ]
    )
    test_case.assertTrue(
        row_payload["queue_survival_fill_stress"]["maker_fill_return_tradeoff_preview"]
    )
    test_case.assertIn("feed_lag_liquidity_stress", row_payload)
    test_case.assertFalse(row_payload["feed_lag_liquidity_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["feed_lag_liquidity_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["feed_lag_liquidity_stress"]["status"],
        "preview_only_feed_lag_liquidity_stress_ranking",
    )
    test_case.assertIn(
        "ssrn-6675338",
        {
            source["source_id"]
            for source in row_payload["feed_lag_liquidity_stress"]["source_papers"]
        },
    )
    test_case.assertIn("lob_reality_gap_stress", row_payload)
    test_case.assertFalse(row_payload["lob_reality_gap_stress"]["proof_authority"])
    test_case.assertFalse(row_payload["lob_reality_gap_stress"]["promotion_authority"])
    test_case.assertEqual(
        row_payload["lob_reality_gap_stress"]["status"],
        "preview_only_lob_reality_gap_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2603.24137",
        {
            source["source_id"]
            for source in row_payload["lob_reality_gap_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "arxiv-2502.07071",
        {
            source["source_id"]
            for source in row_payload["lob_reality_gap_stress"]["source_papers"]
        },
    )
    test_case.assertTrue(
        row_payload["lob_reality_gap_stress"]["responsive_exchange_simulation_preview"]
    )
    test_case.assertIn("alpha_decay_predictability_stress", row_payload)
    test_case.assertFalse(
        row_payload["alpha_decay_predictability_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["alpha_decay_predictability_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["alpha_decay_predictability_stress"]["status"],
        "preview_only_alpha_decay_predictability_ranking",
    )
    test_case.assertIn(
        "arxiv-2601.02310",
        {
            source["source_id"]
            for source in row_payload["alpha_decay_predictability_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "alpha_decay_predictability_arxiv_2601_02310_2026",
        row_payload["alpha_decay_predictability_stress"]["source_markers"],
    )
    test_case.assertIn(
        "short_run_market_efficiency_ssrn_6608199_2026",
        row_payload["alpha_decay_predictability_stress"]["source_markers"],
    )
    test_case.assertIn("counterfactual_regime_replay_stress", row_payload)
    test_case.assertFalse(
        row_payload["counterfactual_regime_replay_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["counterfactual_regime_replay_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["counterfactual_regime_replay_stress"]["status"],
        "preview_only_counterfactual_regime_replay_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2602.03776",
        {
            source["source_id"]
            for source in row_payload["counterfactual_regime_replay_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn("nonlinear_impact_execution_stress", row_payload)
    test_case.assertFalse(
        row_payload["nonlinear_impact_execution_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["nonlinear_impact_execution_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["nonlinear_impact_execution_stress"]["status"],
        "preview_only_nonlinear_impact_execution_stress_ranking",
    )
    nonlinear_impact_source_ids = {
        source["source_id"]
        for source in row_payload["nonlinear_impact_execution_stress"]["source_papers"]
    }
    test_case.assertIn("arxiv-2603.29086", nonlinear_impact_source_ids)
    test_case.assertIn("arxiv-2510.19950", nonlinear_impact_source_ids)
    test_case.assertIn(
        "elliptic_uncertainty_worst_case_cost_bps",
        row_payload["nonlinear_impact_execution_stress"]["ranking_features"],
    )
    test_case.assertTrue(
        row_payload["nonlinear_impact_execution_stress"][
            "directional_elliptic_uncertainty_preview"
        ]
    )
    test_case.assertIn("option_gamma_flow_stress", row_payload)
    test_case.assertFalse(row_payload["option_gamma_flow_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["option_gamma_flow_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["option_gamma_flow_stress"]["status"],
        "preview_only_option_gamma_flow_stress_ranking",
    )
    test_case.assertIn(
        "ssrn-4692190",
        {
            source["source_id"]
            for source in row_payload["option_gamma_flow_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "option_gamma_flow_stress_penalty_active", row_payload["risk_flags"]
    )
    test_case.assertIn(
        "option_gamma_flow_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("intraday_jump_burst_stress", row_payload)
    test_case.assertFalse(row_payload["intraday_jump_burst_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["intraday_jump_burst_stress"]["promotion_authority"]
    )
    test_case.assertEqual(
        row_payload["intraday_jump_burst_stress"]["status"],
        "preview_only_intraday_jump_burst_stress_ranking",
    )
    test_case.assertIn(
        "ssrn-5223127",
        {
            source["source_id"]
            for source in row_payload["intraday_jump_burst_stress"]["source_papers"]
        },
    )
    test_case.assertIn("rough_flow_volatility_stress", row_payload)
    test_case.assertEqual(
        row_payload["rough_flow_volatility_stress"]["status"],
        "preview_only_rough_flow_volatility_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2601.23172",
        {
            source["source_id"]
            for source in row_payload["rough_flow_volatility_stress"]["source_papers"]
        },
    )
    test_case.assertFalse(
        row_payload["rough_flow_volatility_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["rough_flow_volatility_stress"]["promotion_authority"]
    )
    test_case.assertIn("institutional_mechanism_fidelity_stress", row_payload)
    test_case.assertEqual(
        row_payload["institutional_mechanism_fidelity_stress"]["status"],
        "preview_only_institutional_mechanism_fidelity_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2604.18046",
        {
            source["source_id"]
            for source in row_payload["institutional_mechanism_fidelity_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["institutional_mechanism_fidelity_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["institutional_mechanism_fidelity_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "institutional_mechanism_fidelity_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "institutional_mechanism_fidelity_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("signal_adaptive_execution_resilience_stress", row_payload)
    test_case.assertEqual(
        row_payload["signal_adaptive_execution_resilience_stress"]["status"],
        "preview_only_signal_adaptive_execution_resilience_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2605.24242",
        {
            source["source_id"]
            for source in row_payload["signal_adaptive_execution_resilience_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["signal_adaptive_execution_resilience_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["signal_adaptive_execution_resilience_stress"][
            "promotion_authority"
        ]
    )
    test_case.assertIn(
        "signal_adaptive_execution_resilience_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "signal_adaptive_execution_resilience_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("stochastic_liquidity_resilience_stress", row_payload)
    test_case.assertEqual(
        row_payload["stochastic_liquidity_resilience_stress"]["status"],
        "preview_only_stochastic_liquidity_resilience_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2506.11813",
        {
            source["source_id"]
            for source in row_payload["stochastic_liquidity_resilience_stress"][
                "source_papers"
            ]
        },
    )
