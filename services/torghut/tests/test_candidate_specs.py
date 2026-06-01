from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.strategies.catalog import StrategyCatalogConfig
import app.trading.discovery.candidate_specs as candidate_specs_module
from app.trading.discovery.candidate_specs import (
    candidate_spec_from_payload,
    compile_candidate_specs,
)
from app.trading.discovery.factor_acceptance import build_factor_acceptance_artifact
from app.trading.discovery.factor_acceptance import (
    build_factor_acceptance_artifact_from_scorecard,
)
from app.trading.discovery.hypothesis_cards import (
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    build_hypothesis_cards,
)
from app.trading.discovery.mlx_training_data import candidate_spec_capital_features
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_whitepaper_candidate_specs,
)
from app.trading.semiconductor_universe import RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE


_CHIP_UNIVERSE_SYMBOLS = set(RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)


def _capital_profile(spec: candidate_specs_module.CandidateSpec) -> object:
    params = spec.strategy_overrides.get("params")
    return params.get("capital_profile") if isinstance(params, dict) else None


class TestCandidateSpecs(TestCase):
    def test_factor_acceptance_artifact_accepts_rankic_cost_stressed_factor(
        self,
    ) -> None:
        artifact = build_factor_acceptance_artifact(
            factor_expression="cross_section_recent_15m_return_rank",
            source_idea="nvidia_signal_discovery_rankic_acceptance",
            allowed_feature_dependencies=[
                "cross_section_recent_15m_return_rank",
                "spread_bps",
            ],
            train_window={"start": "2026-01-02", "end": "2026-03-31"},
            test_window={"start": "2026-04-01", "end": "2026-04-30"},
            sample_count=144,
            candidate_count=4,
            rank_ic=Decimal("0.061"),
            rank_ir=Decimal("0.71"),
            p_value=Decimal("0.006"),
            gross_expectancy_bps=Decimal("5.2"),
            cost_stress_bps=Decimal("1.8"),
        )

        self.assertEqual(artifact["status"], "accepted")
        self.assertEqual(artifact["rejection_reasons"], [])
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "3.4")
        self.assertTrue(artifact["does_not_authorize_live_promotion"])
        self.assertEqual(
            artifact["lineage_hash"],
            build_factor_acceptance_artifact(
                factor_expression="cross_section_recent_15m_return_rank",
                source_idea="nvidia_signal_discovery_rankic_acceptance",
                allowed_feature_dependencies=[
                    "cross_section_recent_15m_return_rank",
                    "spread_bps",
                ],
                train_window={"start": "2026-01-02", "end": "2026-03-31"},
                test_window={"start": "2026-04-01", "end": "2026-04-30"},
                sample_count=144,
                candidate_count=4,
                rank_ic=Decimal("0.061"),
                rank_ir=Decimal("0.71"),
                p_value=Decimal("0.006"),
                gross_expectancy_bps=Decimal("5.2"),
                cost_stress_bps=Decimal("1.8"),
            )["lineage_hash"],
        )

    def test_factor_acceptance_artifact_rejects_missing_features_low_ic_and_cost(
        self,
    ) -> None:
        artifact = build_factor_acceptance_artifact(
            factor_expression="unavailable_alt_data_factor",
            source_idea="rankic_factor_acceptance_negative_case",
            allowed_feature_dependencies=[
                "unavailable_alt_data_factor",
                "cross_section_recent_15m_return_rank",
            ],
            sample_count=12,
            candidate_count=8,
            rank_ic=Decimal("0.01"),
            rank_ir=Decimal("0.10"),
            p_value=Decimal("0.02"),
            gross_expectancy_bps=Decimal("1.0"),
            cost_stress_bps=Decimal("1.5"),
        )

        self.assertEqual(artifact["status"], "rejected")
        self.assertIn("feature_dependency_missing", artifact["rejection_reasons"])
        self.assertIn("sample_count_below_floor", artifact["rejection_reasons"])
        self.assertIn("rank_ic_below_floor", artifact["rejection_reasons"])
        self.assertIn("rank_ir_below_floor", artifact["rejection_reasons"])
        self.assertIn("deflated_p_value_above_floor", artifact["rejection_reasons"])
        self.assertIn(
            "cost_stressed_expectancy_non_positive",
            artifact["rejection_reasons"],
        )

    def test_factor_acceptance_artifact_from_scorecard_uses_replay_metrics(
        self,
    ) -> None:
        artifact = build_factor_acceptance_artifact_from_scorecard(
            factor_expression="cross_section_session_open_rank",
            source_idea="runtime_replay_rankic_factor_acceptance",
            allowed_feature_dependencies=[
                "cross_section_session_open_rank",
                "spread_bps",
            ],
            scorecard={
                "rank_ic": "0.061",
                "rank_ir": "0.71",
                "p_value": "0.006",
                "factor_candidate_count": 4,
                "decision_count": 144,
                "net_pnl_per_day": "34",
                "avg_filled_notional_per_day": "100000",
                "market_impact_stress_cost_bps": "1.8",
                "train_window": {"start": "2026-01-02", "end": "2026-03-31"},
                "holdout_window": {"start": "2026-04-01", "end": "2026-04-30"},
            },
            candidate_spec_id="spec-rankic",
            candidate_id="candidate-rankic",
            evidence_bundle_id="ev-rankic",
        )

        self.assertEqual(artifact["status"], "accepted")
        self.assertEqual(artifact["sample_count"], 144)
        self.assertEqual(artifact["candidate_count"], 4)
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "1.60000")
        self.assertEqual(
            artifact["evidence_metadata"]["source"],
            "replay_or_live_paper_scorecard",
        )
        self.assertEqual(artifact["promotion_scope"], "research_paper_probation_only")
        self.assertTrue(artifact["does_not_authorize_live_promotion"])

    def test_rankic_signal_discovery_claim_adds_fail_closed_factor_harness(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-nvidia-signal-discovery",
            claims=[
                {
                    "claim_id": "rankic-factor-mining",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "NVIDIA quantitative signal discovery and FactorMiner style "
                        "factor mining require RankIC, RankIR, p-value and cost "
                        "stress acceptance before alpha factors enter paper routing."
                    ),
                    "data_requirements": [
                        "cross_section_recent_15m_return_rank",
                        "spread_bps",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]
        artifact = first.feature_contract["factor_acceptance_artifact"]

        self.assertIn(
            "rankic_factor_acceptance_harness",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(artifact["status"], "rejected")
        self.assertIn("rank_ic_below_floor", artifact["rejection_reasons"])
        self.assertTrue(first.hard_vetoes["required_factor_acceptance_artifact"])
        self.assertEqual(
            first.hard_vetoes["required_factor_acceptance_status"],
            "accepted",
        )
        self.assertTrue(
            first.promotion_contract[
                "rejects_llm_generated_factor_without_deterministic_acceptance"
            ]
        )
        self.assertTrue(
            first.promotion_contract[
                "rejects_factor_acceptance_as_live_promotion_proof"
            ]
        )

    def test_profile_rank_floor_handles_invalid_params_and_universe_fallbacks(
        self,
    ) -> None:
        self.assertEqual(
            candidate_specs_module._profile_rank_count_floor(
                {
                    "params": {"rank_count": "not-a-decimal"},
                    "universe_symbols": "NVDA",
                }
            ),
            1,
        )
        self.assertEqual(
            candidate_specs_module._profile_rank_count_floor(
                {"params": {}, "universe_symbols": ["NVDA", "", "AMD"]}
            ),
            2,
        )

        fallback = candidate_specs_module._strategy_overrides_for_profile(
            family_template_id="unknown-family",
            profile_index=0,
            target_net_pnl_per_day=Decimal("500"),
        )

        self.assertEqual(fallback["max_notional_per_trade"], "50000")
        self.assertEqual(
            fallback["params"],
            {"position_isolation_mode": "per_strategy"},
        )

    def test_default_execution_profiles_use_chip_only_universes(self) -> None:
        seen_profiles = 0
        execution_profiles = candidate_specs_module._FAMILY_EXECUTION_PROFILES
        for family, profiles in execution_profiles.items():
            for index, profile in enumerate(profiles):
                raw_symbols = profile.get("universe_symbols")
                self.assertIsInstance(
                    raw_symbols,
                    list,
                    f"{family} profile {index} missing universe_symbols",
                )
                symbols = [str(symbol).strip().upper() for symbol in raw_symbols]
                self.assertLessEqual(
                    len(symbols),
                    12,
                    f"{family} profile {index} has too many symbols",
                )
                self.assertEqual(
                    len(symbols),
                    len(set(symbols)),
                    f"{family} profile {index} has duplicate symbols",
                )
                self.assertEqual(
                    sorted(set(symbols) - _CHIP_UNIVERSE_SYMBOLS),
                    [],
                    f"{family} profile {index} contains symbols outside the researched chip/AI infrastructure universe",
                )
                seen_profiles += 1

        self.assertGreater(seen_profiles, 0)

    def test_candidate_spec_ids_are_deterministic_and_round_trip(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-1",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        first = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )
        second = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertEqual(first[0].candidate_spec_id, second[0].candidate_spec_id)
        self.assertEqual(first[0].objective["target_net_pnl_per_day"], "300")
        self.assertIn("required_max_drawdown", first[0].hard_vetoes)
        self.assertIn("params", first[0].strategy_overrides)
        self.assertIn("execution_profile", first[0].feature_contract)
        self.assertIn("execution_profile_id", first[0].parameter_space)
        if first[0].family_template_id == "microbar_cross_sectional_pairs_v1":
            params = first[0].strategy_overrides["params"]
            self.assertIn("long_stop_loss_bps", params)
            self.assertIn("long_trailing_stop_drawdown_bps", params)
            self.assertIn("max_session_negative_exit_bps", params)
        self.assertEqual(
            first[0].strategy_overrides["params"]["position_isolation_mode"],
            "per_strategy",
        )
        self.assertNotIn("live_runtime_config_path", first[0].to_payload())
        reloaded = candidate_spec_from_payload(first[0].to_payload())
        self.assertEqual(reloaded.candidate_spec_id, first[0].candidate_spec_id)

    def test_structured_source_claims_survive_candidate_spec_payload(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-structured-claims",
            claims=[
                {
                    "claim_id": "claim-structured-flow",
                    "claim_type": "feature_recipe",
                    "claim_text": "Order flow imbalance requires route/TCA aware feature contracts.",
                    "data_requirements": ["order_flow_imbalance", "route_tca"],
                    "asset_scope": "us_equities_intraday",
                    "horizon_scope": "intraday_microstructure",
                    "expected_direction": "neutral",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        source_claims = specs[0].feature_contract["source_claims"]
        self.assertEqual(source_claims[0]["claim_id"], "claim-structured-flow")
        self.assertEqual(source_claims[0]["claim_type"], "feature_recipe")
        self.assertIn("route_tca", source_claims[0]["data_requirements"])
        self.assertEqual(
            specs[0].to_vnext_experiment_payload()["candidate_spec"][
                "feature_contract"
            ]["source_claims"][0]["horizon_scope"],
            "intraday_microstructure",
        )

    def test_cluster_lob_claim_adds_event_clustering_overlay_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-clusterlob",
            claims=[
                {
                    "claim_id": "clusterlob-clustered-ofi-alpha",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "ClusterLOB clustered order events and order-flow imbalance "
                        "improve short-horizon LOB signals."
                    ),
                    "data_requirements": [
                        "clustered_order_events",
                        "order_flow_imbalance",
                        "spread_bps",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "cluster_lob_event_clustering",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            "ofi_lob_continuation_response",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_event_cluster_stability_score"],
            "0.60",
        )
        self.assertTrue(specs[0].promotion_contract["requires_lob_event_stream_parity"])

    def test_nonlinear_market_impact_claim_adds_route_tca_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-realistic-impact",
            claims=[
                {
                    "claim_id": "nonlinear-market-impact",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Nonlinear market impact and square-root impact curves change "
                        "strategy ranking under route/TCA stress."
                    ),
                    "data_requirements": [
                        "route_tca",
                        "turnover",
                        "nonlinear_impact_curve",
                        "market_impact_stress",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertEqual(
            specs[0].family_template_id,
            "microstructure_continuation_matched_filter_v1",
        )
        self.assertNotEqual(specs[0].family_template_id, "mean_reversion_rebound_v1")
        self.assertIn(
            "nonlinear_market_impact_tca",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_impact_stress_model"],
            "square_root_or_power_law",
        )
        self.assertEqual(
            specs[0].promotion_contract["ranking_cost_model"],
            "post_cost_nonlinear_impact",
        )

    def test_lob_simulation_reality_gap_claim_adds_implementation_risk_overlay(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-lob-simulation-reality-gap",
            claims=[
                {
                    "claim_id": "lob-simulation-benchmark-parity",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Limit order book simulation can expose stylized fillability "
                        "and adverse-selection mechanisms only when calibrated against "
                        "real LOB event streams and fill outcomes."
                    ),
                    "data_requirements": [
                        "lob_event_stream",
                        "fill_outcomes",
                        "simulation_parity",
                    ],
                    "confidence": "0.82",
                },
                {
                    "claim_id": "sim-to-live-reality-gap-validation",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "Simulation reality gaps require explicit live-paper parity "
                        "metrics before simulated fillability can affect capital gates."
                    ),
                    "data_requirements": [
                        "simulation_parity",
                        "live_paper_parity",
                        "adverse_selection_stress",
                        "route_tca",
                    ],
                    "confidence": "0.80",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "simulation_reality_gap_implementation_risk",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_simulation_live_parity_metrics"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_simulation_parity_sample_count"],
            "120",
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_synthetic_lob_fillability_as_capital_gate"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_implementation_uncertainty_stability"]
        )

    def test_implementation_risk_claim_adds_backtest_stability_overlay(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-implementation-risk-backtesting",
            claims=[
                {
                    "claim_id": "implementation-risk-engine-sensitivity",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Implementation risk in portfolio backtesting creates engine "
                        "sensitivity and implementation uncertainty intervals under "
                        "nonzero transaction costs."
                    ),
                    "data_requirements": [
                        "multi_engine_replay",
                        "engine_sensitivity",
                        "implementation_uncertainty_interval",
                        "conclusion_stability",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.80",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "implementation_risk_backtest_stability",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_multi_engine_replay"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_implementation_uncertainty_model_count"],
            "2",
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_single_engine_backtest_proof"]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "requires_implementation_risk_backtest_stability"
            ]
        )

    def test_deployment_consistency_claim_adds_semantic_parity_overlay(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-finrl-x-deployment-consistency",
            claims=[
                {
                    "claim_id": "weight-centric-unified-execution-protocol",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "FinRL-X uses a deployment-consistent weight-centric "
                        "protocol so data processing, strategy construction, "
                        "backtesting, and broker execution keep downstream "
                        "execution semantics unchanged."
                    ),
                    "data_requirements": [
                        "portfolio_weight_trace",
                        "signal_payload_parity",
                        "order_sizing_parity",
                        "broker_execution_semantics",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "replay-paper-live-semantic-parity-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Replay paper live semantic parity requires identical "
                        "signal payloads, order sizing, route constraints, and "
                        "portfolio risk overlays before promotion."
                    ),
                    "data_requirements": [
                        "replay_paper_live_semantic_parity",
                        "signal_payload_parity",
                        "order_sizing_parity",
                        "route_constraint_parity",
                        "portfolio_risk_overlay_parity",
                        "live_paper_parity",
                    ],
                    "confidence": "0.78",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "replay_paper_live_semantic_parity",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_replay_paper_live_semantic_parity"]
        )
        self.assertTrue(specs[0].hard_vetoes["required_signal_payload_parity"])
        self.assertEqual(
            specs[0].hard_vetoes["required_adapter_behavior_drift_count"], "0"
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_adapter_only_execution_behavior"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_broker_execution_semantics"]
        )

    def test_market_limit_execution_claim_adds_candidate_local_policy(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-market-limit-execution",
            claims=[
                {
                    "claim_id": "mixed-market-limit-execution-policy",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Dynamic allocation between market and limit orders can improve "
                        "execution revenue when spread, limit fill probability, order type "
                        "ablation, price improvement, and opportunity cost are modeled."
                    ),
                    "data_requirements": [
                        "market_limit_order_mix",
                        "limit_fill_probability",
                        "execution_shortfall",
                        "order_type_ablation",
                        "opportunity_cost",
                        "price_improvement",
                    ],
                    "confidence": "0.74",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        params = specs[0].strategy_overrides["params"]
        self.assertEqual(params["entry_order_type"], "prefer_limit")
        self.assertEqual(params["market_order_spread_bps_max"], "6")
        self.assertIn(
            "mixed_market_limit_execution_policy",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_order_type_ablation_passed"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_order_type_ablation_sample_count"],
            "60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_price_improvement_evidence"])
        self.assertTrue(specs[0].hard_vetoes["required_opportunity_cost_evidence"])
        self.assertEqual(
            specs[0].hard_vetoes["required_max_order_type_opportunity_cost_bps"],
            "8",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_order_type_execution_quality"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_order_type_ablation"])
        self.assertTrue(specs[0].promotion_contract["requires_market_limit_order_mix"])

    def test_intraday_volume_forecast_claim_adds_periodicity_capacity_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-intraday-volume-forecast",
            claims=[
                {
                    "claim_id": "intraday-volume-periodicity",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "Intraday volume forecasting and VWAP execution need "
                        "u-shaped volume periodicity and clock-bucket capacity."
                    ),
                    "data_requirements": [
                        "intraday_volume_forecast",
                        "vwap",
                        "route_tca",
                    ],
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]

        self.assertIn(
            "intraday_volume_periodicity_execution",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertIn(
            first.family_template_id,
            {
                "opening_drive_leader_reclaim_v1",
                "late_day_continuation_v1",
                "intraday_tsmom_v2",
                "breakout_reclaim_v2",
            },
        )
        self.assertTrue(first.hard_vetoes["required_intraday_volume_forecast"])
        self.assertEqual(
            first.hard_vetoes["required_min_volume_periodicity_capacity_ratio"],
            "1.00",
        )
        self.assertTrue(first.promotion_contract["requires_clock_bucket_capacity"])
        self.assertTrue(
            first.promotion_contract["rejects_pooled_all_day_capacity_assumptions"]
        )

    def test_execution_delay_depth_claim_adds_delay_adjusted_stress_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-depth-delay",
            claims=[
                {
                    "claim_id": "execution-delay-depth-state",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Market depth and execution delay jointly determine "
                        "whether apparent liquidity is practically fillable."
                    ),
                    "data_requirements": [
                        "market_depth",
                        "execution_delay",
                        "latency_stress",
                        "limit_fill_probability",
                        "route_tca",
                    ],
                    "confidence": "0.81",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "delay_adjusted_depth_stress",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_delay_adjusted_depth_stress"])
        self.assertEqual(
            specs[0].hard_vetoes["required_max_route_latency_ms"],
            "250",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_delay_adjusted_depth_stress"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_no_delay_fill_assumptions"]
        )

    def test_queue_position_survival_claim_adds_fill_curve_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-kanformer-queue-survival",
            claims=[
                {
                    "claim_id": "kanformer-fill-survival",
                    "claim_type": "execution_assumption",
                    "claim_text": (
                        "KANFormer predicts limit order fill probabilities with "
                        "queue-position survival analysis and time-to-fill quantiles."
                    ),
                    "data_requirements": [
                        "queue_position",
                        "survival_fill_curve",
                        "time_to_fill_quantiles",
                        "nonfill_opportunity_cost",
                        "route_tca",
                    ],
                    "confidence": "0.80",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "queue_position_survival_fill_curve",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_queue_position_survival_fill_curve"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_queue_position_survival_sample_count"],
            "60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_time_to_fill_quantiles"])
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        queue_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "queue_position_survival_fill_curve"
        )
        self.assertEqual(
            queue_contract["rank_metric"],
            "post_cost_net_pnl_after_queue_position_survival_fill_stress",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_queue_position_survival_fill_curve"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_queue_position_free_fill_assumptions"]
        )

    def test_mpc_execution_claim_adds_dynamic_schedule_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-mpc-trade-execution",
            claims=[
                {
                    "claim_id": "dynamic-execution-schedule-control",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Model predictive control can adapt a dynamic execution "
                        "schedule to liquidity forecasts, inventory path, and "
                        "execution shortfall."
                    ),
                    "data_requirements": [
                        "execution_schedule_trace",
                        "liquidity_forecast",
                        "inventory_path",
                        "execution_shortfall",
                        "route_tca",
                    ],
                    "confidence": "0.71",
                },
                {
                    "claim_id": "mpc-execution-stress-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Dynamic execution schedules remain validation-only until "
                        "replay shows lower shortfall after latency and market-impact "
                        "stress."
                    ),
                    "data_requirements": [
                        "latency_stress",
                        "market_impact_stress",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.72",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "mpc_dynamic_execution_schedule",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_execution_schedule_trace"])
        self.assertTrue(
            specs[0].hard_vetoes["required_mpc_schedule_shortfall_ablation_passed"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_mpc_schedule_trace_sample_count"],
            "60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_latency_stress"])
        self.assertTrue(specs[0].hard_vetoes["required_market_impact_stress"])
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        mpc_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "mpc_dynamic_execution_schedule"
        )
        self.assertEqual(
            mpc_contract["rank_metric"],
            "post_cost_net_pnl_after_mpc_schedule_shortfall_stress",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_mpc_dynamic_execution_schedule"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_execution_shortfall"])
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_dynamic_schedule_without_shortfall_ablation"
            ]
        )
        self.assertEqual(
            specs[0].promotion_contract["execution_policy"],
            "mpc_dynamic_schedule_validation_only",
        )

    def test_friction_aware_regime_claim_adds_policy_overlay(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-frlux-regime-friction",
            claims=[
                {
                    "claim_id": "frlux-regime-conditioned-policy",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "FR-LUX friction-aware, regime-conditioned policy optimization "
                        "uses proportional and impact costs across volatility-liquidity regimes."
                    ),
                    "data_requirements": [
                        "regime_state",
                        "regime_conditioned_policy",
                        "proportional_cost_model",
                        "impact_cost_model",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "frlux-turnover-budget-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Trade-space trust region, turnover budget, cost misspecification stress, "
                        "scenario-level inference, and live-paper parity must validate the policy."
                    ),
                    "data_requirements": [
                        "trade_space_trust_region",
                        "turnover_budget",
                        "cost_misspecification_stress",
                        "scenario_level_inference",
                        "live_paper_parity",
                    ],
                    "confidence": "0.74",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]

        self.assertIn(
            "friction_aware_regime_conditioned_policy",
            first.parameter_space["mechanism_overlay_ids"],
        )
        params = first.strategy_overrides["params"]
        self.assertEqual(params["cost_model_profile"], "proportional_plus_impact")
        self.assertEqual(params["turnover_budget_profile"], "trade_space_trust_region")
        self.assertEqual(params["regime_conditioning_profile"], "volatility_liquidity")
        self.assertTrue(first.hard_vetoes["required_trade_space_trust_region"])
        self.assertTrue(first.hard_vetoes["required_cost_misspecification_stress"])
        self.assertTrue(first.promotion_contract["requires_turnover_budget"])
        self.assertTrue(
            first.promotion_contract["rejects_cost_blind_policy_optimization"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        friction_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "friction_aware_regime_conditioned_policy"
        )
        self.assertEqual(
            friction_contract["rank_metric"],
            "post_cost_net_pnl_after_regime_conditioned_friction_stress",
        )
        self.assertEqual(
            friction_contract["evidence_policy"],
            "friction_aware_regime_conditioned_policy_is_replay_ranking_not_promotion_proof",
        )

    def test_adaptive_factor_loop_claim_adds_validation_only_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-alphacrafter-factor-loop",
            claims=[
                {
                    "claim_id": "adaptive-factor-to-execution-loop",
                    "claim_type": "portfolio_construction",
                    "claim_text": (
                        "AlphaCrafter adaptive factor-to-execution loop combines continuous "
                        "factor mining, adaptive factor screener, and risk-constrained execution."
                    ),
                    "data_requirements": [
                        "continuous_factor_mining",
                        "factor_pool_expansion",
                        "adaptive_factor_screener",
                        "regime_adaptive_factor_ensemble",
                        "risk_constrained_execution",
                    ],
                    "confidence": "0.74",
                },
                {
                    "claim_id": "adaptive-loop-runtime-ledger-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Agentic factor discovery can rank replay candidates only; promotion "
                        "requires post-cost replay and runtime-ledger proof."
                    ),
                    "data_requirements": [
                        "portfolio_replay",
                        "walk_forward_replay",
                        "transaction_cost_stress",
                        "post_cost_net_pnl",
                        "runtime_ledger_profit_proof",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        first = specs[0]

        self.assertIn(
            "adaptive_factor_to_execution_loop",
            first.parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(first.hard_vetoes["required_adaptive_factor_to_execution_loop"])
        self.assertTrue(first.hard_vetoes["required_continuous_factor_mining"])
        self.assertTrue(first.hard_vetoes["required_adaptive_factor_screener"])
        self.assertTrue(first.hard_vetoes["required_risk_constrained_execution"])
        self.assertTrue(
            first.promotion_contract["rejects_agentic_search_only_promotion"]
        )
        self.assertTrue(
            first.promotion_contract["requires_runtime_ledger_profit_proof"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        factor_loop_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "adaptive_factor_to_execution_loop"
        )
        self.assertEqual(
            factor_loop_contract["rank_metric"],
            "adaptive_factor_loop_post_cost_net_pnl_per_day",
        )
        self.assertEqual(
            factor_loop_contract["evidence_policy"],
            "adaptive_factor_loop_is_search_prefilter_not_promotion_proof",
        )

    def test_alpha_decay_claim_adds_predictability_stress_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-tkan-alpha-decay",
            claims=[
                {
                    "claim_id": "lob-alpha-decay",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "T-KAN limit order book forecasting shows alpha decay as "
                        "predictability declines over longer horizons and under "
                        "spread-adjusted labels."
                    ),
                    "data_requirements": [
                        "horizon_decay_curve",
                        "spread_adjusted_labels",
                        "tight_spread_regime_slices",
                        "high_volume_regime_slices",
                        "route_tca",
                    ],
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "alpha_decay_predictability_stress",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_predictability_decay_stress"])
        self.assertTrue(specs[0].hard_vetoes["required_horizon_decay_curve"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_decay_stress_horizon_count"],
            "3",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_max_model_inference_latency_ms"],
            "200",
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        decay_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "alpha_decay_predictability_stress"
        )
        self.assertEqual(
            decay_contract["rank_metric"],
            "post_cost_net_pnl_after_predictability_decay_stress",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_predictability_decay_stress"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_single_horizon_lob_alpha_promotion"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_classification_accuracy_without_costs"]
        )

    def test_conformal_var_claim_adds_regime_weighted_cost_buffer_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-regime-weighted-conformal-var",
            claims=[
                {
                    "claim_id": "regime-weighted-conformal-var-buffer",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Regime-weighted conformal VaR calibrates a tail risk buffer "
                        "from regime-similarity weights and tail exceedance errors."
                    ),
                    "data_requirements": [
                        "regime_similarity_weights",
                        "conformal_tail_risk",
                        "regime_tail_exceedance",
                        "var_forecast_error",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "breakeven-cost-buffer-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Promotion requires a breakeven transaction cost buffer, "
                        "seed robustness, and model-family robustness."
                    ),
                    "data_requirements": [
                        "breakeven_transaction_cost_buffer",
                        "transaction_cost_buffer",
                        "transaction_cost_stress",
                        "post_cost_net_pnl",
                        "seed_robustness",
                        "model_family_robustness",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "regime_weighted_conformal_cost_buffer",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_conformal_tail_risk"])
        self.assertTrue(
            specs[0].hard_vetoes["required_regime_weighted_conformal_cost_buffer"]
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_conformal_tail_risk_sample_count"],
            "20",
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_breakeven_transaction_cost_buffer"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_conformal_var_cost_buffer"]
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_seed_model_family_robustness"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_unbuffered_tail_risk_promotion"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        conformal_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "regime_weighted_conformal_cost_buffer"
        )
        self.assertEqual(
            conformal_contract["rank_metric"],
            "conformal_tail_risk_adjusted_net_pnl_per_day",
        )
        self.assertEqual(
            conformal_contract["evidence_policy"],
            "regime_weighted_conformal_buffer_is_ranking_stress_not_promotion_proof",
        )

    def test_bootstrap_robust_optimization_claim_adds_stability_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-bootstrap-robust-optimization",
            claims=[
                {
                    "claim_id": "bootstrap-robust-optimization",
                    "claim_type": "strategy_mechanism",
                    "claim_text": (
                        "Non-parametric bootstrap robust optimization treats utility "
                        "as a random variable and uses percentile-based optimization "
                        "to reduce overfitting and selection bias."
                    ),
                    "data_requirements": [
                        "bootstrap_confidence_interval",
                        "utility_percentile",
                        "resampled_strategy_optimization",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "bootstrap-stability-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Validation requires parameter instability stress, model "
                        "misspecification stress, and out-of-sample generalization."
                    ),
                    "data_requirements": [
                        "parameter_instability_stress",
                        "selection_bias_stress",
                        "model_misspecification_stress",
                        "out_of_sample_generalization",
                    ],
                    "confidence": "0.78",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "bootstrap_robust_optimization_stability",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_bootstrap_robust_optimization"])
        self.assertTrue(specs[0].hard_vetoes["required_bootstrap_confidence_interval"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_bootstrap_replicates"], "500"
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_utility_percentile_optimization"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_point_estimate_only_optimization"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        bootstrap_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "bootstrap_robust_optimization_stability"
        )
        self.assertEqual(
            bootstrap_contract["rank_metric"],
            "bootstrap_percentile_robust_net_pnl_per_day",
        )
        self.assertIn("selection_bias_stress", bootstrap_contract["required_evidence"])

    def test_risk_aware_trading_portfolio_claim_adds_portfolio_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-risk-aware-trading-portfolio-optimization",
            claims=[
                {
                    "claim_id": "ratpo-risk-pnl-optimizer",
                    "claim_type": "portfolio_construction",
                    "claim_text": (
                        "Risk-aware trading portfolio optimization uses a RATS "
                        "algorithm over unique eligible instruments and an eligible "
                        "optimization strategy to improve market risk and PnL."
                    ),
                    "data_requirements": [
                        "risk_aware_trading_portfolio_optimization",
                        "market_risk_var",
                        "pnl_objective",
                        "eligible_instrument_universe",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "ratpo-risk-limit-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Risk-aware trading swarm outputs require market sensitivity "
                        "constraints, capital charge stress, and risk limit compliance."
                    ),
                    "data_requirements": [
                        "market_sensitivity_constraints",
                        "capital_charge_stress",
                        "risk_limit_compliance",
                        "portfolio_replay",
                    ],
                    "confidence": "0.75",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "risk_aware_trading_portfolio_optimization",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].hard_vetoes["required_risk_aware_portfolio_optimization"]
        )
        self.assertTrue(specs[0].hard_vetoes["required_market_risk_var"])
        self.assertTrue(specs[0].hard_vetoes["required_market_sensitivity_constraints"])
        self.assertTrue(specs[0].hard_vetoes["required_capital_charge_stress"])
        self.assertTrue(specs[0].hard_vetoes["required_risk_limit_compliance"])
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_risk_only_objective_without_post_cost_pnl"
            ]
        )
        self.assertTrue(specs[0].promotion_contract["rejects_optimizer_only_promotion"])
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        ratpo_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "risk_aware_trading_portfolio_optimization"
        )
        self.assertEqual(
            ratpo_contract["rank_metric"],
            "risk_adjusted_post_cost_net_pnl_per_day",
        )
        self.assertEqual(
            ratpo_contract["evidence_policy"],
            "risk_aware_portfolio_optimizer_is_prefilter_not_promotion_proof",
        )
        self.assertIn(
            "market_sensitivity_constraints", ratpo_contract["required_evidence"]
        )

    def test_double_selection_factor_claim_adds_validation_only_contract(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-double-selection-factor-screen",
            claims=[
                {
                    "claim_id": "short-term-trading-factor-screen",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Double-selection LASSO identifies short-term trading "
                        "factors after high-dimensional controls."
                    ),
                    "data_requirements": [
                        "short_term_trading_factors",
                        "cross_sectional_ranks",
                        "realized_volatility",
                    ],
                    "confidence": "0.70",
                },
                {
                    "claim_id": "alpha191-us-incremental-explanatory-power",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "High-dimensional factor screens require train holdout split "
                        "and multiple-testing controls before executable sleeves."
                    ),
                    "data_requirements": [
                        "train_holdout_split",
                        "factor_rank_panel",
                        "multiple_testing_controls",
                    ],
                    "confidence": "0.72",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertIn(
            "double_selection_factor_screen",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(specs[0].hard_vetoes["required_double_selection_factor_screen"])
        self.assertTrue(specs[0].hard_vetoes["required_cross_sectional_rank_panel"])
        self.assertTrue(specs[0].hard_vetoes["required_train_holdout_split"])
        self.assertTrue(specs[0].hard_vetoes["required_multiple_testing_controls"])
        self.assertTrue(
            specs[0].promotion_contract["rejects_factor_screen_only_promotion"]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_in_sample_factor_selection"]
        )
        mechanism_overlays = candidate_specs_module._mechanism_overlays_for_card(
            cards[0]
        )
        factor_contract = next(
            contract
            for contract in mechanism_overlays["feature_contract"]["mechanism_overlays"]
            if contract["overlay_id"] == "double_selection_factor_screen"
        )
        self.assertEqual(
            factor_contract["rank_metric"],
            "double_selection_factor_post_cost_net_pnl_per_day",
        )
        self.assertEqual(
            factor_contract["evidence_policy"],
            "double_selection_factor_screen_is_prefilter_not_promotion_proof",
        )

    def test_validation_only_lob_stress_does_not_portfolio_fanout(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-tlob-validation-only",
            claims=[
                {
                    "claim_id": "tlob-alpha-decay-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "TLOB dual attention limit order book forecasting shows "
                        "predictability decay under tight spreads and high-volume "
                        "algorithmic activity."
                    ),
                    "data_requirements": [
                        "horizon_decay_curve",
                        "spread_adjusted_labels",
                        "tight_spread_regime_slices",
                        "high_volume_regime_slices",
                        "route_tca",
                    ],
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        family_ids = {spec.family_template_id for spec in specs}
        family_reasons = {
            reason
            for spec in specs
            for reason in spec.feature_contract["family_selection"]["reasons"]
        }

        self.assertIn("intraday_tsmom_v2", family_ids)
        self.assertIn("microbar_cross_sectional_pairs_v1", family_ids)
        self.assertLessEqual(
            len(family_ids),
            candidate_specs_module._MAX_FAMILIES_PER_HYPOTHESIS,
        )
        self.assertNotIn("portfolio_sleeve_diversification", family_reasons)
        self.assertTrue(
            all(
                "alpha_decay_predictability_stress"
                in spec.parameter_space["mechanism_overlay_ids"]
                for spec in specs
            )
        )

    def test_ohlcv_only_claim_adds_falsification_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-ohlcv-falsification",
            claims=[
                {
                    "claim_id": "ohlcv-alpha",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "OHLCV-derived intraday momentum can look attractive in "
                        "naive backtests."
                    ),
                    "confidence": "0.75",
                },
                {
                    "claim_id": "ohlcv-only-falsification",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "OHLCV-only signals require systematic falsification with "
                        "executable quote, route/TCA, and walk-forward replay evidence."
                    ),
                    "data_requirements": [
                        "executable_quote_evidence",
                        "route_tca",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.80",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "ohlcv_only_falsification",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_ohlcv_only_promotion_evidence"]
        )
        self.assertTrue(specs[0].promotion_contract["requires_walk_forward_replay"])
        self.assertEqual(
            specs[0].hard_vetoes["required_min_ohlcv_falsification_trade_count"],
            "120",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_ohlcv_stable_split_pass_rate"],
            "0.60",
        )
        self.assertTrue(specs[0].hard_vetoes["required_executable_quote_evidence"])
        self.assertTrue(specs[0].promotion_contract["requires_minimum_trade_count"])
        self.assertTrue(
            specs[0].promotion_contract["rejects_naive_gross_ohlcv_backtests"]
        )

    def test_rejected_signal_claim_adds_counterfactual_outcome_contract(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-red-2400",
            claims=[
                {
                    "claim_id": "rejection-event-outcome-labels",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Algorithmically rejected trading events with outcome labels "
                        "turn rejected signal logs into counterfactual examples for "
                        "veto calibration."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "outcome_labels",
                        "executable_quote",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "counterfactual-reject-outcome-learning",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Rejected events require counterfactual return, route/TCA, "
                        "and post-cost net PnL labels before relaxing vetoes."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        self.assertIn(
            "rejected_signal_outcome_calibration",
            specs[0].parameter_space["mechanism_overlay_ids"],
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_rejected_signal_outcome_label_count"],
            "120",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_min_rejected_signal_reason_coverage"],
            "0.80",
        )
        self.assertEqual(
            specs[0].hard_vetoes["required_rejected_signal_outcome_persistence_state"],
            "ok",
        )
        self.assertTrue(
            specs[0].promotion_contract["requires_rejected_signal_outcome_learning"]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "requires_rejected_signal_counterfactual_replay"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract[
                "rejects_pending_rejected_signal_outcome_labels"
            ]
        )
        self.assertTrue(
            specs[0].promotion_contract["rejects_unlabeled_reject_relaxation"]
        )

    def test_rejected_signal_claim_adds_false_negative_rescue_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-red-2400",
            claims=[
                {
                    "claim_id": "rejection-event-outcome-labels",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Algorithmically rejected trading events with outcome labels "
                        "turn skipped signal logs into counterfactual false-negative "
                        "rescue examples for veto calibration."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "outcome_labels",
                        "executable_quote",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "counterfactual-reject-outcome-learning",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Rejected events require counterfactual return, route/TCA, "
                        "and post-cost net PnL labels before relaxing vetoes."
                    ),
                    "data_requirements": [
                        "rejected_signal_log",
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.76",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        family_ids = {spec.family_template_id for spec in specs}
        rescue_specs = [
            spec
            for spec in specs
            if spec.strategy_overrides.get("params", {}).get("veto_relaxation_scope")
            == "labeled_false_negative_only"
        ]

        self.assertEqual(
            family_ids,
            {
                "microstructure_continuation_matched_filter_v1",
                "microbar_cross_sectional_pairs_v1",
                "opening_drive_leader_reclaim_v1",
            },
        )
        self.assertTrue(rescue_specs)
        self.assertTrue(
            all(
                spec.strategy_overrides["params"]["outcome_label_filter"]
                == "profitable_after_costs"
                for spec in rescue_specs
            )
        )
        self.assertTrue(
            all(
                Decimal(str(spec.strategy_overrides["max_notional_per_trade"]))
                <= Decimal("30000")
                for spec in rescue_specs
            )
        )

    def test_morning_momentum_claim_selects_opening_drive_family(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-morning-momentum",
            claims=[
                {
                    "claim_id": "claim-first-half-hour",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "First half-hour return and opening drive leader reclaim "
                        "predict intraday momentum when information is discrete."
                    ),
                    "confidence": "0.83",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        opening_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "opening_drive_leader_reclaim_v1"
        ]
        self.assertTrue(opening_specs)
        self.assertEqual(
            opening_specs[0].runtime_strategy_name,
            "breakout-continuation-long-v1",
        )
        self.assertIn(
            "morning_or_announcement_momentum",
            opening_specs[0].feature_contract["family_selection"]["reasons"],
        )

    def test_orb_claim_selects_opening_drive_and_breakout_families(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-orb-stocks-in-play",
            claims=[
                {
                    "claim_id": "claim-orb",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Stocks in Play with unusually high daily volume can produce "
                        "opening range breakout continuation after the first five minutes."
                    ),
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        families = {spec.family_template_id for spec in specs}

        self.assertIn("opening_drive_leader_reclaim_v1", families)
        self.assertIn("breakout_reclaim_v2", families)

    def test_literal_eod_reversal_claim_selects_end_of_day_family(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-eod-reversal",
            claims=[
                {
                    "claim_id": "claim-eod",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "End-of-day reversal in individual intraday losers appears "
                        "during the final 30 minutes as closing pressure unwinds."
                    ),
                    "confidence": "0.80",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        eod_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        ]

        self.assertTrue(eod_specs)
        self.assertIn(
            "closing_window_reversal",
            eod_specs[0].feature_contract["family_selection"]["reasons"],
        )

    def test_hmm_ofi_claim_selects_microstructure_family(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-ofi-hmm",
            claims=[
                {
                    "claim_id": "claim-ofi-hmm",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "A hidden Markov model over order flow imbalance identifies "
                        "latent regime persistence and liquidity dislocation states."
                    ),
                    "confidence": "0.78",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        microstructure_specs = [
            spec
            for spec in specs
            if spec.family_template_id
            == "microstructure_continuation_matched_filter_v1"
        ]

        self.assertTrue(microstructure_specs)
        self.assertIn(
            "volatility_or_regime_state",
            microstructure_specs[0].feature_contract["family_selection"]["reasons"],
        )

    def test_entropy_state_claim_routes_to_microstructure_regime_families(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-order-flow-entropy",
            claims=[
                {
                    "claim_id": "claim-entropy",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Real-time order-flow entropy predicts absolute intraday move size as "
                        "a volatility state, but not directional alpha."
                    ),
                    "data_requirements": [
                        "order_flow_entropy",
                        "trade_sign_markov_state",
                        "realized_volatility",
                    ],
                    "confidence": "0.75",
                },
                {
                    "claim_id": "claim-entropy-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Entropy states require walk-forward validation and should be used "
                        "for sizing context unless separate direction clears placebo tests."
                    ),
                    "confidence": "0.75",
                },
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        family_reasons = {
            spec.family_template_id: spec.feature_contract["family_selection"][
                "reasons"
            ]
            for spec in specs
        }
        self.assertIn("microstructure_continuation_matched_filter_v1", family_reasons)
        self.assertIn("intraday_tsmom_v2", family_reasons)
        self.assertIn(
            "volatility_or_regime_state",
            family_reasons["microstructure_continuation_matched_filter_v1"],
        )

    def test_constrained_factor_claim_routes_to_executable_factor_families(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-constrained-factor-dsl",
            claims=[
                {
                    "claim_id": "claim-factor-dsl",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Constrained LLM hypothesis search emits point-in-time factor DSL "
                        "programs with fixed splits, transaction costs, and portfolio tests."
                    ),
                    "data_requirements": [
                        "factor_dsl",
                        "append_only_experiment_trace",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.77",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        factor_specs = [
            spec
            for spec in specs
            if spec.family_template_id
            in {
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            }
        ]
        self.assertTrue(factor_specs)
        self.assertTrue(
            all(
                "constrained_factor_search"
                in spec.feature_contract["family_selection"]["reasons"]
                for spec in factor_specs
            )
        )

    def test_unpinned_hypotheses_expand_all_family_execution_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-profile-breadth",
            claims=[
                {
                    "claim_id": "claim-flow-breadth",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday LOB continuation signals.",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        continuation_profiles = sorted(
            (
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in specs
                if spec.family_template_id
                == "microstructure_continuation_matched_filter_v1"
            ),
            key=lambda profile_id: int(str(profile_id).rsplit("-", 1)[1]),
        )
        expected_continuation_profiles = [
            f"microstructure_continuation_matched_filter_v1:profile-{index + 1}"
            for index in range(
                len(
                    candidate_specs_module._execution_profiles_for_target(
                        family_template_id="microstructure_continuation_matched_filter_v1",
                        target_net_pnl_per_day=Decimal("500"),
                    )
                )
            )
        ]
        self.assertEqual(
            continuation_profiles,
            expected_continuation_profiles,
        )
        self.assertEqual(
            len({spec.candidate_spec_id for spec in specs}),
            len(specs),
        )

    def test_portfolio_profit_target_adds_diversified_sleeve_families(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-portfolio-sleeves",
            claims=[
                {
                    "claim_id": "claim-flow-sleeves",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday LOB continuation signals.",
                    "confidence": "0.82",
                }
            ],
        )

        baseline_specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )
        portfolio_specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        self.assertEqual(
            {spec.family_template_id for spec in baseline_specs},
            {
                "intraday_tsmom_v2",
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            },
        )
        self.assertEqual(
            {spec.family_template_id for spec in portfolio_specs},
            set(candidate_specs_module._FAMILY_EXECUTION_PROFILES),
        )
        self.assertEqual(
            len(portfolio_specs),
            sum(
                len(
                    candidate_specs_module._execution_profiles_for_target(
                        family_template_id=family_template_id,
                        target_net_pnl_per_day=Decimal("500"),
                    )
                )
                for family_template_id in candidate_specs_module._FAMILY_EXECUTION_PROFILES
            ),
        )
        self.assertGreater(len(portfolio_specs), 36)
        self.assertTrue(
            all(
                spec.strategy_overrides["params"]["position_isolation_mode"]
                == "per_strategy"
                for spec in portfolio_specs
            )
        )
        self.assertGreater(len(portfolio_specs), len(baseline_specs))
        complementary_spec = next(
            spec
            for spec in portfolio_specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        )
        self.assertEqual(
            complementary_spec.feature_contract["family_selection"]["reasons"],
            ["portfolio_sleeve_diversification"],
        )

    def test_portfolio_profit_target_profiles_include_oracle_coverage_sleeves(
        self,
    ) -> None:
        coverage_profiles = (
            candidate_specs_module._PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES
        )

        self.assertEqual(
            set(coverage_profiles), set(candidate_specs_module._FAMILY_RUNTIME)
        )
        coverage_symbols = set(
            candidate_specs_module._PORTFOLIO_COVERAGE_UNIVERSE_PROFILE
        )
        for family_template_id, profiles in coverage_profiles.items():
            self.assertGreaterEqual(len(profiles), 3, family_template_id)
            self.assertTrue(
                any(
                    list(profile["universe_symbols"])
                    == list(candidate_specs_module._PORTFOLIO_COVERAGE_UNIVERSE_PROFILE)
                    for profile in profiles
                ),
                family_template_id,
            )
            self.assertTrue(
                any(
                    list(profile["universe_symbols"])
                    == list(
                        candidate_specs_module._PORTFOLIO_AI_ACCELERATOR_COVERAGE_UNIVERSE_PROFILE
                    )
                    for profile in profiles
                ),
                family_template_id,
            )
            self.assertTrue(
                any(
                    list(profile["universe_symbols"])
                    == list(
                        candidate_specs_module._PORTFOLIO_PLATFORM_COVERAGE_UNIVERSE_PROFILE
                    )
                    for profile in profiles
                ),
                family_template_id,
            )
            for profile in profiles:
                symbols = [
                    str(symbol).strip().upper()
                    for symbol in profile["universe_symbols"]
                ]
                self.assertEqual(
                    len(symbols),
                    len(set(symbols)),
                    f"{family_template_id} portfolio coverage profile has duplicate symbols",
                )
                self.assertEqual(
                    sorted(set(symbols) - coverage_symbols),
                    [],
                    f"{family_template_id} portfolio coverage profile uses unresearched symbols",
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_position_pct_equity"])),
                    Decimal("4.0"),
                    family_template_id,
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_notional_per_trade"])),
                    Decimal("126360"),
                    family_template_id,
                )

    def test_portfolio_profit_target_includes_prev_close_reversal_surface(
        self,
    ) -> None:
        coverage_profiles = (
            candidate_specs_module._PORTFOLIO_ORACLE_COVERAGE_EXECUTION_PROFILES
        )

        microbar_motifs = {
            str(profile["params"].get("signal_motif"))
            for profile in coverage_profiles["microbar_cross_sectional_pairs_v1"]
        }
        self.assertIn("overnight_gap_reversal", microbar_motifs)
        self.assertIn("opening_window_prev_close_reversal", microbar_motifs)
        self.assertIn("intraday_tug_of_war_reversal", microbar_motifs)

        prev_close_microbar = [
            profile
            for profile in coverage_profiles["microbar_cross_sectional_pairs_v1"]
            if str(profile["params"].get("rank_feature"))
            in {
                "cross_section_prev_session_close_rank",
                "cross_section_opening_window_return_from_prev_close_rank",
            }
        ]
        self.assertGreaterEqual(len(prev_close_microbar), 3)
        for profile in prev_close_microbar:
            params = profile["params"]
            self.assertEqual(params["selection_mode"], "reversal")
            self.assertIn("entry_window_minutes", params)
            self.assertEqual(
                params["gate_feature"],
                "cross_section_positive_opening_window_return_from_prev_close_ratio",
            )
            self.assertLessEqual(
                Decimal(str(profile["max_notional_per_trade"])), Decimal("63180")
            )
            self.assertLessEqual(
                Decimal(str(profile["max_position_pct_equity"])), Decimal("2.0")
            )
            self.assertLessEqual(
                Decimal(str(params["max_session_negative_exit_bps"])), Decimal("3")
            )

        for family_template_id in (
            "mean_reversion_rebound_v1",
            "end_of_day_reversal_v1",
        ):
            prev_close_profiles = [
                profile
                for profile in coverage_profiles[family_template_id]
                if profile["params"].get("drive_reference_basis") == "prev_close"
            ]
            self.assertGreaterEqual(len(prev_close_profiles), 3, family_template_id)
            for profile in prev_close_profiles:
                params = profile["params"]
                self.assertEqual(params["opening_window_reference_basis"], "prev_close")
                self.assertEqual(
                    params["opening_window_rank_reference_basis"], "prev_close"
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_notional_per_trade"])), Decimal("63180")
                )
                self.assertLessEqual(
                    Decimal(str(profile["max_position_pct_equity"])), Decimal("2.0")
                )
                self.assertLessEqual(
                    Decimal(str(params["max_session_negative_exit_bps"])),
                    Decimal("3"),
                )

    def test_microbar_pairs_profiles_include_residual_statarb_surfaces(self) -> None:
        profiles = candidate_specs_module._FAMILY_EXECUTION_PROFILES[
            "microbar_cross_sectional_pairs_v1"
        ]
        rank_features = {
            str(profile["params"].get("rank_feature")) for profile in profiles
        }
        signal_motifs = {
            str(profile["params"].get("signal_motif")) for profile in profiles
        }

        self.assertIn("cross_section_factor_neutral_residual_rank", rank_features)
        self.assertIn("cross_section_residual_spread_zscore_rank", rank_features)
        self.assertIn("factor_neutral_residual_continuation", signal_motifs)
        self.assertIn("residual_spread_reversion", signal_motifs)

    def test_portfolio_profit_target_adds_capital_constrained_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-capital-realistic",
            claims=[
                {
                    "claim_id": "claim-flow-capital",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        for family_template_id in candidate_specs_module._FAMILY_RUNTIME:
            capital_specs = [
                spec
                for spec in specs
                if spec.family_template_id == family_template_id
                and _capital_profile(spec) == "initial_equity_cash_constrained_1x"
            ]
            self.assertTrue(capital_specs, family_template_id)
            for spec in capital_specs:
                self.assertNotIn("capital_profile", spec.strategy_overrides)
                params = spec.strategy_overrides["params"]
                self.assertIsInstance(params, dict)
                self.assertEqual(
                    params["capital_profile"],
                    "initial_equity_cash_constrained_1x",
                )
                StrategyCatalogConfig.model_validate(
                    {
                        "strategies": [
                            {
                                "name": spec.candidate_spec_id,
                                "strategy_id": spec.candidate_spec_id,
                                "params": params,
                                "universe_symbols": spec.strategy_overrides.get(
                                    "universe_symbols", []
                                ),
                                "max_position_pct_equity": spec.strategy_overrides.get(
                                    "max_position_pct_equity"
                                ),
                                "max_notional_per_trade": spec.strategy_overrides.get(
                                    "max_notional_per_trade"
                                ),
                            }
                        ]
                    }
                )
                features = candidate_spec_capital_features(spec)
                self.assertEqual(features["capital_feasible_flag"], 1.0)
                self.assertLessEqual(
                    Decimal(str(features["estimated_max_gross_exposure_pct_equity"])),
                    Decimal("1.0"),
                    spec.candidate_spec_id,
                )
                self.assertEqual(
                    spec.strategy_overrides["params"]["max_gross_exposure_pct_equity"],
                    "1.0",
                )

    def test_portfolio_profit_target_adds_feedback_escape_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-feedback-escape",
            claims=[
                {
                    "claim_id": "claim-feedback-escape",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                    "confidence": "0.82",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        expected_profiles = {
            "daily_coverage_feedback_escape",
            "consistency_guard_feedback_escape",
            "turnover_coverage_feedback_escape",
        }
        for family_template_id in candidate_specs_module._FAMILY_RUNTIME:
            family_specs = [
                spec for spec in specs if spec.family_template_id == family_template_id
            ]
            remediation_profiles = {
                str(
                    spec.strategy_overrides["params"].get(
                        "feedback_remediation_profile"
                    )
                )
                for spec in family_specs
                if isinstance(spec.strategy_overrides.get("params"), dict)
                and spec.strategy_overrides["params"].get(
                    "feedback_remediation_profile"
                )
            }
            self.assertGreaterEqual(
                remediation_profiles,
                expected_profiles,
                family_template_id,
            )
            for spec in family_specs:
                params = spec.strategy_overrides.get("params")
                if not isinstance(params, dict) or not params.get(
                    "feedback_remediation_profile"
                ):
                    continue
                self.assertEqual(params["max_gross_exposure_pct_equity"], "1.0")
                self.assertTrue(str(params["capital_profile"]).startswith("feedback_"))
                self.assertEqual(
                    candidate_spec_capital_features(spec)["capital_feasible_flag"], 1.0
                )

    def test_portfolio_profit_target_adds_h_pairs_replay_ledger_breadth_profiles(
        self,
    ) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-hpairs-ledger-breadth",
            claims=[
                {
                    "claim_id": "claim-hpairs-breadth",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Cross-sectional pair ranking over intraday order-flow and "
                        "opening-window signals can improve H-PAIRS notional throughput."
                    ),
                    "confidence": "0.86",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        replay_guided_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "microbar_cross_sectional_pairs_v1"
            and spec.parameter_space.get("replay_ledger_guided_candidate_expansion")
            and not spec.strategy_overrides["params"].get(
                "feedback_remediation_profile"
            )
        ]
        self.assertGreaterEqual(len(replay_guided_specs), 2)
        for spec in replay_guided_specs:
            params = spec.strategy_overrides["params"]
            self.assertGreaterEqual(int(params["top_n"]), 4)
            self.assertGreaterEqual(int(params["max_pair_legs"]), 5)
            self.assertGreaterEqual(int(params["max_entries_per_session"]), 6)
            self.assertEqual(
                params["replay_ledger_guidance_scope"],
                "bounded_exact_replay_prefilter",
            )
            self.assertEqual(
                spec.promotion_contract["promotion_policy"], "research_only"
            )
            self.assertTrue(
                spec.promotion_contract["requires_runtime_ledger_profit_proof"]
            )
            self.assertTrue(
                spec.promotion_contract[
                    "replay_ledger_guided_search_is_not_promotion_proof"
                ]
            )

    def test_feedback_escape_profiles_dedupe_and_fallback_invalid_params(self) -> None:
        profile = {
            "params": {
                "entry_minute_after_open": "not-a-decimal",
                "exit_minute_after_open": "invalid",
                "top_n": "2",
                "max_pair_legs": "2",
                "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                "gate_min": "0.20",
                "gate_max": "0.80",
            },
            "universe_symbols": ["NVDA", "AAPL"],
            "max_notional_per_trade": "90000",
            "max_position_pct_equity": "2.0",
        }

        expanded = candidate_specs_module._portfolio_feedback_escape_execution_profiles(
            (profile, profile)
        )

        self.assertEqual(
            [
                next_profile["params"]["feedback_remediation_profile"]
                for next_profile in expanded
            ],
            [
                "daily_coverage_feedback_escape",
                "consistency_guard_feedback_escape",
                "turnover_coverage_feedback_escape",
                "notional_throughput_feedback_escape",
                "adverse_selection_feedback_escape",
                "symbol_diversification_feedback_escape",
            ],
        )
        for next_profile in expanded:
            self.assertNotIn("gate_feature", next_profile["params"])
            self.assertNotIn("gate_min", next_profile["params"])
            self.assertNotIn("gate_max", next_profile["params"])
        notional = expanded[3]
        self.assertGreaterEqual(
            int(notional["params"]["max_entries_per_session"]),
            10,
        )
        self.assertGreaterEqual(int(notional["params"]["top_n"]), 4)
        self.assertGreaterEqual(int(notional["params"]["max_pair_legs"]), 4)
        self.assertEqual(notional["params"]["entry_notional_max_multiplier"], "1.0")
        adverse_selection = expanded[4]
        self.assertEqual(
            adverse_selection["params"]["feedback_remediation_profile"],
            "adverse_selection_feedback_escape",
        )
        self.assertEqual(
            adverse_selection["params"]["max_stop_loss_exits_per_session"],
            "1",
        )
        diversified = expanded[-1]
        self.assertEqual(diversified["params"]["top_n"], "3")
        self.assertGreaterEqual(
            int(diversified["params"]["max_concurrent_positions"]), 3
        )
        self.assertEqual(
            diversified["params"]["symbol_concentration_feedback_guard"],
            "max_single_symbol_contribution",
        )
        self.assertGreater(
            len(diversified["universe_symbols"]), len(profile["universe_symbols"])
        )
        self.assertEqual(
            sorted(set(diversified["universe_symbols"]) - _CHIP_UNIVERSE_SYMBOLS),
            [],
        )
        self.assertEqual(
            candidate_specs_module._decimal_profile_param(
                profile["params"],
                "entry_minute_after_open",
                default=Decimal("45"),
            ),
            Decimal("45"),
        )
        self.assertEqual(
            candidate_specs_module._int_profile_param(
                profile["params"],
                "exit_minute_after_open",
                default=150,
            ),
            150,
        )

    def test_short_exhaustion_claim_compiles_short_sleeve_profiles(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-short-exhaustion",
            claims=[
                {
                    "claim_id": "claim-short-fade",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Short-side upside exhaustion fade with offer pressure can "
                        "profit from overbought intraday weakness."
                    ),
                    "confidence": "0.81",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )
        short_specs = [
            spec
            for spec in specs
            if spec.family_template_id == "mean_reversion_exhaustion_short_v1"
        ]

        self.assertEqual(len(short_specs), 3)
        self.assertTrue(
            all(
                spec.runtime_family == "mean_reversion_exhaustion_short_consistent"
                for spec in short_specs
            )
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "mean-reversion-exhaustion-short-v1"
                for spec in short_specs
            )
        )
        self.assertEqual(
            {
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in short_specs
            },
            {
                "mean_reversion_exhaustion_short_v1:profile-1",
                "mean_reversion_exhaustion_short_v1:profile-2",
                "mean_reversion_exhaustion_short_v1:profile-3",
            },
        )
        self.assertTrue(
            all(
                "short_stop_loss_bps" in spec.strategy_overrides["params"]
                for spec in short_specs
            )
        )

    def test_same_family_whitepaper_hypotheses_get_distinct_execution_profiles(
        self,
    ) -> None:
        cards = [
            HypothesisCard(
                schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
                hypothesis_id=f"hyp-profile-{index}",
                source_run_id="paper-profile",
                source_claim_ids=(f"claim-profile-{index}",),
                mechanism="Clustered order flow imbalance improves intraday LOB continuation signals.",
                asset_scope="us_equities_intraday",
                horizon_scope="intraday",
                expected_direction="positive",
                required_features=("order_flow_imbalance", "spread_bps"),
                entry_motifs=("microbar_rank",),
                exit_motifs=("time_exit",),
                risk_controls=("quote_quality",),
                expected_regimes=("liquid_regular_session",),
                failure_modes=("cost_stress",),
                implementation_constraints={"execution_profile_index": index},
                confidence=Decimal("0.8"),
            )
            for index in range(2)
        ]

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("300")
        )

        continuation_specs = [
            spec
            for spec in specs
            if spec.family_template_id
            == "microstructure_continuation_matched_filter_v1"
        ]
        self.assertEqual(len(continuation_specs), 2)
        self.assertNotEqual(
            continuation_specs[0].strategy_overrides,
            continuation_specs[1].strategy_overrides,
        )
        self.assertEqual(
            continuation_specs[0].feature_contract["execution_profile"]["profile_id"],
            "microstructure_continuation_matched_filter_v1:profile-1",
        )
        self.assertEqual(
            continuation_specs[1].to_vnext_experiment_payload()["template_overrides"][
                "params"
            ]["leader_reclaim_start_minutes_since_open"],
            "45",
        )

    def test_explicit_universe_symbols_override_profile_universes(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-chip-universe",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                    "data_requirements": ["order_flow_imbalance", "spread_bps"],
                    "confidence": "0.8",
                }
            ],
        )

        specs = compile_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("300"),
            universe_symbols=("nvda", " AMD ", "NVDA", "arm", "mu", "aapl"),
        )

        self.assertTrue(specs)
        for spec in specs:
            self.assertEqual(
                spec.strategy_overrides["universe_symbols"],
                ["NVDA", "AMD", "AAPL"],
            )
            self.assertEqual(
                spec.to_vnext_experiment_payload()["template_overrides"][
                    "universe_symbols"
                ],
                ["NVDA", "AMD", "AAPL"],
            )

    def test_microbar_whitepaper_profiles_include_runtime_risk_controls(self) -> None:
        card = HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id="hyp-microbar-risk-controls",
            source_run_id="paper-microbar-risk",
            source_claim_ids=("claim-microbar-risk",),
            mechanism="Order-flow LOB imbalance continuation with execution shortfall controls.",
            asset_scope="us_equities_intraday",
            horizon_scope="intraday",
            expected_direction="positive",
            required_features=("order_flow_imbalance", "spread_bps"),
            entry_motifs=("microbar_rank",),
            exit_motifs=("time_exit",),
            risk_controls=("quote_quality", "stop_loss", "max_drawdown"),
            expected_regimes=("liquid_regular_session",),
            failure_modes=("cost_stress",),
            implementation_constraints={"execution_profile_index": 1},
            confidence=Decimal("0.8"),
        )

        specs = compile_candidate_specs(
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("300")
        )
        microbar = next(
            spec
            for spec in specs
            if spec.family_template_id == "microbar_cross_sectional_pairs_v1"
        )

        params = microbar.to_vnext_experiment_payload()["template_overrides"]["params"]
        self.assertEqual(params["long_stop_loss_bps"], "10")
        self.assertEqual(params["long_trailing_stop_activation_profit_bps"], "8")
        self.assertEqual(params["long_trailing_stop_drawdown_bps"], "4")
        self.assertEqual(params["max_session_negative_exit_bps"], "8")
        self.assertEqual(params["max_stop_loss_exits_per_session"], "1")

    def test_late_day_whitepaper_hypothesis_gets_late_day_runtime_profile(self) -> None:
        card = HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id="hyp-late-day-momentum",
            source_run_id="paper-late-day-alpha",
            source_claim_ids=("claim-late-day-alpha",),
            mechanism=(
                "Macro announcement incremental information strengthens late-day intraday "
                "momentum into the close with VWAP exit and microprice confirmation."
            ),
            asset_scope="us_equities_intraday",
            horizon_scope="intraday_momentum",
            expected_direction="positive",
            required_features=(
                "macro_announcement_window",
                "weighted_microprice_momentum",
                "spread_bps",
            ),
            entry_motifs=("late_day_continuation",),
            exit_motifs=("vwap_ladder_exit",),
            risk_controls=("quote_quality", "stop_loss", "close_flatten"),
            expected_regimes=("late_session_information_arrival",),
            failure_modes=("event_overfit", "cost_stress"),
            implementation_constraints={"execution_profile_index": 0},
            confidence=Decimal("0.74"),
        )

        specs = compile_candidate_specs(
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("300")
        )
        late_day = next(
            spec
            for spec in specs
            if spec.family_template_id == "late_day_continuation_v1"
        )

        self.assertEqual(late_day.runtime_family, "late_day_continuation_consistent")
        self.assertEqual(
            late_day.runtime_strategy_name, "late-day-continuation-long-v1"
        )
        self.assertEqual(late_day.objective["target_net_pnl_per_day"], "300")
        self.assertEqual(
            late_day.feature_contract["execution_profile"]["profile_id"],
            "late_day_continuation_v1:profile-1",
        )
        self.assertIn(
            "macro_announcement_dvar_momentum",
            late_day.parameter_space["mechanism_overlay_ids"],
        )
        self.assertTrue(late_day.hard_vetoes["required_event_non_event_holdout_replay"])
        self.assertTrue(
            late_day.promotion_contract["rejects_pooled_macro_and_non_macro_replay"]
        )
        params = late_day.strategy_overrides["params"]
        self.assertEqual(params["entry_start_minute_utc"], "1080")
        self.assertEqual(params["entry_end_minute_utc"], "1170")
        self.assertIn("min_cross_section_continuation_breadth", params)

    def test_final_half_hour_reversal_hypothesis_gets_eod_runtime_profile(self) -> None:
        card = HypothesisCard(
            schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
            hypothesis_id="hyp-eod-loser-reversal",
            source_run_id="paper-eod-loser-reversal",
            source_claim_ids=("claim-eod-loser-reversal",),
            mechanism=(
                "Individual-stock losers can reverse sharply in the final 30 minutes "
                "during a closing-window rebound."
            ),
            asset_scope="us_equities_intraday",
            horizon_scope="late_day_reversal",
            expected_direction="positive",
            required_features=(
                "closing_window",
                "intraday_return_rank",
                "quote_quality",
            ),
            entry_motifs=("end_of_day_reversal",),
            exit_motifs=("close_flatten",),
            risk_controls=("quote_quality", "stop_loss"),
            expected_regimes=("late_session_reversal",),
            failure_modes=("cost_stress",),
            implementation_constraints={"execution_profile_index": 0},
            confidence=Decimal("0.77"),
        )

        specs = compile_candidate_specs(
            hypothesis_cards=[card], target_net_pnl_per_day=Decimal("300")
        )
        eod = next(
            spec
            for spec in specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        )

        self.assertEqual(eod.runtime_family, "end_of_day_reversal_consistent")
        self.assertEqual(eod.runtime_strategy_name, "end-of-day-reversal-long-v1")
        self.assertEqual(
            eod.feature_contract["execution_profile"]["profile_id"],
            "end_of_day_reversal_v1:profile-1",
        )
        params = eod.strategy_overrides["params"]
        self.assertEqual(params["entry_start_minute_utc"], "1150")
        self.assertEqual(params["entry_end_minute_utc"], "1188")
        self.assertIn("min_cross_section_reversal_rank", params)

    def test_missing_features_and_invalid_payloads_are_blocked(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2",
            claims=[
                {
                    "claim_id": "claim-new-feature",
                    "claim_type": "signal_mechanism",
                    "claim_text": "A new exotic feature improves short-horizon execution.",
                    "required_features": ["feature_that_does_not_exist"],
                    "confidence": "0.82",
                }
            ],
        )

        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
        )

        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(
            compilation.blockers[0].reason,
            "required_features_missing_from_family_template",
        )
        with self.assertRaisesRegex(ValueError, "candidate_spec_schema_invalid"):
            candidate_spec_from_payload({"schema_version": "invalid"})
