from __future__ import annotations

from typing import Any


def assert_fast_replay_preview_lineage_payloads(
    test_case: Any,
    payload: dict[str, Any],
    row_payload: dict[str, Any],
    stress_payload: dict[str, Any],
    source_query_digest: str,
) -> None:
    test_case.assertIn(
        "ssrn-3798235",
        {
            source["source_id"]
            for source in row_payload["stochastic_liquidity_resilience_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "optimal_execution_liquidity_uncertainty_arxiv_2506_11813_2025",
        row_payload["stochastic_liquidity_resilience_stress"]["source_markers"],
    )
    test_case.assertIn(
        "stochastic_market_depth_ssrn_3798235_2025",
        row_payload["stochastic_liquidity_resilience_stress"]["source_markers"],
    )
    test_case.assertFalse(
        row_payload["stochastic_liquidity_resilience_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["stochastic_liquidity_resilience_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "stochastic_liquidity_resilience_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "stochastic_liquidity_resilience_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("microstructure_regime_tokenization_stress", row_payload)
    test_case.assertEqual(
        row_payload["microstructure_regime_tokenization_stress"]["status"],
        "preview_only_microstructure_regime_tokenization_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2604.20949",
        {
            source["source_id"]
            for source in row_payload["microstructure_regime_tokenization_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "arxiv-2602.23784",
        {
            source["source_id"]
            for source in row_payload["microstructure_regime_tokenization_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["microstructure_regime_tokenization_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["microstructure_regime_tokenization_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "microstructure_regime_tokenization_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "microstructure_regime_tokenization_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("cost_aware_forecast_filter_stress", row_payload)
    test_case.assertEqual(
        row_payload["cost_aware_forecast_filter_stress"]["status"],
        "preview_only_cost_aware_forecast_filter_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2606.00060",
        {
            source["source_id"]
            for source in row_payload["cost_aware_forecast_filter_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "arxiv-2512.12727",
        {
            source["source_id"]
            for source in row_payload["cost_aware_forecast_filter_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["cost_aware_forecast_filter_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["cost_aware_forecast_filter_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "cost_aware_forecast_filter_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "cost_aware_forecast_filter_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("adaptive_market_limit_allocation_stress", row_payload)
    test_case.assertEqual(
        row_payload["adaptive_market_limit_allocation_stress"]["status"],
        "preview_only_adaptive_market_limit_allocation_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2507.06345",
        {
            source["source_id"]
            for source in row_payload["adaptive_market_limit_allocation_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "arxiv-2603.29086",
        {
            source["source_id"]
            for source in row_payload["adaptive_market_limit_allocation_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "arxiv-2605.24242",
        {
            source["source_id"]
            for source in row_payload["adaptive_market_limit_allocation_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["adaptive_market_limit_allocation_stress"]["proof_authority"]
    )
    test_case.assertIn(
        "terminal_inventory_penalty_bps",
        row_payload["adaptive_market_limit_allocation_stress"]["ranking_features"],
    )
    test_case.assertFalse(
        row_payload["adaptive_market_limit_allocation_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "adaptive_market_limit_allocation_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "adaptive_market_limit_allocation_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("metaorder_adverse_selection_stress", row_payload)
    test_case.assertEqual(
        row_payload["metaorder_adverse_selection_stress"]["status"],
        "preview_only_metaorder_adverse_selection_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2510.27334",
        {
            source["source_id"]
            for source in row_payload["metaorder_adverse_selection_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "doi-10.1007/s10203-026-00570-z",
        {
            source["source_id"]
            for source in row_payload["metaorder_adverse_selection_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["metaorder_adverse_selection_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["metaorder_adverse_selection_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "metaorder_adverse_selection_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "metaorder_adverse_selection_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("hawkes_transient_impact_stress", row_payload)
    test_case.assertEqual(
        row_payload["hawkes_transient_impact_stress"]["status"],
        "preview_only_hawkes_transient_impact_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2504.10282",
        {
            source["source_id"]
            for source in row_payload["hawkes_transient_impact_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "state_dependent_hawkes_arxiv_2604_23961_2026",
        row_payload["hawkes_transient_impact_stress"]["source_markers"],
    )
    test_case.assertFalse(
        row_payload["hawkes_transient_impact_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["hawkes_transient_impact_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "hawkes_transient_impact_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "hawkes_transient_impact_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("ofi_response_horizon_stress", row_payload)
    test_case.assertEqual(
        row_payload["ofi_response_horizon_stress"]["status"],
        "preview_only_ofi_response_horizon_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2505.17388",
        {
            source["source_id"]
            for source in row_payload["ofi_response_horizon_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "arxiv-2508.06788",
        {
            source["source_id"]
            for source in row_payload["ofi_response_horizon_stress"]["source_papers"]
        },
    )
    test_case.assertIn(
        "ofi_response_horizon_arxiv_2505_17388_2025",
        row_payload["ofi_response_horizon_stress"]["source_markers"],
    )
    test_case.assertIn(
        "intraday_ofi_macro_news_arxiv_2508_06788_2025",
        row_payload["ofi_response_horizon_stress"]["source_markers"],
    )
    test_case.assertFalse(row_payload["ofi_response_horizon_stress"]["proof_authority"])
    test_case.assertFalse(
        row_payload["ofi_response_horizon_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "ofi_response_horizon_stress_penalty_active",
        stress_payload["risk_flags"],
    )
    test_case.assertIn(
        "ofi_response_horizon_stress_downranks_only",
        stress_payload["ranking_only_reasons"],
    )
    test_case.assertIn("bootstrap_robust_optimization_stress", row_payload)
    test_case.assertEqual(
        row_payload["bootstrap_robust_optimization_stress"]["status"],
        "preview_only_bootstrap_robust_optimization_stress_ranking",
    )
    test_case.assertIn(
        "arxiv-2510.12725",
        {
            source["source_id"]
            for source in row_payload["bootstrap_robust_optimization_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertIn(
        "spurious_predictability_arxiv_2604_15531_2026",
        row_payload["bootstrap_robust_optimization_stress"]["source_markers"],
    )
    test_case.assertFalse(
        row_payload["bootstrap_robust_optimization_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["bootstrap_robust_optimization_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "bootstrap_robust_optimization_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "bootstrap_robust_optimization_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("adaptive_signal_falsification_stress", row_payload)
    adaptive_falsification_payload = row_payload["adaptive_signal_falsification_stress"]
    test_case.assertEqual(
        adaptive_falsification_payload["status"],
        "research_only_adaptive_signal_falsification_evidence_collection",
    )
    test_case.assertIn(
        "spurious_predictability_arxiv_2604_15531_2026",
        adaptive_falsification_payload["source_markers"],
    )
    test_case.assertIn(
        "adaptive_factor_to_execution_alphacrafter_arxiv_2605_05580_2026",
        adaptive_falsification_payload["source_markers"],
    )
    test_case.assertEqual(adaptive_falsification_payload["null_model_sample_count"], 0)
    test_case.assertFalse(
        adaptive_falsification_payload["adaptive_signal_falsification_passed"]
    )
    test_case.assertFalse(adaptive_falsification_payload["proof_authority"])
    test_case.assertFalse(adaptive_falsification_payload["promotion_authority"])
    test_case.assertFalse(adaptive_falsification_payload["promotion_allowed"])
    test_case.assertFalse(adaptive_falsification_payload["final_authority_ok"])
    test_case.assertTrue(
        adaptive_falsification_payload["objective_scorecard_patch"][
            "required_adaptive_signal_falsification"
        ]
    )
    test_case.assertFalse(
        adaptive_falsification_payload["objective_scorecard_patch"][
            "adaptive_signal_falsification_passed"
        ]
    )
    test_case.assertIn(
        "null_model_sample_count_below_min",
        adaptive_falsification_payload["warnings"],
    )
    test_case.assertIn(
        "leakage_probe_missing_or_failed",
        adaptive_falsification_payload["warnings"],
    )
    test_case.assertIn(
        "adaptive_signal_falsification_incomplete_or_failed",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "adaptive_signal_falsification_evidence_collection_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn(
        "adaptive_signal_falsification_incomplete_blocks_promotion",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn(
        "adaptive_signal_falsification_incomplete_or_failed",
        row_payload["risk_veto_reasons"],
    )
    test_case.assertIn(
        "intraday_jump_burst_stress_penalty_active",
        stress_payload["risk_flags"],
    )
    test_case.assertIn(
        "intraday_jump_burst_stress_downranks_only",
        stress_payload["ranking_only_reasons"],
    )
    test_case.assertIn("intraday_price_path_asymmetry_stress", row_payload)
    test_case.assertEqual(
        row_payload["intraday_price_path_asymmetry_stress"]["status"],
        "preview_only_intraday_price_path_asymmetry_stress_ranking",
    )
    test_case.assertIn(
        "ssrn-6074846",
        {
            source["source_id"]
            for source in row_payload["intraday_price_path_asymmetry_stress"][
                "source_papers"
            ]
        },
    )
    test_case.assertFalse(
        row_payload["intraday_price_path_asymmetry_stress"]["proof_authority"]
    )
    test_case.assertFalse(
        row_payload["intraday_price_path_asymmetry_stress"]["promotion_authority"]
    )
    test_case.assertIn(
        "intraday_price_path_asymmetry_stress_penalty_active",
        row_payload["risk_flags"],
    )
    test_case.assertIn(
        "intraday_price_path_asymmetry_stress_downranks_only",
        row_payload["ranking_only_reasons"],
    )
    test_case.assertIn("cost_impact_lineage", row_payload)
    test_case.assertIn("impact_capacity_lineage", row_payload)
    test_case.assertEqual(
        row_payload["cost_impact_lineage"]["impact_model"],
        "square_root_power_law_capacity_proxy",
    )
    test_case.assertEqual(
        row_payload["impact_capacity_lineage"]["model"],
        "square_root_power_law_impact_proxy",
    )
    test_case.assertIn("hpairs_macro_window_stress", row_payload)
    test_case.assertFalse(row_payload["hpairs_macro_window_stress"]["proof_authority"])
    test_case.assertIn("hpairs_clusterlob_order_flow_feature_lane", row_payload)
    feature_lane = row_payload["hpairs_clusterlob_order_flow_feature_lane"]
    test_case.assertEqual(feature_lane["status"], "preview_only_research_ranking")
    test_case.assertEqual(
        feature_lane["resource_scope"],
        "local_offline_replay_tape_or_fixture_rows_only",
    )
    test_case.assertFalse(feature_lane["promotion_allowed"])
    test_case.assertFalse(feature_lane["promotion_authority"])
    test_case.assertFalse(feature_lane["final_authority_ok"])
    test_case.assertIn("feature_schema_hashes", feature_lane)
    test_case.assertIn(
        "hawkes_time_rescaling_ks_proxy",
        feature_lane["ranking_features"],
    )
    test_case.assertIn(
        "event_taxonomy_coverage_ratio",
        feature_lane["ranking_features"],
    )
    test_case.assertIn(
        "hpairs_clusterlob_order_flow_feature_lane",
        payload,
    )
    manifest_lane = payload["hpairs_clusterlob_order_flow_feature_lane"]
    test_case.assertEqual(manifest_lane["status"], "preview_only_research_ranking")
    test_case.assertFalse(manifest_lane["promotion_allowed"])
    test_case.assertFalse(manifest_lane["final_authority_ok"])
    test_case.assertEqual(
        row_payload["adv_capacity_context"]["status"], "missing_source_backed_adv"
    )
    test_case.assertIn("source_backed_adv_missing", row_payload["lineage_blockers"])
    test_case.assertFalse(row_payload["promotion_proof"])
    test_case.assertFalse(row_payload["proof_authority"])
    test_case.assertIn("risk_flags", row_payload)
    test_case.assertIn("source_backed_adv_missing", row_payload["risk_flags"])
    test_case.assertEqual(
        payload["replay_tape"]["dataset_snapshot_ref"], "snapshot-fast"
    )
    test_case.assertEqual(
        payload["replay_tape"]["source_query_digest"], source_query_digest
    )
    test_case.assertEqual(
        payload["replay_tape"]["source_table_versions"], {"signals": "v1"}
    )
    test_case.assertIn("feature_schema_hash", payload["replay_tape"])
    test_case.assertIn("cost_model_hash", payload["replay_tape"])
    test_case.assertIn("strategy_family", payload["replay_tape"])
    test_case.assertEqual(
        payload["replay_tape"]["cache_identity"]["status"], "complete"
    )
    test_case.assertEqual(payload["replay_tape"]["feature_schema_hash"], "feature-fast")
    test_case.assertEqual(payload["replay_tape"]["cost_model_hash"], "cost-fast")
    test_case.assertEqual(payload["replay_tape"]["strategy_family"], "hpairs-fast")
    test_case.assertFalse(payload["proof_authority"])
    test_case.assertEqual(
        row_payload["candidate_lineage"]["hypothesis_id"], "hyp-spec-good"
    )
    test_case.assertEqual(
        row_payload["candidate_lineage"]["family_template_id"],
        "microbar_cross_sectional_pairs_v1",
    )
    test_case.assertTrue(row_payload["candidate_lineage"]["lineage_preserved"])
    test_case.assertFalse(row_payload["candidate_lineage"]["final_authority_ok"])
    test_case.assertEqual(
        row_payload["frontier_selection"]["reason_code"],
        "fast_replay_frontier_exploitation_selected",
    )
    test_case.assertEqual(
        row_payload["discovery_stage_metadata"]["preview_status"],
        "preview_only_ranked",
    )
    test_case.assertTrue(
        row_payload["discovery_stage_metadata"]["exact_replay_qualified"]
    )
    test_case.assertEqual(
        row_payload["discovery_stage_metadata"]["evidence_collection_status"],
        "bounded_sim_evidence_collection_candidate",
    )
    test_case.assertFalse(row_payload["discovery_stage_metadata"]["promotion_allowed"])
    test_case.assertFalse(
        row_payload["frontier_selection"]["discovery_stage_metadata"][
            "final_promotion_allowed"
        ]
    )
    test_case.assertFalse(row_payload["frontier_selection"]["promotion_allowed"])
    test_case.assertEqual(
        payload["discovery_stage_semantics"]["authority"],
        "candidate_discovery_only",
    )
    test_case.assertFalse(
        payload["discovery_stage_semantics"][
            "exact_replay_frontier_can_authorize_promotion"
        ]
    )
    sim_queue = payload["bounded_sim_target_queue"]
    test_case.assertEqual(sim_queue["status"], "metadata_only_not_dispatched")
    test_case.assertEqual(
        sim_queue["discovery_stage_semantics"]["preview_only_status"],
        "preview_only_ranked",
    )
    test_case.assertEqual(
        sim_queue["selected_candidate_spec_ids"], ["spec-good", "spec-stress"]
    )
    test_case.assertFalse(sim_queue["kubernetes_fanout_allowed"])
    test_case.assertFalse(sim_queue["db_writes_allowed"])
    test_case.assertFalse(sim_queue["proof_packet_upload_allowed"])
    test_case.assertFalse(sim_queue["final_authority_ok"])
